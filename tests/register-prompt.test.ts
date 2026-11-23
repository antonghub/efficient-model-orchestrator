import { expect, test } from 'claude-code/testing'
import { isFromUser, register } from '../hooks/register.js'
import { OFF_TEXT, PLAN_OFF, PLAN_SHOWN, REPLAN_CONTEXT, SHORT_REMINDER, approvedContext, fullBriefing, onText, planInvalid } from '../lib/text.js'
import { W1, W2, fakeApi, hooksWith, partial, propose, setup, turnOn } from './helpers.js'

test('registers the commands and the plan tool', async ($, on) => {
  const { commands, tools } = await setup($, on)
  expect(commands).toEqual(['efficient-model-orchestrator-on', 'efficient-model-orchestrator-off', 'efficient-model-orchestrator-stats'])
  expect(tools).toEqual(['escalate', 'plan'])
})
test('/on returns onText and sets the status; /off clears it', async ($, on) => {
  const { statuses } = await setup($, on)
  const a = await turnOn($)
  expect(a.text).toBe(onText('claude-sonnet-5-5'))
  expect(statuses.at(-1)).toBe('orchestrator on')
  const b = await $.command.run(partial({ command: 'efficient-model-orchestrator-off', args: '' }))
  expect(b.text).toBe(OFF_TEXT); expect(statuses.at(-1)).toBeUndefined()
})
test('off: prompts pass through with no context', async ($, on) => {
  await setup($, on)
  expect((await $.prompt.submit(partial({ text: 'fix the bug' }))).context).toBeUndefined()
})
test('on: first request gets the full briefing, the next the short reminder', async ($, on) => {
  await setup($, on)
  await turnOn($)
  expect((await $.prompt.submit(partial({ text: 'fix the bug' }))).context).toEqual([fullBriefing('none')])
  expect((await $.prompt.submit(partial({ text: 'and the docs' }))).context).toEqual([SHORT_REMINDER])
})
test('OK with no plan pending is a new request, not an approval', async ($, on) => {
  await setup($, on)
  await turnOn($)
  await $.prompt.submit(partial({ text: 'first' }))
  expect((await $.prompt.submit(partial({ text: 'OK' }))).context).toEqual([SHORT_REMINDER])
})
test('plan tool: invalid plan is refused with the error, valid plan goes pending', async ($, on) => {
  const { statuses } = await setup($, on)
  await turnOn($)
  expect((await propose($, [])).deny).toBe(planInvalid('the plan has no tasks'))
  expect((await propose($, [W1])).result).toBe(PLAN_SHOWN)
  expect(statuses.at(-1)).toBe('orchestrator on · plan pending (1 task)')
})
test('plan tool while off says no plan is needed', async ($, on) => {
  await setup($, on)
  expect((await propose($, [W1])).deny).toBe(PLAN_OFF)
})
test('approval with edits: approved context and a Starting log line', async ($, on) => {
  const { statuses, logs } = await setup($, on)
  await turnOn($)
  await propose($, [W1, W2])
  const r = await $.prompt.submit(partial({ text: '1. sonnet high' }))
  expect(r.context).toEqual([approvedContext({ tasks: [{ ...W1, model: 'sonnet', effort: 'high' }, W2] } as any)])
  expect(logs.at(-1)).toBe('Starting: 1 → Sonnet · high')
  expect(statuses.at(-1)).toBe('orchestrator on · 0/2 workers done')
})
test('a reply that does not parse keeps the plan pending and asks Claude to answer or re-plan', async ($, on) => {
  const { statuses } = await setup($, on)
  await turnOn($)
  await propose($, [W1, W2])
  for (const text of ['why opus for 2?', '7. haiku', '1. sonnet high, skip 3'])
    expect((await $.prompt.submit(partial({ text }))).context).toEqual([REPLAN_CONTEXT])
  expect(statuses.at(-1)).toBe('orchestrator on · plan pending (2 tasks)')
})
test('a slash command is not a request: no briefing, and the next request still gets the full one', async ($, on) => {
  await setup($, on)
  await turnOn($)
  expect((await $.prompt.submit(partial({ text: '/model opus', command: { name: 'model', args: 'opus' } }))).context).toBeUndefined()
  expect((await $.prompt.submit(partial({ text: 'fix the bug' }))).context).toEqual([fullBriefing('none')])
})
test('a slash command does not answer a pending plan', async ($, on) => {
  const { statuses } = await setup($, on)
  await turnOn($)
  await propose($, [W1])
  expect((await $.prompt.submit(partial({ text: 'ok', command: { name: 'ok', args: '' } }))).context).toBeUndefined()
  expect(statuses.at(-1)).toBe('orchestrator on · plan pending (1 task)')
})
test('a turn the app starts gets fresh looks; a message into a running turn does not', async () => {
  const hook = hooksWith(register, {})
  const $: any = fakeApi()
  const pass = async (e: any) => e
  const look = async () => (await hook('tool.check')($, { tool: 'Read', isReadOnly: true }, async () => ({ decision: 'allow' }))).decision
  await hook('command.run', { command: 'efficient-model-orchestrator-on' })($, {})
  await hook('prompt.submit')($, { text: 'fix it' }, pass)
  for (let i = 0; i < 3; i++) expect(await look()).toBe('allow')
  expect(await look()).toBe('deny')
  await hook('prompt.submit')($, { text: 'worker done', origin: { kind: 'task-notification' }, turnId: 't1' }, pass)
  expect(await look()).toBe('deny')
  await hook('prompt.submit')($, { text: 'worker done', origin: { kind: 'task-notification' } }, pass)
  expect(await look()).toBe('allow')
})
test("isFromUser: the user's own prompts count, automated ones don't", async () => {
  expect(isFromUser({})).toBe(true)
  for (const kind of ['composer', 'bridge', 'sdk', 'unclassified']) expect(isFromUser({ origin: { kind } })).toBe(true)
  for (const kind of ['task-notification', 'scheduled-trigger', 'peer', 'peer-send-message', 'auto-continuation', 'coordinator', 'observer', 'plugin'])
    expect(isFromUser({ origin: { kind } })).toBe(false)
})
test('isFromUser: a prompt the person did not type as shown is not theirs, whatever its origin', async () => {
  expect(isFromUser({ isMeta: true })).toBe(false)
  expect(isFromUser({ isMeta: true, origin: { kind: 'composer' } })).toBe(false)
  expect(isFromUser({ isMeta: false, origin: { kind: 'composer' } })).toBe(true)
})
