import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Engine, type Assessor, type Executor, type Trigger } from '../src/core/index.ts'
import { addressed, claimPull, gitcodeKind, observePull, pollRound, pullsOf, sendGitcode, skipped, type GitcodeConfig, type GitcodePull }
  from '../src/sources/gitcode.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { Store } from '../src/app/store.ts'
import { Commands, commandError } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { resolveGitcode } from '../src/deployment.ts'

const REPO = 'acme/widgets'
// The agent shares the operator's own account, `me`.
const deployment = testDeployment({ gitcode: { cli: '/bin/gc-test', repository: REPO, login: 'me', email: 'me@example.com' } })
const config = (): GitcodeConfig => gitcodeKind.schema.parse({ repository: REPO, cli: 'gc-test' })
const user = (login: string) => ({ login, name: login })
const at = (minute: number) => `2026-11-04T10:${String(minute).padStart(2, '0')}:00+08:00`
const item = (number: number, body: string, login = 'me') => ({ number: String(number), title: `Item ${number}`, body, state: 'open',
  html_url: `https://gitcode.com/${REPO}/issues/${number}`, user: user(login), created_at: at(1), updated_at: at(9) })
const comment = (id: number, body: string, login = 'me', minute = 5, extra: Record<string, unknown> = {}) =>
  ({ id, body, user: user(login), created_at: at(minute), updated_at: at(minute), ...extra })

function host() {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'gitcode-')), 'db.sqlite'))
  store.saveSettings(SettingsSchema.parse({ policy: { sources: { gitcode: { allowed: [{ id: 'me' }] } } }, eval: { mode: 'auto' },
    sources: { gitcode: { enabled: true, config: { repository: REPO, cli: 'gc-test' } } } }))
  const sources = new SourceRegistry(() => store.settings(), new HealthBoard())
  sources.register(gitcodeKind)
  const assessor: Assessor = { request: vi.fn(async () => {}) }
  const executor: Executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor, executor,
    outbox: { send: () => {}, status: () => undefined, withdraw: () => {} } })
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const received: Trigger[] = []
  const receive = vi.fn(async (trigger: Trigger) => { received.push(trigger); return engine.receive(trigger) })
  const parts: SourceContextDeps = { store, engine, outbox: { send: () => {} }, commands, sources, deployment,
    ready: Promise.resolve(), configured: () => true, receive }
  return { ctx: sourceContextOf(parts, gitcodeKind), commands, received, engine, store, sources }
}
/** Stubs `gc --no-interactive api <path>` by path (query string stripped) and records every argv. */
function stub(commands: Commands, routes: Record<string, unknown>): string[][] {
  const calls: string[][] = []
  vi.spyOn(commands, 'run').mockImplementation(async (program, args) => {
    expect(program).toBe('/bin/gc-test')
    calls.push(args)
    if (args[1] !== 'api') return '{}'
    const path = args[2]!.replace(`/api/v8/repos/${REPO}/`, 'v8/').replace(`repos/${REPO}/`, '').replace(/\?.*$/, '')
    if (!(path in routes)) throw commandError({ stderr: 'Error: HTTP 404: Not Found', code: 3 })
    return JSON.stringify(routes[path])
  })
  return calls
}
const rewind = (h: ReturnType<typeof host>) => {
  for (const kind of ['issues', 'pulls']) h.ctx.state.set(`gitcode-since:${REPO}:${kind}`, '2026-11-04T02:00:30.000Z')
}

describe('GitCode source', () => {
  it('addresses the agent only with "@account keyword" at the start, so a person can share the account', () => {
    expect(addressed('@me superagent, review this PR', 'me', 'superagent')).toBe(true)
    expect(addressed('  @Me  SuperAgent: look', 'me', 'superagent')).toBe(true)
    expect(addressed('@me please look', 'me', 'superagent')).toBe(false)
    expect(addressed('see @me superagent', 'me', 'superagent')).toBe(false)
    expect(addressed('@me superagents', 'me', 'superagent')).toBe(false)
    expect(addressed('cc @me', 'me', '')).toBe(true)
    // As GitCode stores the mention.
    expect(addressed('[@me](https://gitcode.com/me) superagent, review', 'me', 'superagent')).toBe(true)
    // The account's other posts, and the Source's own replies, are not received.
    expect(skipped('me', 'a note to self', 'me', 'superagent')).toBe(true)
    expect(skipped('me', '@me superagent, fix it', 'me', 'superagent')).toBe(false)
    expect(skipped('bob', 'any comment', 'me', 'superagent')).toBe(false)
    expect(skipped('me', '@me superagent, done\n\n<!-- dsh-superagent:m1 -->', 'me', 'superagent')).toBe(true)
  })

  it('starts from now, then receives addressed posts and others\' comments oldest first; the operator\'s request is explicit', async () => {
    const h = host()
    const routes = { issues: [item(7, '@me superagent, the button is broken')], pulls: [],
      'issues/7/comments': [comment(4, 'old', 'bob', 0), comment(3, 'more detail', 'bob', 6), comment(2, 'note to self', 'me', 5)] }
    stub(h.commands, routes)
    await pollRound(h.ctx, config())
    expect(h.received).toEqual([])
    rewind(h)
    await pollRound(h.ctx, config())
    expect(h.received.map(t => [t.actor.id, t.text, t.addressed, t.threads[0]!.id])).toEqual([
      ['me', 'Item 7\n\n@me superagent, the button is broken', 'mention', `${REPO}:issue:7`],
      ['bob', 'more detail', undefined, `${REPO}:issue:7`]])
    const gate = settingsPolicy(h.store.settings(), h.sources).gate(h.received[0]!, h.store.threads.get(`gitcode:${REPO}:issue:7`)!, [])
    expect(gate).toMatchObject({ admissible: true, strength: 'explicit' })
    // A repeated poll of the same window yields the same Trigger IDs, which the Engine dedupes.
    const ids = h.received.map(t => t.id)
    rewind(h)
    await pollRound(h.ctx, config())
    expect(h.received.slice(2).map(t => t.id)).toEqual(ids)
  })

  it('replies in a code comment\'s review discussion, and once per message', async () => {
    const h = host()
    const routes = { issues: [], pulls: [{ ...item(3, 'pr'), html_url: `https://gitcode.com/${REPO}/merge_requests/3`, head: { ref: 'fix', sha: 'abc' } }],
      'pulls/3/comments': [comment(9, '@me superagent, rename this', 'me', 5, { comment_type: 'diff_comment', discussion_id: 'd1', path: 'a.ts', diff_position: { start_new_line: 4 } })] }
    const calls = stub(h.commands, routes)
    rewind(h)
    await pollRound(h.ctx, config())
    const [trigger] = h.received
    expect(trigger).toMatchObject({ text: 'a.ts:4\n\n@me superagent, rename this', threads: [{ id: `${REPO}:pr:3` }],
      channel: { thread: `gitcode:${REPO}:pr:3`, address: { repository: REPO, kind: 'pulls', number: '3', discussion: 'd1' } }, meta: { kind: 'inline', isPr: true } })
    expect(await sendGitcode(h.ctx, { id: 'm1', text: 'done', channel: trigger!.channel! })).toBe('sent')
    expect(calls.filter(args => args[1] === 'pr')).toEqual([['--no-interactive', 'pr', 'reply', '3', '--discussion', 'd1', '-R', REPO, '--body', 'done\n\n<!-- dsh-superagent:m1 -->']])
    routes['pulls/3/comments'].push(comment(10, 'done\n\n<!-- dsh-superagent:m1 -->'))
    expect(await sendGitcode(h.ctx, { id: 'm1', text: 'done', channel: trigger!.channel! })).toBe('sent')
    expect(calls.filter(args => args[1] === 'pr')).toHaveLength(1)
  })

  it('binds the agent\'s PR on the ticket branch, delivers its CI changes, and ends the ticket when it merges', async () => {
    const h = host()
    h.store.tickets.save({ id: 't1', title: 'one', decisionId: 'd', mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' },
      actor: { source: 'gitcode', id: 'me' }, scope: '' }, channels: [], assignments: [{ id: 'a', state: 'running', createdAt: '' }], inputs: [],
      undelivered: [], createdAt: '', updatedAt: '', execution: { name: 'one', directory: '/w/one', assignment: '' }, origin: { triggerId: 'x', triggerIds: [] } })
    const pull = (state: string, extra: Partial<GitcodePull> = {}): GitcodePull => ({ number: 5, title: 'Fix', state, html_url: `https://gitcode.com/${REPO}/merge_requests/5`,
      user: { login: 'me' }, head: { ref: 'agent/one', sha: 'abc', repo: { full_name: REPO } }, ...extra })
    expect(claimPull(h.ctx, 't1', pull('open', { head: { ref: 'other', sha: 'abc' } }))).toMatch(/does not belong/)
    observePull(h.ctx, pull('open'))
    expect(pullsOf(h.store.tickets.get('t1')!)).toEqual([{ repository: REPO, number: 5 }])
    const runs = (status: string) => ({ workflow_runs: [{ workflow_name: 'build', status, head_sha: 'abc', run_number: 1 }] })
    const routes: Record<string, unknown> = { issues: [], pulls: [], 'pulls/5': pull('open'), 'v8/actions/runs': runs('RUNNING') }
    stub(h.commands, routes)
    rewind(h)
    await pollRound(h.ctx, config())
    expect(h.received).toEqual([])
    routes['v8/actions/runs'] = runs('FAILED')
    await pollRound(h.ctx, config())
    expect(h.received.map(t => t.text.split('\n')[0])).toEqual([`CI failed 1/1 on ${REPO} PR !5 at abc: build`])
    routes['pulls/5'] = pull('merged', { merged_at: '2026-11-05T00:00:00Z' })
    await pollRound(h.ctx, config())
    expect(h.store.tickets.get('t1')).toMatchObject({ ended: { outcome: 'merged' } })
  })

  it('names Issues and PRs apart in thread search, and gives workers the PR head', () => {
    expect(gitcodeKind.find!('!12', config()).threads).toEqual([`gitcode:${REPO}:pr:12`])
    expect(gitcodeKind.find!(`https://gitcode.com/${REPO}/issues/3`, config()).threads).toEqual([`gitcode:${REPO}:issue:3`])
    expect(gitcodeKind.find!('#4', config()).threads).toEqual([`gitcode:${REPO}:issue:4`, `gitcode:${REPO}:pr:4`])
    const trigger = { threads: [{ source: 'gitcode', id: `${REPO}:pr:5` }], meta: { repository: REPO, number: 5, isPr: true } } as unknown as Trigger
    expect(gitcodeKind.environment!.values({ deployment, config: config(), trigger })).toMatchObject({ DSH_SUPERAGENT_GITCODE_ACCOUNT: 'me',
      DSH_SUPERAGENT_GITCODE_KIND: 'pr', DSH_SUPERAGENT_GITCODE_PR_HEAD: 'refs/merge-requests/5/head' })
  })
})

describe('GitCode source with several repositories', () => {
  const OTHER = 'Cann/Ops-Math'
  const multi = testDeployment({ gitcode: { cli: '/bin/gc-test', repository: REPO, repositories: [REPO, OTHER], login: 'me', email: 'me@example.com' } })
  const multiConfig = (): GitcodeConfig => gitcodeKind.schema.parse({ repository: REPO, repositories: [{ id: OTHER }], cli: 'gc-test' })
  function multiHost() {
    const h = host()
    const commands = new Commands(() => multi, {}, new AbortController().signal)
    const parts: SourceContextDeps = { store: h.store, engine: h.engine, outbox: { send: () => {} }, commands, sources: h.sources,
      deployment: multi, ready: Promise.resolve(), configured: () => true,
      receive: vi.fn(async (trigger: Trigger) => { h.received.push(trigger); return h.engine.receive(trigger) }) }
    return { ...h, commands, ctx: sourceContextOf(parts, gitcodeKind) }
  }
  /** Routes by repository, then by path within it (query string stripped). */
  function multiStub(commands: Commands, routes: Record<string, Record<string, unknown>>): string[][] {
    const calls: string[][] = []
    vi.spyOn(commands, 'run').mockImplementation(async (_program, args) => {
      calls.push(args)
      if (args[1] !== 'api') return '{}'
      const match = /^(?:\/api\/v8\/)?repos\/([^/]+\/[^/]+)\/?(.*)$/.exec(args[2]!)!
      const prefix = args[2]!.startsWith('/api/v8/') ? 'v8/' : ''
      const repo = routes[match[1]!.toLowerCase()]
      const path = prefix + match[2]!.replace(/\?.*$/, '')
      if (!repo || !(path in repo)) throw commandError({ stderr: 'Error: HTTP 404: Not Found', code: 3 })
      if (repo[path] instanceof Error) throw repo[path]
      return JSON.stringify(repo[path])
    })
    return calls
  }
  const rewindAll = (h: ReturnType<typeof multiHost>) => {
    for (const repo of [REPO, OTHER]) for (const kind of ['issues', 'pulls']) h.ctx.state.set(`gitcode-since:${repo}:${kind}`, '2026-11-04T02:00:30.000Z')
  }
  const otherItem = (number: number, body: string) => ({ ...item(number, body), html_url: `https://gitcode.com/${OTHER}/issues/${number}` })

  it('receives addressed posts from every watched repository on threads named by repository', async () => {
    const h = multiHost()
    multiStub(h.commands, {
      [REPO]: { issues: [item(7, '@me superagent, fix the button')], pulls: [], 'issues/7/comments': [] },
      [OTHER.toLowerCase()]: { issues: [otherItem(7, '@me superagent, same number elsewhere')], pulls: [], 'issues/7/comments': [] } })
    rewindAll(h)
    await pollRound(h.ctx, multiConfig())
    expect(h.received.map(t => [t.threads[0]!.id, t.meta.repository, t.channel!.address.repository])).toEqual([
      [`${REPO}:issue:7`, REPO, REPO], ['cann/ops-math:issue:7', OTHER, OTHER]])
    expect(new Set(h.received.map(t => t.id)).size).toBe(2)
  })

  it('keeps reading the other repositories when one fails, then reports the failure', async () => {
    const h = multiHost()
    multiStub(h.commands, {
      [REPO]: { issues: new Error('HTTP 502'), pulls: [] },
      [OTHER.toLowerCase()]: { issues: [otherItem(2, '@me superagent, still works')], pulls: [], 'issues/2/comments': [] } })
    rewindAll(h)
    await expect(pollRound(h.ctx, multiConfig())).rejects.toThrow(/acme\/widgets: HTTP 502/)
    expect(h.received.map(t => t.threads[0]!.id)).toEqual(['cann/ops-math:issue:2'])
    // The failed repository keeps its cursor and is read again; the other one moved on.
    expect(h.ctx.state.get(`gitcode-since:${REPO}:issues`)).toBe('2026-11-04T02:00:30.000Z')
    expect(h.ctx.state.get(`gitcode-since:${OTHER}:issues`)).not.toBe('2026-11-04T02:00:30.000Z')
  })

  it('replies in the repository the conversation is in, and refuses one it does not watch', async () => {
    const h = multiHost()
    const calls = multiStub(h.commands, { [OTHER.toLowerCase()]: { 'issues/2/comments': [] } })
    const channel = { source: 'gitcode', thread: 'gitcode:cann/ops-math:issue:2', address: { repository: 'cann/ops-math', kind: 'issues', number: '2' } }
    expect(await sendGitcode(h.ctx, { id: 'm1', text: 'done', channel })).toBe('sent')
    expect(calls.find(args => args[1] === 'issue')).toEqual(['--no-interactive', 'issue', 'comment', '2', '-R', OTHER, '--body', 'done\n\n<!-- dsh-superagent:m1 -->'])
    await expect(sendGitcode(h.ctx, { id: 'm2', text: 'x', channel: { ...channel, address: { ...channel.address, repository: 'evil/repo' } } }))
      .rejects.toThrow(/does not watch evil\/repo/)
  })

  it('binds a PR of the ticket\'s own repository, so equal numbers in two repositories stay apart', async () => {
    const h = multiHost()
    h.store.triggers.save({ id: 'x', source: 'gitcode', threads: [{ source: 'gitcode', id: 'cann/ops-math:issue:2' }], actor: { source: 'gitcode', id: 'me' },
      human: true, at: at(1), text: '', meta: { repository: OTHER, number: 2, isPr: false, kind: 'issue' } } as Trigger)
    h.store.tickets.save({ id: 't1', title: 'one', decisionId: 'd', mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' },
      actor: { source: 'gitcode', id: 'me' }, scope: '' }, channels: [], assignments: [{ id: 'a', state: 'running', createdAt: '' }], inputs: [],
      undelivered: [], createdAt: '', updatedAt: '', execution: { name: 'one', directory: '/w/one', assignment: '' }, origin: { triggerId: 'x', triggerIds: [] } })
    const pull = { number: 5, title: 'Fix', state: 'open', html_url: `https://gitcode.com/${OTHER}/merge_requests/5`, user: { login: 'me' },
      head: { ref: 'agent/one', sha: 'abc', repo: { full_name: OTHER } } }
    multiStub(h.commands, { [OTHER.toLowerCase()]: { 'pulls/5': pull } })
    expect(await gitcodeKind.claimPull!(h.ctx, 't1', 5)).toBeUndefined()
    expect(pullsOf(h.store.tickets.get('t1')!)).toEqual([{ repository: 'cann/ops-math', number: 5 }])
    // A merge of !5 in the default repository does not end it.
    observePull(h.ctx, { ...pull, state: 'merged', head: { ...pull.head, repo: { full_name: REPO } } }, REPO)
    expect(h.store.tickets.get('t1')?.ended).toBeUndefined()
    observePull(h.ctx, { ...pull, state: 'merged', merged_at: '2026-11-05T00:00:00Z' }, OTHER)
    expect(h.store.tickets.get('t1')).toMatchObject({ ended: { outcome: 'merged' } })
  })

  it('searches every watched repository without a name, and gives workers the ticket\'s repository', () => {
    expect(gitcodeKind.find!('!3', multiConfig()).threads).toEqual([`gitcode:${REPO}:pr:3`, 'gitcode:cann/ops-math:pr:3'])
    expect(gitcodeKind.find!('Cann/Ops-Math#3', multiConfig()).threads).toEqual(['gitcode:cann/ops-math:issue:3', 'gitcode:cann/ops-math:pr:3'])
    expect(gitcodeKind.find!(`https://gitcode.com/${OTHER}/merge_requests/9`, multiConfig()).threads).toEqual(['gitcode:cann/ops-math:pr:9'])
    const trigger = { threads: [{ source: 'gitcode', id: 'cann/ops-math:issue:2' }], meta: { repository: 'cann/ops-math', number: 2, isPr: false } } as unknown as Trigger
    expect(gitcodeKind.environment!.values({ deployment: multi, config: multiConfig(), trigger })).toMatchObject({
      DSH_SUPERAGENT_GITCODE_REPOSITORY: OTHER, DSH_SUPERAGENT_GITCODE_REPOSITORIES: `${REPO} ${OTHER}`, DSH_SUPERAGENT_GITCODE_KIND: 'issue' })
    expect(gitcodeKind.environment!.values({ deployment: multi, config: multiConfig() })).toMatchObject({ DSH_SUPERAGENT_GITCODE_REPOSITORY: REPO })
  })

  it('setup checks every repository and keeps GitCode\'s spelling', async () => {
    const seen: string[] = []
    const probe = async (argv: string[]) => {
      const path = argv.at(-1)!
      seen.push(path)
      if (path === 'user') return JSON.stringify({ login: 'me', email: 'me@example.com' })
      if (path === 'repos/cann/ops-math') return JSON.stringify({ full_name: OTHER })
      if (path === `repos/${REPO}`) return JSON.stringify({ full_name: REPO })
      throw new Error('HTTP 404')
    }
    const machine = testDeployment()
    const resolved = await resolveGitcode(machine, { cli: '/bin/sh', repository: REPO, repositories: [{ id: 'cann/ops-math' }, { id: REPO.toUpperCase() }] }, probe)
    expect(resolved).toMatchObject({ repository: REPO, repositories: [REPO, OTHER], login: 'me' })
    expect(seen).toEqual(['user', `repos/${REPO}`, 'repos/cann/ops-math'])
    await expect(resolveGitcode(machine, { cli: '/bin/sh', repository: REPO, repositories: [{ id: 'nope/missing' }] }, probe))
      .rejects.toMatchObject({ code: 'gitcodeRepositoryUnreadable', values: { repository: 'nope/missing' } })
    // Only extra repositories: the first becomes the default one.
    expect(await resolveGitcode(machine, { cli: '/bin/sh', repositories: [{ id: 'cann/ops-math' }] }, probe)).toMatchObject({ repository: OTHER })
  })
})
