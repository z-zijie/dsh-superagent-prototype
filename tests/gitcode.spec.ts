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
      ['me', 'Item 7\n\n@me superagent, the button is broken', 'mention', 'issue:7'],
      ['bob', 'more detail', undefined, 'issue:7']])
    const gate = settingsPolicy(h.store.settings(), h.sources).gate(h.received[0]!, h.store.threads.get('gitcode:issue:7')!, [])
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
    expect(trigger).toMatchObject({ text: 'a.ts:4\n\n@me superagent, rename this', threads: [{ id: 'pr:3' }],
      channel: { thread: 'gitcode:pr:3', address: { kind: 'pulls', number: '3', discussion: 'd1' } }, meta: { kind: 'inline', isPr: true } })
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
    expect(pullsOf(h.store.tickets.get('t1')!)).toEqual([5])
    const runs = (status: string) => ({ workflow_runs: [{ workflow_name: 'build', status, head_sha: 'abc', run_number: 1 }] })
    const routes: Record<string, unknown> = { issues: [], pulls: [], 'pulls/5': pull('open'), 'v8/actions/runs': runs('RUNNING') }
    stub(h.commands, routes)
    rewind(h)
    await pollRound(h.ctx, config())
    expect(h.received).toEqual([])
    routes['v8/actions/runs'] = runs('FAILED')
    await pollRound(h.ctx, config())
    expect(h.received.map(t => t.text.split('\n')[0])).toEqual(['CI failed 1/1 on PR !5 at abc: build'])
    routes['pulls/5'] = pull('merged', { merged_at: '2026-11-05T00:00:00Z' })
    await pollRound(h.ctx, config())
    expect(h.store.tickets.get('t1')).toMatchObject({ ended: { outcome: 'merged' } })
  })

  it('names Issues and PRs apart in thread search, and gives workers the PR head', () => {
    expect(gitcodeKind.find!('!12').threads).toEqual(['gitcode:pr:12'])
    expect(gitcodeKind.find!(`https://gitcode.com/${REPO}/issues/3`).threads).toEqual(['gitcode:issue:3'])
    expect(gitcodeKind.find!('#4').threads).toEqual(['gitcode:issue:4', 'gitcode:pr:4'])
    const trigger = { threads: [{ source: 'gitcode', id: 'pr:5' }], meta: { number: 5, isPr: true } } as unknown as Trigger
    expect(gitcodeKind.environment!.values({ deployment, config: config(), trigger })).toMatchObject({ DSH_SUPERAGENT_GITCODE_ACCOUNT: 'me',
      DSH_SUPERAGENT_GITCODE_KIND: 'pr', DSH_SUPERAGENT_GITCODE_PR_HEAD: 'refs/merge-requests/5/head' })
  })
})
