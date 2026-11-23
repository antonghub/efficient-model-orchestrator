// Edge cases through the real hooks: who may plan, /clear, foreground workers, an always-loaded plan tool,
// and the log lines of two workers that finish together.
import { expect, test } from 'claude-code/testing'
import { PLAN_WORKER } from '../lib/text.js'
import { PLAN_TOOL, W1, W2, partial, propose, setup, turnOn } from './helpers.js'

const spawn = ($: any, description: string, background = false) => $.agent.spawn({
  tool_use_id: 'tu', prompt: 'p', description, subagentType: 'general-purpose',
  provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background, fork: false,
})

test('a worker calling the plan tool is told only the main chat plans; nothing goes pending', async ($, on) => {
  const { statuses } = await setup($, on)
  await turnOn($)
  const r = await $.tool.call({ tool: PLAN_TOOL, tasks: [W1], agentId: 'ag9' })
  expect(r.deny).toBe(PLAN_WORKER)
  expect(statuses.at(-1)).toBe('orchestrator on')
})
test('/clear turns the orchestrator off', async ($, on) => {
  const { statuses } = await setup($, on, on => on('session.end', () => ({ sessionId: 's1' })))
  await turnOn($); await propose($, [W1])
  await $.session.end(partial({ reason: 'clear' }))
  expect(statuses.at(-1)).toBeUndefined()
  expect((await $.prompt.submit(partial({ text: 'hello' }))).context).toBeUndefined()
})
test('workers always launch in the foreground', async ($, on) => {
  const seen: unknown[] = []
  await setup($, on, on => on('agent.spawn', ($: any, e: any) => { seen.push(e.background); return { model: e.model, agentId: 'ag1' } }))
  await turnOn($); await propose($, [W1]); await $.prompt.submit(partial({ text: 'OK' }))
  await spawn($, '[T1] Find callers', true)
  expect(seen).toEqual([false])
})
test('the plan tool is never deferred behind tool search', async ($, on) => {
  await setup($, on, on => on('tool.describe', ($: any, e: any) => ({ description: e.description, isDeferred: true })))
  const r = await $.tool.describe(partial({ tool: PLAN_TOOL, description: 'd' }))
  expect(r.isDeferred).toBe(false)
})
test('two workers finishing together both get their log line, with their agent ids', async ($, on) => {
  const files = new Map<string, string>()
  const ticks = async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }
  await setup($, on, on => {
    on('session.id', () => ({ value: 'sess' }))
    on('env.get', () => ({ value: '/Users/a' }))
    // The append command: adds what it is given on stdin to the file named last.
    on('process.run', async ($: any, e: any) => {
      await ticks()
      const path = e.argv.at(-1)
      files.set(path, (files.get(path) ?? '') + e.init.stdin)
      return { value: { exitCode: 0, stdout: '', stderr: '' } }
    })
    on('fs.exists', async ($: any, e: any) => { await ticks(); return { value: files.has(e.path) } })
    on('fs.read', async ($: any, e: any) => { await ticks(); return { value: files.get(e.path) ?? '' } })
    on('fs.write', async ($: any, e: any) => { await ticks(); files.set(e.path, e.text); return { value: undefined } })
    on('agent.spawn', ($: any, e: any) => ({ model: e.model, agentId: e.description.startsWith('[T2]') ? 'ag2' : 'ag1' }))
    on('turn.complete', () => ({ text: '' }))
  })
  await turnOn($); await propose($, [W1, W2]); await $.prompt.submit(partial({ text: 'OK' }))
  await spawn($, '[T1] Find callers'); await spawn($, '[T2] Fix refresh bug')
  const done = (agentId: string) => $.turn.complete(partial({ turnId: 't', agentId, answer: '', durationMs: 1, isAborted: false, reason: 'answer', usage: null }))
  await Promise.all([done('ag1'), done('ag2')])
  const lines = (files.get('/Users/a/.claude/efficient-model-orchestrator/logs/sess.jsonl') ?? '').trim().split('\n').map(l => JSON.parse(l))
  expect(lines.map(l => l.agentId).sort()).toEqual(['ag1', 'ag2'])
})
