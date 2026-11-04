/**
 * GitCode source kind and plugin entry: polls one repository's Issues, PRs, comments, the PRs of open tickets with their
 * Actions CI, and optionally the default branch's CI, through the `gc` CLI.
 */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { key, liveTicket, type Ticket, type Trigger } from '../core/index.ts'
import { GitcodeAccountsSchema } from '../deployment.ts'
import { CliError, validItems, type Commands } from '../infra/commands.ts'
import { sameName } from '../infra/text.ts'
import { family, record } from '../kv.ts'
import { ciCounts, ciFact, ciFailures, ciSummary, type CiSnapshot } from './github-read.ts'
import { ticketBranch } from './github-pull.ts'
import { account, api, CommentSchema, commentTrigger, gitcodeLink, gitcodeThreadContext, ItemSchema, openedTrigger,
  pages, sendGitcode, skipped, SOURCE, threadId, threadKey, UserSchema, type Kind } from './gitcode-trigger.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import type { Localized, SourceKind } from './kind.ts'
import { cursorAt, pause } from './poll.ts'

export { addressed, commentTrigger, openedTrigger, sendGitcode, skipped, SOURCE } from './gitcode-trigger.ts'
const KV = {
  since: family<string, [repository: string, kind: Kind]>('gitcode-since:'),
  ci: family<{ fingerprint: string; revision: number }, [number: number]>('gitcode-ci:'),
  branchCi: record<{ branch?: string; failures?: string[]; revision: number }>('gitcode-branch-ci'),
}
const KINDS: Kind[] = ['issues', 'pulls']

const GitcodeConfigSchema = GitcodeAccountsSchema.extend({
  keyword: z.string().trim().regex(/^[\w-]*$/).default('superagent'),
  pollSeconds: z.number().int().min(30).max(3600).default(60),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
  observeIssues: z.boolean().default(false), observePulls: z.boolean().default(false), observeComments: z.boolean().default(false),
  observeCi: z.boolean().default(false),
}).strict()
export type GitcodeConfig = z.infer<typeof GitcodeConfigSchema>
const OBSERVED = { issues: 'observeIssues', pulls: 'observePulls', comments: 'observeComments', ci: 'observeCi' } as const
type Row = keyof typeof OBSERVED
function rowOf(meta: Record<string, unknown>): Row | undefined {
  if (meta.ci === true) return typeof meta.branch === 'string' ? 'ci' : undefined
  if (meta.kind === 'issue') return 'issues'
  if (meta.kind === 'pull') return 'pulls'
  return meta.kind === 'conversation' || meta.kind === 'inline' ? 'comments' : undefined
}

// PR lifecycle: GitCode reports `state` as open, closed or merged.
const PullSchema = z.looseObject({ number: z.coerce.number(), title: z.string().nullish(), state: z.string(), html_url: z.string(),
  user: UserSchema, body: z.string().nullish(), created_at: z.string().optional(), merged_at: z.string().nullish(), closed_at: z.string().nullish(),
  head: z.looseObject({ ref: z.string(), sha: z.string(), repo: z.looseObject({ full_name: z.string() }).nullish() }) })
export type GitcodePull = z.infer<typeof PullSchema>
const readPull = (ctx: SourceContext, number: number, signal?: AbortSignal): Promise<GitcodePull> =>
  api(ctx.commands.withSignal(signal), PullSchema, `pulls/${number}`)
const prOf = (thread: string): number | undefined => thread.startsWith(`${SOURCE}:pr:`) ? Number(thread.slice(SOURCE.length + 4)) : undefined
export const pullsOf = (ticket: Pick<Ticket, 'follows'>, open = false): number[] =>
  (ticket.follows ?? []).filter(item => !open || !item.closed).flatMap(item => prOf(item.thread) ?? [])
/** True when the agent account opened the PR from a branch of the repository itself, not a fork. */
const agentPull = (ctx: SourceContext, pr: GitcodePull): boolean => {
  const { login, repository } = account(ctx.commands)
  return sameName(pr.user.login, login) && sameName(pr.head.repo?.full_name ?? repository, repository)
}
/**
 * Binds an open PR to a ticket when it is the ticket's source PR, or the agent's PR from the ticket's branch (whose last path
 * segment is the ticket's name); one PR binds to at most one open ticket. Returns why it refuses.
 */
export function claimPull(ctx: SourceContext, ticketId: string, pr: GitcodePull): string | undefined {
  const ticket = ctx.tickets.get(ticketId)
  if (!ticket || !liveTicket(ticket)) return 'Ticket ended because its PR was closed'
  const origin = ctx.triggers.get(ticket.origin.triggerId)
  const started = origin?.source === SOURCE && origin.meta.isPr === true && origin.meta.number === pr.number
  const opened = agentPull(ctx, pr) && ticketBranch(ticket, pr.head.ref)
  if (!started && !opened) {
    return `PR does not belong to this ticket: use the source PR or a PR by ${account(ctx.commands).login} from a branch whose last path segment is DSH_SUPERAGENT_NAME; omit pr_number when no PR exists`
  }
  const owner = ctx.tickets.open().find(item => pullsOf(item, true).includes(pr.number))
  if (owner && owner.id !== ticketId) return 'PR already belongs to another active ticket'
  const follow = ticket.follows?.find(item => item.thread === threadKey('pulls', pr.number))
  if (pr.state === 'open' && (!follow || follow.closed || (opened && !follow.own))) {
    ctx.atomic(() => {
      ctx.tickets.bindThread(ticketId, { source: SOURCE, id: threadId('pulls', pr.number) }, opened)
      ctx.threads.patch(threadKey('pulls', pr.number), { number: pr.number, isPr: true, url: pr.html_url, prAuthor: pr.user.login })
    })
  }
  return undefined
}
/** Reports a merged or closed PR to the tickets following it, or binds an open agent PR to the single open ticket on its branch. */
export function observePull(ctx: SourceContext, pr: GitcodePull): void {
  if (pr.state !== 'open') {
    if (!ctx.tickets.open().some(ticket => pullsOf(ticket, true).includes(pr.number))) return
    const merged = pr.state === 'merged' || !!pr.merged_at
    ctx.tickets.threadClosed({ source: SOURCE, id: threadId('pulls', pr.number) }, merged ? 'merged' : 'closed',
      pr.merged_at ?? pr.closed_at ?? new Date().toISOString())
    return
  }
  const candidates = agentPull(ctx, pr) ? ctx.tickets.open().filter(ticket => ticketBranch(ticket, pr.head.ref)) : []
  const ticket = candidates.length === 1 ? candidates[0]! : undefined
  const reopened = ticket?.follows?.some(item => item.thread === threadKey('pulls', pr.number) && item.closed)
  if (ticket && (reopened || pullsOf(ticket, true).every(number => number === pr.number))) claimPull(ctx, ticket.id, pr)
}

// CI: GitCode Actions runs of a commit, as the GitHub Source's check snapshot.
const RunSchema = z.looseObject({ workflow_name: z.string(), status: z.string(), head_sha: z.string(), run_number: z.coerce.number().default(0) })
const CONCLUSION: Record<string, string> = { COMPLETED: 'success', FAILED: 'failure', CANCELED: 'cancelled', IGNORED: 'skipped' }
/** The latest run of each workflow on `sha`; a repository without Actions (404) has none. */
export async function actionChecks(commands: Commands, branch: string, sha: string): Promise<CiSnapshot> {
  const listed = await api(commands, z.looseObject({ workflow_runs: z.array(z.unknown()) }),
    `v8/actions/runs?branch=${encodeURIComponent(branch)}&per_page=100`)
    .catch((error: unknown) => { if (error instanceof CliError && error.code === 404) return { workflow_runs: [] }; throw error })
  const latest = new Map<string, z.infer<typeof RunSchema>>()
  for (const run of validItems(RunSchema, listed.workflow_runs).filter(run => run.head_sha === sha)) {
    if ((latest.get(run.workflow_name)?.run_number ?? -1) < run.run_number) latest.set(run.workflow_name, run)
  }
  const checks = [...latest.values()].map(run => ({ name: run.workflow_name, status: CONCLUSION[run.status] ? 'completed' : 'in_progress',
    conclusion: CONCLUSION[run.status] ?? null })).sort((a, b) => a.name.localeCompare(b.name))
  return { head: sha, checks, statuses: [] }
}
const runsHint = (repository: string, branch: string) => `gc api '/api/v8/repos/${repository}/actions/runs?branch=${branch}'`
function ciTrigger(repository: string, pr: GitcodePull, revision: number, summary: string): Trigger {
  return { id: key('gitcode-ci', repository, String(pr.number), String(revision)), source: SOURCE,
    threads: [{ source: SOURCE, id: threadId('pulls', pr.number) }], actor: { source: SOURCE, id: '' }, human: false,
    at: new Date().toISOString(), text: summary, url: pr.html_url,
    channel: { source: SOURCE, thread: threadKey('pulls', pr.number), address: { repository, kind: 'pulls', number: String(pr.number) } },
    meta: { repository, number: pr.number, isPr: true, prAuthor: pr.user.login, ci: true, revision } }
}
/** A changed CI snapshot of an open ticket PR becomes a Trigger; the first one is the baseline. */
async function pollChecks(ctx: SourceContext, pr: GitcodePull, signal?: AbortSignal): Promise<void> {
  const { repository } = account(ctx.commands)
  const snapshot = await actionChecks(ctx.commands.withSignal(signal), pr.head.ref, pr.head.sha)
  const fingerprint = key(JSON.stringify(snapshot))
  const previous = ctx.state.get(KV.ci(pr.number))
  if (previous?.fingerprint === fingerprint) return
  const revision = previous ? previous.revision + 1 : 0
  if (previous) await ctx.receive(ciTrigger(repository, pr, revision, ciSummary(snapshot, `PR !${pr.number}`, runsHint(repository, pr.head.ref))))
  ctx.state.set(KV.ci(pr.number), { fingerprint, revision })
  if (snapshot.checks.length) ctx.threads.describe(threadKey('pulls', pr.number), { facts: { ci: ciFact(ciCounts(snapshot)) } })
}
/** The default branch's CI: a Trigger when its set of failing workflows changes after the baseline, and once it recovers. */
async function pollBranchCi(ctx: SourceContext, signal?: AbortSignal): Promise<void> {
  const commands = ctx.commands.withSignal(signal)
  const { repository } = account(commands)
  const { default_branch: branch } = await api(commands, z.looseObject({ default_branch: z.string() }), '')
  const head = await api(commands, z.looseObject({ commit: z.looseObject({ sha: z.string() }) }), `branches/${encodeURIComponent(branch)}`)
  const snapshot = await actionChecks(commands, branch, head.commit.sha)
  const previous = ctx.state.get(KV.branchCi)
  const known = previous?.branch === branch ? previous.failures : undefined
  const failures = ciFailures(snapshot)
  const now = failures.length || !ciCounts(snapshot).running ? failures : known ?? []
  let revision = previous?.revision ?? 0
  if (known && JSON.stringify(now) !== JSON.stringify(known)) {
    revision += 1
    await ctx.receive({ id: key('gitcode-ci', repository, `branch:${branch}`, String(revision)), source: SOURCE,
      threads: [{ source: SOURCE, id: `ci:${branch}` }], actor: { source: SOURCE, id: '' }, human: false, at: new Date().toISOString(),
      text: ciSummary(snapshot, branch, runsHint(repository, branch)), url: `https://gitcode.com/${repository}/commit/${head.commit.sha}`,
      meta: { repository, ci: true, branch, sha: head.commit.sha, revision } })
    ctx.threads.describe(`${SOURCE}:ci:${branch}`, { label: `CI on ${branch}`, facts: { ci: ciFact(ciCounts(snapshot)) } })
  }
  ctx.state.set(KV.branchCi, { branch, failures: now, revision })
}

/**
 * One polling round. For Issues and PRs updated since each cursor (oldest first), their new bodies and comments become
 * Triggers, and PR state changes reach the tickets following them; then the PRs of open tickets with their CI, and the
 * default branch's CI when observed. The first round only sets the cursors, so history is not ingested; Trigger IDs dedupe
 * the cursor's 5-second overlap. A failed round keeps its cursors and reads the same items again.
 */
export async function pollRound(ctx: SourceContext, config: GitcodeConfig, signal?: AbortSignal): Promise<number> {
  const commands = ctx.commands.withSignal(signal)
  const { repository, login } = account(commands)
  const started = new Date().toISOString()
  let received = 0
  const receive = async (trigger: Trigger) => { await ctx.receive(trigger); received++ }
  for (const kind of KINDS) {
    const name = KV.since(repository, kind)
    const since = ctx.state.get(name)
    if (!since) { ctx.state.set(name, cursorAt(started)); continue }
    const after = (at: string | null | undefined) => Date.parse(at ?? '') >= Date.parse(since)
    const listed = await api(commands, z.array(z.unknown()),
      `${kind}?state=all&sort=updated&direction=asc&per_page=100&since=${encodeURIComponent(since)}`)
    const updated = validItems(ItemSchema, listed)
    for (const item of updated) {
      if (signal?.aborted) return received
      if (after(item.created_at) && !skipped(item.user.login, item.body ?? '', login, config.keyword)) {
        await receive(openedTrigger(repository, kind, item, login, config.keyword))
      }
      // GitCode lists comments newest first.
      const comments = await pages(commands, CommentSchema, `${kind}/${item.number}/comments?since=${encodeURIComponent(since)}`)
      for (const comment of comments.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))) {
        if (!after(comment.updated_at ?? comment.created_at) || skipped(comment.user.login, comment.body ?? '', login, config.keyword)) continue
        await receive(commentTrigger(repository, kind, item.number, comment, login, config.keyword))
      }
      const pull = kind === 'pulls' ? PullSchema.safeParse(item) : undefined
      if (pull?.success) observePull(ctx, pull.data)
      const thread = threadKey(kind, item.number)
      ctx.threads.patch(thread, { title: item.title ?? '', url: item.html_url })
      ctx.threads.describe(thread, { label: `${kind === 'pulls' ? '!' : '#'}${item.number} ${item.title ?? ''}`, url: item.html_url })
    }
    // ponytail: a full page moves the cursor to its newest item; 100+ items sharing one timestamp would stall it.
    const newest = updated.at(-1)?.updated_at
    ctx.state.set(name, listed.length === 100 && newest ? new Date(Date.parse(newest)).toISOString() : cursorAt(started))
  }
  for (const number of new Set(ctx.tickets.open().flatMap(ticket => pullsOf(ticket, true)))) {
    if (signal?.aborted) return received
    const pr = await readPull(ctx, number, signal)
    observePull(ctx, pr)
    if (pr.state === 'open') await pollChecks(ctx, pr, signal)
  }
  if (config.observeCi) await pollBranchCi(ctx, signal)
  else { const seen = ctx.state.get(KV.branchCi); ctx.state.set(KV.branchCi, seen && { revision: seen.revision }) }
  ctx.report(SOURCE, { state: 'ready', detail: `${repository} as @${login}; ${received} new`, at: started })
  return received
}

async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  if (!ctx.configured()) { ctx.report(SOURCE, health('paused', 'setupPending')); return }
  let failures = 0
  while (!signal.aborted) {
    const config = ctx.config<GitcodeConfig>(SOURCE)
    try {
      if (!config) ctx.report(SOURCE, health('paused', 'sourceOff'))
      else if (!ctx.deployment.gitcode) ctx.report(SOURCE, { state: 'error', detail: ctx.problem?.detail ?? 'Set the repository and gc CLI on the GitCode card' })
      else { await pollRound(ctx, config, signal); failures = 0 }
    } catch (error) {
      failures += 1
      if (!signal.aborted && failures >= (config?.failuresBeforeError ?? 1)) {
        ctx.report(SOURCE, health('error', 'pollFailures', { count: String(failures), error: String(error) }))
      }
    }
    await pause((config?.pollSeconds ?? 60) * 1000, signal)
  }
}

export const gitcodeKind: SourceKind<GitcodeConfig> = {
  kind: SOURCE,
  title: { zh: 'GitCode', en: 'GitCode' },
  description: { zh: '通过 gc CLI 轮询 GitCode 仓库：发给智能体的 Issue、PR 和评论，已订阅讨论，工单 PR 的 CI 和合并关闭。账号可以和人共用：只有以“@账号 关键词”开头的内容发给智能体。', en: 'Polls a GitCode repository through the gc CLI: Issues, PRs and comments to the agent, subscribed discussion, ticket PRs\' CI, and PR merge or close. The account may be a person\'s own: only what starts "@account keyword" is to the agent.' },
  schema: GitcodeConfigSchema,
  fields: [
    { key: 'repository', type: 'text', pattern: '([A-Za-z0-9_.\\-]+/[A-Za-z0-9_.\\-]+)?', label: { zh: '监听的仓库', en: 'Repository' },
      hint: { zh: '写作 owner/name。保存时检查 gc 登录的账号能否读它，然后重启 dsh-superagent。', en: 'Written owner/name. Saving checks that the account gc is signed in to can read it, then restarts dsh-superagent.' } },
    { key: 'cli', type: 'text', label: { zh: '智能体的 GitCode CLI', en: 'Agent GitCode CLI' },
      hint: { zh: '命令名或绝对路径，通常是自己取得凭据的 gc 包装脚本（docs/006-deployment.md），因为工作 shell 不传 GITCODE_TOKEN。执行器以 gc 调用它，git 也用它取 gitcode.com 的凭据。', en: 'A command name or absolute path, usually a gc wrapper that finds its own credentials (docs/006-deployment.md), as worker shells drop GITCODE_TOKEN. The Executor calls it as gc, and git takes its gitcode.com credentials from it.' } },
    { key: 'keyword', type: 'text', pattern: '[\\w\\-]*', label: { zh: '唤醒词', en: 'Keyword' },
      hint: { zh: '以“@账号 唤醒词”开头的 Issue、PR 和评论发给智能体，例如“@me superagent, review this PR”；账号自己发的其他内容不接收，所以账号可以和人共用。留空时任何 @账号 都算。', en: 'An Issue, PR or comment that starts "@account keyword", such as "@me superagent, review this PR", is to the agent; the account\'s other posts are not received, so a person may share the account. Empty: any @account counts.' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 30, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
    { key: 'failuresBeforeError', type: 'number', advanced: true, min: 1, max: 20, label: { zh: '连续失败几次后报告异常', en: 'Failed polls before reporting an error' } },
    { key: 'observeIssues', type: 'switch', label: { zh: '接收仓库里的新 Issue', en: 'Receive new Issues in the repository' },
      hint: { zh: '打开后，不是发给智能体的新 Issue 也由策略的接收表决定。', en: 'New Issues not to the agent go to the Policy\'s admission table too.' } },
    { key: 'observePulls', type: 'switch', label: { zh: '接收仓库里的新 PR', en: 'Receive new pull requests in the repository' },
      hint: { zh: '打开后，不是发给智能体的新 PR 也由策略的接收表决定。', en: 'New pull requests not to the agent go to the Policy\'s admission table too.' } },
    { key: 'observeComments', type: 'switch', label: { zh: '接收仓库里的评论', en: 'Receive comments in the repository' },
      hint: { zh: '打开后，不是发给智能体的评论和代码评论也由策略的接收表决定。', en: 'Comments and code comments not to the agent go to the Policy\'s admission table too.' } },
    { key: 'observeCi', type: 'switch', label: { zh: '接收默认分支的 CI', en: 'Receive the default branch\'s CI' },
      hint: { zh: '打开后，默认分支 GitCode Actions 的失败和恢复由策略的接收表决定。', en: 'Failures of the default branch\'s GitCode Actions, and its recovery, go to the Policy\'s admission table.' } },
  ],
  health: [SOURCE],
  scope: ({ meta }, config) => {
    const row = rowOf(meta)
    return { listened: true, observed: row !== undefined && config[OBSERVED[row]], ...row ? { row } : {} }
  },
  channel: { send: sendGitcode, link: gitcodeLink },
  threadContext: gitcodeThreadContext,
  // `!12` names PR 12, `#12` or `12` Issue or PR 12, and a page URL its Issue or PR.
  find: query => {
    const text = query.trim()
    const url = /gitcode\.com\/[^/]+\/[^/]+\/(issues|merge_requests|pulls)\/(\d+)/.exec(text)
    if (url) return { threads: [threadKey(url[1] === 'issues' ? 'issues' : 'pulls', Number(url[2]))], terms: [] }
    const pr = /^!(\d+)$/.exec(text)?.[1]
    if (pr) return { threads: [threadKey('pulls', Number(pr))], terms: [] }
    const number = /^#?(\d+)$/.exec(text)?.[1]
    return { threads: number ? [threadKey('issues', Number(number)), threadKey('pulls', Number(number))] : [], terms: [] }
  },
  claimPull: async (ctx, ticketId, number, signal) => claimPull(ctx, ticketId, await readPull(ctx, number, signal)),
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_.-]+$/) }).strict()).default([]) }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的 GitCode 账号', en: 'GitCode accounts that may originate work' },
      columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9_.\\-]+' }] }],
    explicit: { zh: '名单里的账号发出以“@智能体账号 唤醒词”开头的 Issue、PR 或评论。', en: 'An account on the list posts an Issue, PR or comment that starts "@agent-account keyword".' },
    rows(stored) {
      const config = GitcodeConfigSchema.partial().parse(stored)
      const note = (observed: boolean | undefined) => observed ? { zh: '全部', en: 'All' } : { zh: '仅 @', en: '@ only' }
      const row = (id: Row, label: Localized) => ({ id, label, note: note(config[OBSERVED[id]]),
        cells: { listedUnaddressed: !!config[OBSERVED[id]], unlistedAddressed: true, unlistedUnaddressed: !!config[OBSERVED[id]] } })
      return [row('issues', { zh: '新 Issue', en: 'New Issues' }), row('pulls', { zh: '新 PR', en: 'New pull requests' }),
        row('comments', { zh: '评论', en: 'Comments' }),
        { id: 'ci', label: { zh: '默认分支的 CI', en: 'Default branch CI' }, note: config.observeCi ? { zh: '接收', en: 'Received' } : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: !!config.observeCi } }]
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_GITCODE_REPOSITORY', description: { zh: 'GitCode 来源监听的仓库，owner/name。智能体在这里开的 PR，分支最后一段是 DSH_SUPERAGENT_NAME 时会关联到工单', en: 'The repository the GitCode Source watches, as owner/name. A PR the agent opens here from a branch whose last path segment is DSH_SUPERAGENT_NAME binds to the ticket' } },
      { key: 'DSH_SUPERAGENT_GITCODE_ACCOUNT', description: { zh: '智能体的 GitCode 账号；gc 以它登录，所有 GitCode 操作都用 gc', en: 'The agent\'s GitCode account. gc is signed in to it; use gc for every GitCode operation' } },
      { key: 'DSH_SUPERAGENT_GITCODE_COMMIT_EMAIL', description: { zh: 'GitCode 账号的提交邮箱；提示词没有写明作者时，在 GitCode 仓库里以这个账号和邮箱提交', en: 'Commit email of the GitCode account; in the GitCode repository commit as this account and email when these instructions name no author' } },
      { key: 'DSH_SUPERAGENT_GITCODE_NUMBER', description: { zh: '接下工单的 GitCode Issue 或 PR 编号；工单不是从 GitCode 来的时为空', en: 'Number of the GitCode Issue or PR that started the ticket; empty when it did not start on GitCode' } },
      { key: 'DSH_SUPERAGENT_GITCODE_KIND', description: { zh: 'issue 或 pr：编号是哪一种；工单不是从 GitCode 来的时为空', en: 'issue or pr, which the number is; empty when the ticket did not start on GitCode' } },
      { key: 'DSH_SUPERAGENT_GITCODE_PR_HEAD', description: { zh: '接下工单的 PR 的 head 引用 refs/merge-requests/<编号>/head；不是 PR 时为空', en: 'Head ref refs/merge-requests/<number>/head of the PR that started the ticket; empty when it was not a PR' } },
    ],
    values: ({ deployment, config, trigger }) => {
      const mine = trigger?.threads[0]?.source === SOURCE && typeof trigger.meta.number === 'number'
      const pr = mine && trigger.meta.isPr === true
      return { DSH_SUPERAGENT_GITCODE_REPOSITORY: deployment.gitcode?.repository ?? config.repository,
        DSH_SUPERAGENT_GITCODE_ACCOUNT: deployment.gitcode?.login ?? '', DSH_SUPERAGENT_GITCODE_COMMIT_EMAIL: deployment.gitcode?.email ?? '',
        DSH_SUPERAGENT_GITCODE_NUMBER: mine ? String(trigger.meta.number) : '', DSH_SUPERAGENT_GITCODE_KIND: mine ? (pr ? 'pr' : 'issue') : '',
        DSH_SUPERAGENT_GITCODE_PR_HEAD: pr ? `refs/merge-requests/${String(trigger.meta.number)}/head` : '' }
    },
  },
  facts: (deployment): Record<string, Localized | string> => deployment?.gitcode ? {
    cli: { zh: `当前账号 @${deployment.gitcode.login}`, en: `Current account @${deployment.gitcode.login}` },
  } : {},
}

export const name = 'dsh-superagent-gitcode'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(gitcodeKind), 'gitcode: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, gitcodeKind)
    const controller = new AbortController()
    // An escaping rejection would terminate DSH, so it becomes source health instead.
    const running = watch(source, controller.signal).catch((error: unknown) => { source.report(SOURCE, { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
