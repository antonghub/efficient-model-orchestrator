import { expect, test } from 'claude-code/testing'
import { DENY_PENDING } from '../lib/text.js'
import { M_HIGH, M_LOW, W1, partial, propose, setup, turnOn } from './helpers.js'

// setup() plus the stubs for the model request, turn end, permission check and subagent launch.
async function enforceSetup($: any, on: any) {
  const efforts: (string | number | undefined)[] = []
  const recorders = await setup($, on, on => {
    on('turn.step', async function* ($: any, e: any) {
      efforts.push(e.effort)
      return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: null }
    })
    on('turn.complete', () => ({ text: '' }))
    on('tool.check', () => ({ decision: 'allow' }))
    on('agent.spawn', ($: any, e: any) => ({ model: e.model, agentId: 'ag1' }))
  })
  return { ...recorders, efforts }
}

// Fires one model request (as a subagent when agentId is given) and returns the effort it went out with.
async function step($: any, efforts: unknown[], agentId?: string) {
  const stream = $.turn.step({ turnId: 't', index: 0, model: 'claude-test', messageCount: 1, ...(agentId ? { agentId } : {}) })
  let s = await stream.next()
  while (s.done !== true) s = await stream.next()
  return efforts.at(-1)
}

test('tool.check: a pending plan denies a Read', async ($, on) => {
  await enforceSetup($, on); await turnOn($); await propose($, [W1])
  expect(await $.tool.check({ tool: 'Read', input: { file_path: 'a' } })).toEqual({ decision: 'deny', reason: DENY_PENDING })
})
test('turn.step: main requests while executing get the highest main-task effort', async ($, on) => {
  const { efforts } = await enforceSetup($, on); await turnOn($)
  await propose($, [M_HIGH, M_LOW]); await $.prompt.submit(partial({ text: 'OK' }))
  expect(await step($, efforts)).toBe('high')
})
test('turn.complete on the main loop ends execution', async ($, on) => {
  const { statuses, efforts } = await enforceSetup($, on); await turnOn($)
  await propose($, [M_HIGH]); await $.prompt.submit(partial({ text: 'OK' }))
  await $.turn.complete(partial({ turnId: 't', answer: '', durationMs: 1, isAborted: false, reason: 'answer', usage: null }))
  expect(statuses.at(-1)).toBe('orchestrator on')
  expect(await step($, efforts)).toBeUndefined()
})
test('agent.spawn sets the approved model and turn.step the approved effort', async ($, on) => {
  const { efforts } = await enforceSetup($, on); await turnOn($)
  await propose($, [W1]); await $.prompt.submit(partial({ text: '1. sonnet' }))
  const r = await $.agent.spawn({ tool_use_id: 'tu', prompt: 'p', description: '[T1] Find callers', subagentType: 'general-purpose', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: false, fork: false })
  expect(r).toEqual({ model: 'sonnet', agentId: 'ag1' })
  expect(await step($, efforts, 'ag1')).toBe('medium')
})
