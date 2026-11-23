// What the hooks do when something inside them fails.
import { expect, test } from 'claude-code/testing'
import { register } from '../hooks/register.js'
import { CHECK_GUARD_FAILED, OFF_TEXT, PLAN_SHOWN, PROMPT_GUARD_FAILED, onText } from '../lib/text.js'
import { W1, fakeApi, hooksWith } from './helpers.js'

const ON = { command: 'efficient-model-orchestrator-on' }
const OFF = { command: 'efficient-model-orchestrator-off' }
const PLAN_TOOL = { tool: 'mcp__efficient-model-orchestrator__plan' }
const pass = async (e: any) => e
// next as a .catch gets it: not yet called by the failed hook, or called (the failure came from below).
const untried = Object.assign(async (e: any) => ({ passed: e }), { called: false })
const tried = Object.assign(async (e: any) => ({ replayed: e }), { called: true })

async function turnedOn() {
  const hook = hooksWith(register, {})
  const $: any = fakeApi()
  await hook('command.run', ON)($, {})
  return { hook, $ }
}

test('a prompt hook that fails while the orchestrator is on drops the prompt with a reason', async () => {
  const { hook, $ } = await turnedOn()
  expect(await hook.catcher('prompt.submit')($, { text: 'fix it' }, untried)).toEqual({ drop: PROMPT_GUARD_FAILED })
})
test('a failed prompt hook lets through a slash command, an automated prompt, and a failure from below', async () => {
  const { hook, $ } = await turnedOn()
  const command = { text: '/efficient-model-orchestrator-off', command: { name: 'efficient-model-orchestrator-off', args: '' } }
  expect(await hook.catcher('prompt.submit')($, command, untried)).toEqual({ passed: command })
  const notice = { text: 'worker done', origin: { kind: 'task-notification' } }
  expect(await hook.catcher('prompt.submit')($, notice, untried)).toEqual({ passed: notice })
  expect(await hook.catcher('prompt.submit')($, { text: 'fix it' }, tried)).toEqual({ replayed: { text: 'fix it' } })
})
test('a failed prompt hook lets everything through while the orchestrator is off', async () => {
  const hook = hooksWith(register, {})
  expect(await hook.catcher('prompt.submit')(fakeApi(), { text: 'fix it' }, untried)).toEqual({ passed: { text: 'fix it' } })
})
test('a tool check that fails while the orchestrator is on denies the call', async () => {
  const { hook, $ } = await turnedOn()
  expect(await hook.catcher('tool.check')($, { tool: 'Edit', input: {} }, untried)).toEqual({ decision: 'deny', reason: CHECK_GUARD_FAILED })
})
test("a failed tool check lets through a worker's call and a failure from below", async () => {
  const { hook, $ } = await turnedOn()
  const worker = { tool: 'Edit', input: {}, agentId: 'ag1' }
  expect(await hook.catcher('tool.check')($, worker, untried)).toEqual({ passed: worker })
  expect(await hook.catcher('tool.check')($, { tool: 'Edit', input: {} }, tried)).toEqual({ replayed: { tool: 'Edit', input: {} } })
})
test('a failed tool check lets everything through while the orchestrator is off', async () => {
  const hook = hooksWith(register, {})
  expect(await hook.catcher('tool.check')(fakeApi(), { tool: 'Edit', input: {} }, untried)).toEqual({ passed: { tool: 'Edit', input: {} } })
})
test('a status line or transcript line that cannot be shown never breaks a hook', async () => {
  const hook = hooksWith(register, {})
  const $: any = fakeApi()
  $.ui.status = async () => { throw new Error('no ui') }
  $.ui.log = async () => { throw new Error('no ui') }
  expect((await hook('command.run', ON)($, {})).text).toBe(onText('claude-opus-5-5'))
  expect((await hook('tool.call', PLAN_TOOL)($, { tasks: [W1] })).result).toBe(PLAN_SHOWN)
  let sent: any
  await hook('prompt.submit')($, { text: 'OK' }, async (e: any) => { sent = e; return e })
  expect(sent.context.length).toBe(1)
  expect(await hook('turn.complete')($, { reason: 'aborted', durationMs: 1 }, pass)).toEqual({ reason: 'aborted', durationMs: 1 })
  expect(await hook('session.end')($, { reason: 'clear' }, pass)).toEqual({ reason: 'clear' })
  await hook('command.run', ON)($, {})
  expect((await hook('command.run', OFF)($, {})).text).toBe(OFF_TEXT)
})
test('a plan tool that cannot be registered again never breaks a hook', async () => {
  const hook = hooksWith(register, {})
  const $: any = fakeApi()
  $.tool.register = async () => { throw new Error('session not bound') }
  expect((await hook('command.run', ON)($, {})).text).toBe(onText('claude-opus-5-5'))
})
