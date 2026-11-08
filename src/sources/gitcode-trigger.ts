/** GitCode API access through `gc`, and the Triggers, reply channel and thread reads of GitCode Issues, PRs and comments. */
import { z } from 'zod'
import { key, type ChannelRef, type OutboundMessage, type Trigger } from '../core/index.ts'
import type { GitcodeAccount } from '../deployment.ts'
import { CliError, validItems, type Commands, type Tally } from '../infra/commands.ts'
import { escapeRegExp, sameName } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink, ContextMessage, ThreadContext } from './kind.ts'

export const SOURCE = 'gitcode'
/**
 * The Source watches several repositories, and GitCode numbers Issues and PRs separately, so a Thread names both:
 * `gitcode:<owner>/<name>:issue:<n>` or `gitcode:<owner>/<name>:pr:<n>`.
 */
export type Kind = 'issues' | 'pulls'
export const threadId = (repository: string, kind: Kind, number: number): string =>
  `${repository.toLowerCase()}:${kind === 'pulls' ? 'pr' : 'issue'}:${number}`
export const threadKey = (repository: string, kind: Kind, number: number): string => `${SOURCE}:${threadId(repository, kind, number)}`
/** The repository, kind and number a Thread ID names. */
export function parseThread(id: string): { repository: string; kind: Kind; number: number } | undefined {
  const match = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+):(pr|issue):(\d+)$/.exec(id)
  return match ? { repository: match[1]!, kind: match[2] === 'pr' ? 'pulls' : 'issues', number: Number(match[3]) } : undefined
}
export const gitcodePage = (repository: string, kind: Kind, number: number): string =>
  `https://gitcode.com/${repository}/${kind === 'pulls' ? 'merge_requests' : 'issues'}/${number}`
/** Hidden in every reply the Source posts, so a retried message is not posted twice and the agent never hears itself. */
const MARKER = '<!-- dsh-superagent:'

/** The account setup resolved for the GitCode Source. */
export function account(commands: Pick<Commands, 'deployment'>): GitcodeAccount {
  const resolved = commands.deployment.gitcode
  if (!resolved) throw new Error('The GitCode Source has no working gc CLI; see its setup problem')
  return resolved
}
/** Every repository the Source watches, the default one first. */
export const watched = (commands: Pick<Commands, 'deployment'>): string[] => {
  const { repository, repositories } = account(commands)
  return repositories?.length ? repositories : [repository]
}
/**
 * The watched repository `name` names, in GitCode's spelling; the default repository for an empty name.
 * @throws for a repository the Source does not watch.
 */
export function repositoryOf(commands: Pick<Commands, 'deployment'>, name?: string): string {
  if (!name) return account(commands).repository
  const found = watched(commands).find(repository => sameName(repository, name))
  if (!found) throw new Error(`The GitCode Source does not watch ${name}`)
  return found
}
/** Runs the agent's `gc` non-interactively. */
export const gcRun = (commands: Commands, ...args: string[]): Promise<string> => commands.run(account(commands).cli, ['--no-interactive', ...args])
/**
 * Calls the GitCode API on a path within a watched repository, the default one unless named; a path starting `v8/` uses
 * API v8 (Actions).
 * @throws CliError with GitCode's HTTP status as `code`.
 */
export async function api<T>(commands: Commands, schema: z.ZodType<T>, path: string, name?: string): Promise<T> {
  if (/^\/|^[a-z]+:|(^|\/)\.\.?(\/|\?|$)/i.test(path)) throw new Error('GitCode calls are restricted to the watched repositories')
  const repository = repositoryOf(commands, name)
  const v8 = path.startsWith('v8/')
  const endpoint = v8 ? `/api/v8/repos/${repository}/${path.slice(3)}` : `repos/${repository}${path ? `/${path}` : ''}`
  return schema.parse(JSON.parse(await gcRun(commands, 'api', endpoint)))
}
/** Every page of a list (GitCode caps a page at 100), skipping items that fail `item`. */
export async function pages<T>(commands: Commands, item: z.ZodType<T>, path: string, tally?: Tally, repository?: string): Promise<T[]> {
  const all: T[] = []
  const join = path.includes('?') ? '&' : '?'
  for (let page = 1; ; page++) {
    const listed = await api(commands, z.array(z.unknown()), `${path}${join}per_page=100&page=${page}`, repository)
    all.push(...validItems(item, listed, tally))
    if (listed.length < 100) return all
  }
}

// GitCode leaves `type` empty, and returns Issue numbers as strings and PR numbers as numbers.
export const UserSchema = z.looseObject({ login: z.string() }).nullish().transform(user => user ?? { login: 'ghost' })
export const ItemSchema = z.looseObject({ number: z.coerce.number(), title: z.string().nullish(), body: z.string().nullish(),
  state: z.string().nullish(), html_url: z.string(), user: UserSchema, created_at: z.string(), updated_at: z.string() })
/** A conversation comment, or on a PR a code comment (`diff_comment`) in a review discussion. */
export const CommentSchema = z.looseObject({ id: z.coerce.number(), body: z.string().nullish(), user: UserSchema,
  created_at: z.string(), updated_at: z.string().nullish(), comment_type: z.string().nullish(), discussion_id: z.string().nullish(),
  path: z.string().nullish(), diff_position: z.looseObject({ start_new_line: z.number().nullish(), end_new_line: z.number().nullish() }).nullish() })
export type GitcodeItem = z.infer<typeof ItemSchema>
export type GitcodeComment = z.infer<typeof CommentSchema>
const inline = (comment: GitcodeComment) => comment.comment_type === 'diff_comment' && !!comment.discussion_id
const place = (comment: GitcodeComment) => {
  const line = comment.diff_position?.end_new_line ?? comment.diff_position?.start_new_line
  return inline(comment) ? `${comment.path ?? 'code'}${line ? `:${line}` : ''}` : ''
}

/** GitCode stores a mention `@me` as the link `[@me](https://gitcode.com/me)`; this restores what the person wrote. */
export const plain = (text: string): string => text.replace(/\[(@[\w.-]+)\]\(https?:\/\/[^)\s]*\)/g, '$1')
/**
 * True when `text` addresses the agent: with a keyword, it starts `@<account> <keyword>` (such as `@me superagent, review
 * this`), which tells it apart from a mention of the person who shares the account; without one, any `@<account>` does.
 */
export function addressed(text: string, login: string, keyword: string): boolean {
  const at = `@${escapeRegExp(login)}`
  return keyword ? new RegExp(`^\\s*${at}[\\s,，:：]+${escapeRegExp(keyword)}(?![\\w-])`, 'i').test(plain(text))
    : new RegExp(`(?:^|[^a-zA-Z0-9_@])${at}(?![a-zA-Z0-9_.-])`, 'i').test(plain(text))
}
/**
 * Whether a post is not received: one of the Source's own replies, or a post of the agent account that does not address the
 * agent. The account may be the operator's own, so only what addresses the agent tells their posts from the agent's.
 */
export const skipped = (author: string, body: string, agent: string, keyword: string): boolean =>
  body.includes(MARKER) || (sameName(author, agent) && !addressed(body, agent, keyword))

const channel = (repository: string, kind: Kind, number: number, url?: string, discussion?: string): ChannelRef =>
  ({ source: SOURCE, thread: threadKey(repository, kind, number),
    address: { repository, kind, number: String(number), ...url ? { url } : {}, ...discussion ? { discussion } : {} } })
const author = (login: string, text: string, agent: string, keyword: string) => ({ actor: { source: SOURCE, id: login }, human: true,
  ...addressed(text, agent, keyword) ? { addressed: 'mention' as const } : {} })

/** Trigger for a newly opened Issue's or PR's title and body. */
export function openedTrigger(repository: string, kind: Kind, item: GitcodeItem, agent: string, keyword: string): Trigger {
  const body = plain(item.body ?? '')
  const isPr = kind === 'pulls'
  return { id: key('gitcode-opened', repository, kind, String(item.number)), source: SOURCE,
    threads: [{ source: SOURCE, id: threadId(repository, kind, item.number) }], ...author(item.user.login, body, agent, keyword), at: item.created_at,
    text: `${item.title ?? ''}\n\n${body}`, channel: channel(repository, kind, item.number, item.html_url), url: item.html_url,
    meta: { repository, number: item.number, isPr, kind: isPr ? 'pull' : 'issue', ...isPr ? { prAuthor: item.user.login } : {} } }
}
/** Trigger for a comment; an edit (a new `updated_at`) is a new Trigger. A code comment replies in its review discussion. */
export function commentTrigger(repository: string, kind: Kind, number: number, comment: GitcodeComment, agent: string, keyword: string): Trigger {
  const url = `${gitcodePage(repository, kind, number)}#comment_${comment.id}`
  const body = plain(comment.body ?? '')
  const discussion = inline(comment) ? comment.discussion_id! : undefined
  return { id: key('gitcode-comment', repository, kind, String(comment.id), comment.updated_at ?? ''), source: SOURCE,
    threads: [{ source: SOURCE, id: threadId(repository, kind, number) }], ...author(comment.user.login, body, agent, keyword),
    at: comment.updated_at ?? comment.created_at, text: [place(comment), body].filter(Boolean).join('\n\n'),
    channel: channel(repository, kind, number, url, discussion), url,
    meta: { repository, number, isPr: kind === 'pulls', kind: discussion ? 'inline' : 'conversation', commentId: comment.id,
      ...discussion ? { discussion } : {} } }
}

/** Posts a reply once per message ID: as a comment, or in the review discussion the address names. A deleted (410) target is gone. */
export async function sendGitcode(host: Pick<SourceContext, 'commands'>, message: Pick<OutboundMessage, 'id' | 'text' | 'channel'>): Promise<'sent' | 'gone'> {
  const { commands } = host
  const { kind, number = '', discussion } = message.channel.address
  if (!number || (kind !== 'issues' && kind !== 'pulls')) throw new Error('Missing GitCode reply target')
  const repository = repositoryOf(commands, message.channel.address.repository)
  const marker = `${MARKER}${message.id} -->`
  try {
    if ((await pages(commands, CommentSchema, `${kind}/${number}/comments`, undefined, repository)).some(comment => (comment.body ?? '').includes(marker))) return 'sent'
    const body = `${message.text}\n\n${marker}`
    if (kind === 'pulls' && discussion) await gcRun(commands, 'pr', 'reply', number, '--discussion', discussion, '-R', repository, '--body', body)
    else await gcRun(commands, kind === 'pulls' ? 'pr' : 'issue', 'comment', number, '-R', repository, '--body', body)
    return 'sent'
  } catch (error) {
    if (error instanceof CliError && error.code === 410) return 'gone'
    throw error
  }
}
export function gitcodeLink(address: Record<string, string>): ChannelLink {
  const kind = address.kind === 'pulls' ? 'pulls' : 'issues'
  const name = `GitCode ${kind === 'pulls' ? '!' : '#'}${address.number ?? ''}`
  return { url: address.url ?? (address.repository ? gitcodePage(address.repository, kind, Number(address.number)) : ''),
    label: address.discussion ? { zh: `${name} 的检视讨论`, en: `Review discussion on ${name}` } : { zh: name, en: name } }
}

const message = (repository: string, kind: Kind, number: number, comment: GitcodeComment): ContextMessage => {
  const url = `${gitcodePage(repository, kind, number)}#comment_${comment.id}`
  const line = comment.diff_position?.end_new_line ?? comment.diff_position?.start_new_line
  return { id: url, from: comment.user.login, at: comment.created_at, text: comment.body ?? '', url,
    ...inline(comment) && comment.path ? { path: comment.path, ...line ? { line } : {} } : {} }
}
const oldestFirst = (a: GitcodeComment, b: GitcodeComment) => Date.parse(a.created_at) - Date.parse(b.created_at)
/**
 * Context reader for a GitCode Trigger: a code comment's review discussion, or the Issue or PR conversation by page of 100
 * comments, whose first page starts with the description.
 */
export const gitcodeThreadContext: ThreadContext<unknown> = {
  messageId: trigger => trigger.url ?? '',
  async read(commands, trigger, part, cursor) {
    const kind: Kind = trigger.meta.isPr === true ? 'pulls' : 'issues'
    const number = Number(trigger.meta.number)
    const repository = repositoryOf(commands, typeof trigger.meta.repository === 'string' ? trigger.meta.repository : undefined)
    if (typeof trigger.meta.discussion === 'string') {
      const thread = (await pages(commands, CommentSchema, `pulls/${number}/comments`, undefined, repository))
        .filter(comment => comment.discussion_id === trigger.meta.discussion).sort(oldestFirst)
        .map(comment => message(repository, kind, number, comment))
      const read = part === 'thread' ? thread : thread.slice(0, 1)
      return { messages: read, body: { status: 'review_thread', messages: read }, status: 'review_thread' }
    }
    const page = Number(cursor ?? '1')
    const messages: ContextMessage[] = []
    if (page === 1) {
      const item = await api(commands, ItemSchema, `${kind}/${number}`, repository)
      messages.push({ id: item.html_url, from: item.user.login, at: item.created_at, text: `${item.title ?? ''}\n\n${item.body ?? ''}`, url: item.html_url })
    }
    const listed = await api(commands, z.array(z.unknown()), `${kind}/${number}/comments?per_page=100&page=${page}`, repository)
    messages.push(...validItems(CommentSchema, listed).sort(oldestFirst).map(comment => message(repository, kind, number, comment)))
    const next = listed.length === 100 ? String(page + 1) : undefined
    return { messages, next, body: { messages, next_resource: next ?? null } }
  },
}
