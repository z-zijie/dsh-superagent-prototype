import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { gitcodeKind, pollRound, sendGitcode } from '../src/sources/gitcode.ts'
import { Commands } from '../src/infra/commands.ts'
import { testDeployment } from './fixtures/deployment.ts'

// Opt-in: talks to gitcode.com as the account of ~/.local/bin/gc-agent and posts on zhangzijie/skills#1; it also watches
// cann/cannbot, which it only reads. Run with GITCODE_LIVE=1.
it.runIf(process.env.GITCODE_LIVE)('live: receives only "@account superagent" posts of the shared account, and replies once', async () => {
  const cli = join(homedir(), '.local/bin/gc-agent'), repository = 'zhangzijie/skills', other = 'cann/cannbot'
  const login = JSON.parse(execFileSync(cli, ['--no-interactive', 'api', 'user'], { encoding: 'utf8' })).login as string
  const commands = new Commands(() => testDeployment({ gitcode: { cli, repository, repositories: [repository, other], login, email: '' } }), {}, new AbortController().signal)
  const state = new Map<string, unknown>(), received: any[] = [], reports: any[] = []
  const ctx: any = { commands, state: { get: (k: string) => state.get(k), set: (k: string, v: unknown) => state.set(k, v) },
    receive: async (t: any) => { received.push(t) }, threads: { patch() {}, describe() {} }, report: (_: string, h: any) => { reports.push(h) },
    tickets: { open: () => [] }, deployment: commands.deployment }
  const config = gitcodeKind.schema.parse({ repository, repositories: [{ id: other }], cli })
  const stamp = Date.now()
  execFileSync(cli, ['--no-interactive', 'issue', 'comment', '1', '-R', repository, '--body', `@${login} superagent, live test ${stamp}`])
  execFileSync(cli, ['--no-interactive', 'issue', 'comment', '1', '-R', repository, '--body', `a note to self ${stamp}`])
  for (const r of [repository, other]) for (const k of ['issues', 'pulls']) state.set(`gitcode-since:${r}:${k}`, new Date(Date.now() - 120_000).toISOString())
  await pollRound(ctx, config)
  expect(reports.at(-1)).toMatchObject({ state: 'ready', detail: expect.stringContaining(`${repository}, ${other} as @${login}`) })
  const mine = received.filter(t => t.text.includes(String(stamp)))
  expect(mine.map(t => [t.actor.id, t.addressed, t.human, t.threads[0].id])).toEqual([[login, 'mention', true, `${repository}:issue:1`]])
  const context = await gitcodeKind.threadContext!.read(commands, mine[0], 'thread', undefined, config)
  expect(context.messages.some(m => m.text.includes(`note to self ${stamp}`))).toBe(true)
  const message = { id: `live-${stamp}`, text: 'This is by an automated agent, not a human. Live test reply.', channel: mine[0].channel }
  expect(await sendGitcode(ctx, message)).toBe('sent')
  expect(await sendGitcode(ctx, message)).toBe('sent')
  const after = await gitcodeKind.threadContext!.read(commands, mine[0], 'thread', undefined, config)
  expect(after.messages.filter(m => m.text.includes(message.id))).toHaveLength(1)
  // The Source's own reply is never received.
  received.length = 0
  await pollRound(ctx, config)
  expect(received.filter(t => t.text.includes('Live test reply'))).toEqual([])
}, 180_000)
