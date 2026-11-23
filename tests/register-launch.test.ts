// Launch bookkeeping through the real hooks: what counts as launched, finished and waiting.
import { expect, test } from 'claude-code/testing'
import { register } from '../hooks/register.js'
import { DENY_NO_PLAN, denyTwice, denyWaits, pausedLog, resumedContext, resumedLog } from '../lib/text.js'
import { W1, W2, fakeApi, hooksWith } from './helpers.js'

const ON = { command: 'efficient-model-orchestrator-on' }
const PLAN_TOOL = { tool: 'mcp__efficient-model-orchestrator__plan' }
const pass = async (e: any) => e
const startedAs = (agentId: string) => async (e: any) => ({ model: e.model, agentId })
const spawnInput = (description: string, id = 'tu1') => ({ description, fork: false, tool_use_id: id })

async function approved(tasks: unknown[]) {
  const hook = hooksWith(register, {})
  const $: any = fakeApi()
  await hook('command.run', ON)($, {})
  await hook('tool.call', PLAN_TOOL)($, { tasks })
  await hook('prompt.submit')($, { text: 'OK' }, pass)
  return { hook, $ }
}

// The effort one model request of that agent goes out with.
async function effortOf(hook: any, $: any, agentId: string) {
  let effort: unknown
  const stream = hook('turn.step')($, { agentId }, async function* (e: any) { effort = e.effort; return {} })
  let s = await stream.next()
  while (s.done !== true) s = await stream.next()
  return effort
}

test('while a worker is still starting, a second launch of its task is refused and its requests get its effort', async () => {
  const { hook, $ } = await approved([W1])
  let release = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  const first = hook('agent.spawn')($, spawnInput('[T1] x'), async (e: any) => { await gate; return { model: e.model, agentId: 'ag1' } })
  expect((await hook('agent.spawn')($, spawnInput('[T1] x', 'tu2'), startedAs('ag2'))).deny).toBe(denyTwice(1))
  expect(await effortOf(hook, $, 'ag1')).toBe('medium')
  release()
  expect((await first).model).toBe('haiku')
})
test('a launch Claude Code refuses can be tried again', async () => {
  const { hook, $ } = await approved([W1])
  expect((await hook('agent.spawn')($, spawnInput('[T1] x'), async () => ({ deny: 'no room' }))).deny).toBe('no room')
  expect((await hook('agent.spawn')($, spawnInput('[T1] x', 'tu2'), startedAs('ag1'))).model).toBe('haiku')
})
test('a launch that throws can be tried again', async () => {
  const { hook, $ } = await approved([W1])
  let thrown: unknown
  try { await hook('agent.spawn')($, spawnInput('[T1] x'), async () => { throw new Error('boom') }) } catch (error) { thrown = error }
  expect((thrown as Error).message).toBe('boom')
  expect((await hook('agent.spawn')($, spawnInput('[T1] x', 'tu2'), startedAs('ag1'))).model).toBe('haiku')
})
test('a task that waits is refused until the worker it waits for has finished', async () => {
  const { hook, $ } = await approved([W1, { ...W2, after: [1] }])
  expect((await hook('agent.spawn')($, spawnInput('[T2] x'), startedAs('ag2'))).deny).toBe(denyWaits(2, [1]))
  await hook('agent.spawn')($, spawnInput('[T1] x'), startedAs('ag1'))
  expect((await hook('agent.spawn')($, spawnInput('[T2] x', 'tu2'), startedAs('ag2'))).deny).toBe(denyWaits(2, [1]))
  await hook('turn.complete')($, { agentId: 'ag1', reason: 'answer', durationMs: 1 }, pass)
  expect((await hook('agent.spawn')($, spawnInput('[T2] x', 'tu3'), startedAs('ag2'))).model).toBe('opus')
})
test('the Agent call returning also counts as the worker finishing', async () => {
  const { hook, $ } = await approved([W1, { ...W2, after: [1] }])
  await hook('agent.spawn')($, spawnInput('[T1] x'), startedAs('ag1'))
  await hook('tool.call', { tool: 'Agent' })($, { description: '[T1] x', tool_use_id: 'tu1' }, async () => ({ result: 'done' }))
  expect((await hook('agent.spawn')($, spawnInput('[T2] x', 'tu2'), startedAs('ag2'))).model).toBe('opus')
})

// --- Pause and resume ---

test('an aborted turn pauses the plan, and "continue" resumes it without a new approval', async () => {
  const { hook, $ } = await approved([W1, W2])
  await hook('agent.spawn')($, spawnInput('[T1] x'), startedAs('ag1'))
  await hook('turn.complete')($, { agentId: 'ag1', reason: 'answer', durationMs: 1 }, pass)
  await hook('turn.complete')($, { reason: 'aborted', durationMs: 1 }, pass)
  expect($.logs.at(-1)).toBe(pausedLog(1, 2))
  expect((await hook('agent.spawn')($, spawnInput('[T2] x', 'tu2'), startedAs('ag2'))).deny).toBe(DENY_NO_PLAN)
  let sent: any
  await hook('prompt.submit')($, { text: 'continue' }, async (e: any) => { sent = e; return e })
  expect(sent.context).toEqual([resumedContext({ tasks: [W1, W2] } as any, [1])])
  expect($.logs.at(-1)).toBe(resumedLog(1, 2))
  expect((await hook('agent.spawn')($, spawnInput('[T1] x', 'tu3'), startedAs('ag3'))).deny).toBe(denyTwice(1))
  expect((await hook('agent.spawn')($, spawnInput('[T2] x', 'tu4'), startedAs('ag2'))).model).toBe('opus')
})
test('a plan that ran to its end leaves no pause line', async () => {
  const { hook, $ } = await approved([W1])
  await hook('agent.spawn')($, spawnInput('[T1] x'), startedAs('ag1'))
  await hook('turn.complete')($, { agentId: 'ag1', reason: 'answer', durationMs: 1 }, pass)
  const before = $.logs.length
  await hook('turn.complete')($, { reason: 'answer', durationMs: 1 }, pass)
  expect($.logs.length).toBe(before)
})

// --- Live progress ---

test('a worker finishing updates the status line with the progress and the tokens it used, cache reads left out', async () => {
  const { hook, $ } = await approved([W1, W2])
  expect($.statuses.at(-1)).toBe('orchestrator on · 0/2 workers done')
  await hook('agent.spawn')($, spawnInput('[T1] x'), startedAs('ag1'))
  const usage = { input_tokens: 1000, output_tokens: 300, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 700 }
  await hook('turn.complete')($, { agentId: 'ag1', reason: 'answer', durationMs: 1, usage }, pass)
  expect($.statuses.at(-1)).toBe('orchestrator on · 1/2 workers done · 2K tokens')
})
