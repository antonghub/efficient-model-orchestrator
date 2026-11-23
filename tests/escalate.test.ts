// The escalation offer: a finished worker task, retried one step stronger on the user's word.
import { expect, test } from 'claude-code/testing'
import { register } from '../hooks/register.js'
import { renderOffer } from '../lib/plan.js'
import { OrchestratorSession } from '../lib/session.js'
import {
  DENY_NO_PLAN, DENY_PENDING, DROP_FABLE_OFF, DROP_STILL_WORKING, ESCALATE_BAD_INPUT, ESCALATE_NO_PLAN, ESCALATE_OFF, ESCALATE_SHOWN,
  FABLE_BLOCKED_NOTE, PLAN_WORKER, RETRY_REPLY_CONTEXT, denyTwice, escalateHint, escalateNoStronger, escalateNotFinished, escalateNotWorker,
  pausedLog, retryApprovedContext, retryDeclinedContext,
} from '../lib/text.js'
import { FABLE, W1, W2, fakeApi, hooksWith } from './helpers.js'

const NOW = 1_000_000
const typed = { midTurn: false, isCommand: false }
const T1 = { id: 1, title: 'Find callers', route: 'worker', model: 'haiku', effort: 'medium', reason: 'cheap search' }
const T2 = { id: 2, title: 'Fix refresh bug', route: 'worker', model: 'sonnet', effort: 'high', reason: 'small fix', after: [1] }
const T3 = { id: 3, title: 'Explain the fix', route: 'main', effort: 'low', reason: 'needs this chat' }
const tasks = () => [{ ...T1 }, { ...T2 }, { ...T3 }] as any[]

function running(access: any = 'off', plan: any = { tasks: tasks() }) {
  const s = new OrchestratorSession(access); s.turnOn(); s.proposePlan(plan); s.approve(plan)
  return s
}
// Launches the task and ends its worker with the outcome.
function ran(s: OrchestratorSession, id: number, agentId: string, outcome = 'answer') {
  const ok = s.checkSpawn(`[T${id}] x`, false) as any
  s.markLaunched(ok.task, `tu-${agentId}`); s.recordAgent(agentId, ok.task); s.workerFinished(agentId, outcome)
  return ok.task
}
// Tasks 1 and 2 ran, 2 failed, and a retry of 2 is on offer.
function offered(access: any = 'off') {
  const s = running(access); ran(s, 1, 'ag1'); ran(s, 2, 'ag2', 'error')
  s.proposeEscalation(2, 'worker crashed', NOW)
  return s
}

// --- The offer ---

test('an escalation offers the finished task one step stronger and waits for the user', async () => {
  const s = running(); ran(s, 1, 'ag1')
  const r: any = s.proposeEscalation(1, 'missed half the callers', NOW)
  expect(r.offer).toMatchObject({ id: 1, title: 'Find callers', reason: 'missed half the callers',
    from: { model: 'haiku', effort: 'medium' }, to: { route: 'worker', model: 'haiku', effort: 'high' } })
  expect(s.mode).toBe('pending')
  expect(s.statusText()).toBe('orchestrator on · retry pending (task 1)')
  expect(s.checkTool('Edit', false)).toEqual({ deny: DENY_PENDING })
  expect(s.checkSpawn('[T2] x', false)).toEqual({ deny: DENY_NO_PLAN })
})
test('an escalation is refused unless the task is a finished worker of the running plan', async () => {
  const s = running()
  expect(s.proposeEscalation(1, 'r', NOW)).toEqual({ deny: escalateNotFinished(1) })
  const ok = s.checkSpawn('[T1] x', false) as any; s.markLaunched(ok.task, 'tu1')
  expect(s.proposeEscalation(1, 'r', NOW)).toEqual({ deny: escalateNotFinished(1) })
  expect(s.proposeEscalation(3, 'r', NOW)).toEqual({ deny: escalateNotWorker(3) })
  expect(s.proposeEscalation(9, 'r', NOW)).toEqual({ deny: escalateNotWorker(9) })
  for (const [task, reason] of [['1', 'r'], [1.5, 'r'], [1, '  '], [1, undefined]] as any[])
    expect(s.proposeEscalation(task, reason, NOW)).toEqual({ deny: ESCALATE_BAD_INPUT })
  expect(s.mode).toBe('executing')
  const idle = new OrchestratorSession(); idle.turnOn()
  expect(idle.proposeEscalation(1, 'r', NOW)).toEqual({ deny: ESCALATE_NO_PLAN })
})
test('a second offer while one waits is refused', async () => {
  const s = offered()
  expect(s.proposeEscalation(1, 'also weak', NOW)).toEqual({ deny: DENY_PENDING })
})
test('with no stronger route left, the escalation is refused and points to a new plan', async () => {
  const s = running('off', { tasks: [{ ...T1, model: 'opus', effort: 'max' }] }); ran(s, 1, 'ag1')
  expect(s.proposeEscalation(1, 'still wrong', NOW)).toEqual({ deny: escalateNoStronger(1) })
  expect(s.mode).toBe('executing')
})
test('the offer steps onto Fable only where Fable is on offer', async () => {
  const top = () => ({ tasks: [{ ...T1, model: 'opus', effort: 'xhigh' }] })
  const off = running('off', top()); ran(off, 1, 'ag1')
  expect((off.proposeEscalation(1, 'r', NOW) as any).offer.to).toMatchObject({ model: 'opus', effort: 'max' })
  const included = running('included', top()); ran(included, 1, 'ag1')
  expect((included.proposeEscalation(1, 'r', NOW) as any).offer.to).toMatchObject({ model: 'fable', effort: 'high' })
})
test('the drawn offer names the task, both routes, the reason and the replies', async () => {
  const offer = { id: 2, title: 'Fix refresh bug', from: T2, to: { ...T2, model: 'opus', effort: 'medium' }, reason: 'worker crashed' } as any
  expect(renderOffer(offer, 'Opus')).toBe([
    'Retry task 2: Fix refresh bug',
    '   Sonnet · high → Opus · medium: worker crashed.',
    '',
    'Reply "OK" to retry, "no" to keep the result, or pick a route: "2. opus high"',
  ].join('\n'))
  expect(renderOffer({ ...offer, to: { ...FABLE, id: 2 }, reason: 'Still wrong!' }, 'Opus', true)).toContain('Sonnet · high → Fable · high (paid credits): Still wrong!')
})

// --- The reply ---

test('OK accepts the retry: the task may launch again on the stronger route, the rest keeps its progress', async () => {
  const s = offered()
  const action: any = s.handlePrompt('OK', typed, 'Opus', NOW)
  expect(action.log).toBe('Retrying task 2 on Opus · medium')
  expect(action.context).toBe(retryApprovedContext({ tasks: [T1, { ...T2, model: 'opus', effort: 'medium' }, T3] } as any, 2, [1]))
  expect(action.context).toContain('Retry approved: T2 worker opus/medium')
  expect(action.context).toContain('The rest of the plan stands: T3 main chat/low.')
  expect(s.mode).toBe('executing')
  expect(s.checkSpawn('[T1] x', false)).toEqual({ deny: denyTwice(1) })
  expect((s.checkSpawn('[T2] x', false) as any).task).toMatchObject({ id: 2, model: 'opus', effort: 'medium', reason: 'worker crashed' })
})
test('the retry can be approved on another route, with or without the task number', async () => {
  const numbered = offered()
  expect((numbered.handlePrompt('2. opus high', typed, 'Opus', NOW) as any).log).toBe('Retrying task 2 on Opus · high')
  const bare = offered()
  expect((bare.handlePrompt('opus xhigh', typed, 'Opus', NOW) as any).log).toBe('Retrying task 2 on Opus · xhigh')
  expect((bare.checkSpawn('[T2] x', false) as any).task).toMatchObject({ model: 'opus', effort: 'xhigh' })
  const main = offered()
  const action: any = main.handlePrompt('2 main', typed, 'Opus', NOW)
  expect(action.log).toBe('Retrying task 2 on Main chat (Opus · medium)')
  expect(action.context).toContain('Retry approved: T2 main chat/medium. Do it yourself now.')
})
test('"no" keeps the result: the plan carries on and counts the task as done', async () => {
  const s = offered()
  expect(s.handlePrompt('No, keep it', typed, 'Opus', NOW)).toEqual({ context: retryDeclinedContext(2), log: 'Keeping task 2 as it is' })
  expect(s.mode).toBe('executing')
  expect(s.checkSpawn('[T2] x', false)).toEqual({ deny: denyTwice(2) })
  expect(s.completeMainTurn('answer')).toBeUndefined()
  expect(s.mode).toBe('idle')
})
test('any other reply leaves the offer open; a reply typed mid-turn is dropped', async () => {
  const s = offered()
  expect(s.handlePrompt('why did it crash?', typed, 'Opus', NOW)).toEqual({ context: RETRY_REPLY_CONTEXT })
  expect(s.handlePrompt('1. opus high', typed, 'Opus', NOW)).toEqual({ context: RETRY_REPLY_CONTEXT })
  expect(s.handlePrompt('OK', { midTurn: true, isCommand: false }, 'Opus', NOW)).toEqual({ drop: DROP_STILL_WORKING })
  expect(s.mode).toBe('pending')
  expect(s.statusText()).toBe('orchestrator on · retry pending (task 2)')
})
test('with Fable off, a retry edited to Fable is dropped and the offer stays open', async () => {
  const s = offered()
  expect(s.handlePrompt('2. fable', typed, 'Opus', NOW)).toEqual({ drop: DROP_FABLE_OFF })
  expect(s.mode).toBe('pending')
})
test('a new plan replaces a waiting offer', async () => {
  const s = offered()
  const next = { tasks: [{ ...T1 }] } as any
  s.proposePlan(next)
  expect(s.statusText()).toBe('orchestrator on · plan pending (1 task)')
  expect((s.handlePrompt('OK', typed, 'Opus', NOW) as any).log).toBe('Starting: plan as shown (1 task)')
})

// --- After the reply ---

test('the retried worker is logged against the route that was offered', async () => {
  const s = offered(); s.handlePrompt('2. opus high', typed, 'Opus', NOW)
  ran(s, 2, 'ag3')
  expect(s.agentRecord('ag3')).toMatchObject({ task: { model: 'opus', effort: 'high' }, recommended: { model: 'opus', effort: 'medium' } })
  expect(s.agentRecord('ag2')).toMatchObject({ task: { model: 'sonnet', effort: 'high' }, recommended: { model: 'sonnet', effort: 'high' } })
})
test('a late end of the first attempt does not count as the retry finishing', async () => {
  const s = offered(); s.handlePrompt('OK', typed, 'Opus', NOW)
  s.workerFinished('ag2', 'answer')
  expect(s.launchReturned('tu-ag2', false)).toBeUndefined()
  expect(s.completeMainTurn('answer')).toBe(pausedLog(1, 2))
})
test('a retry is worth hinting at for a failed worker with a stronger route left, and only then', async () => {
  const s = running(); ran(s, 1, 'ag1', 'error')
  expect(s.canEscalate(1, NOW)).toBe(true)
  ran(s, 2, 'ag2', 'aborted')
  expect(s.canEscalate(2, NOW)).toBe(false)
  expect(s.canEscalate(3, NOW)).toBe(false)
  expect(s.canEscalate(9, NOW)).toBe(false)
  const fine = running(); ran(fine, 1, 'ag1')
  expect(fine.canEscalate(1, NOW)).toBe(false)
  const refused = running(); ran(refused, 1, 'ag1', 'refusal')
  expect(refused.canEscalate(1, NOW)).toBe(true)
  const top = running('off', { tasks: [{ ...T1, model: 'opus', effort: 'max' }] }); ran(top, 1, 'ag1', 'error')
  expect(top.canEscalate(1, NOW)).toBe(false)
})

// --- Through the real hooks ---

const ON = { command: 'efficient-model-orchestrator-on' }
const PLAN_TOOL = { tool: 'mcp__efficient-model-orchestrator__plan' }
const ESCALATE = { tool: 'mcp__efficient-model-orchestrator__escalate' }
const AGENT = { tool: 'Agent' }
const ROW = { component: 'ToolUse' }
const pass = async (e: any) => e
const startedAs = (agentId: string) => async (e: any) => ({ model: e.model, agentId })
const spawnInput = (description: string, id: string) => ({ description, fork: false, tool_use_id: id })

// A two-worker plan approved, task 1 launched as ag1 through Agent call tu1.
async function firstWorkerLaunched(options: unknown = {}, first: any = W1) {
  const hook = hooksWith(register, options)
  const $: any = fakeApi()
  await hook('command.run', ON)($, {})
  await hook('tool.call', PLAN_TOOL)($, { tasks: [first, W2] })
  await hook('prompt.submit')($, { text: 'OK' }, pass)
  await hook('agent.spawn')($, spawnInput('[T1] x', 'tu1'), startedAs('ag1'))
  return { hook, $ }
}
const workerEnds = (hook: any, $: any, reason: string) => hook('turn.complete')($, { agentId: 'ag1', reason, durationMs: 1 }, pass)
const agentReturns = (hook: any, $: any, result: object) => hook('tool.call', AGENT)($, { description: '[T1] x', tool_use_id: 'tu1' }, async () => result)
const escalateRow = (id: string, isErrored = false) => ({ props: { tool: ESCALATE.tool, tool_use_id: id, input: { task: 1, reason: 'crashed on a big file' }, isErrored } })

test('session start registers the escalate tool, and the plan tool last', async () => {
  const $: any = fakeApi()
  await hooksWith(register, {})('session.start')($, {}, pass)
  expect($.registered.map((spec: any) => spec.name)).toEqual(['escalate', 'plan'])
  expect($.registered[0].inputSchema.required).toEqual(['task', 'reason'])
})
test('the escalate tool is never deferred behind tool search', async () => {
  const described = await hooksWith(register, {})('tool.describe', ESCALATE)(fakeApi(), {}, async () => ({ isDeferred: true, description: 'd' }))
  expect(described).toEqual({ isDeferred: false, description: 'd' })
})
test('the escalate tool shows the offer, and its row draws it', async () => {
  const { hook, $ } = await firstWorkerLaunched()
  await workerEnds(hook, $, 'error')
  const result = await hook('tool.call', ESCALATE)($, { task: 1, reason: 'crashed on a big file', tool_use_id: 'tuE' })
  expect(result).toEqual({ result: ESCALATE_SHOWN })
  await hook('ui.render', ROW)($, escalateRow('tuE'), pass)
  expect($.drawn).toEqual([
    'Retry task 1: Find callers',
    '   Haiku · medium → Haiku · high: crashed on a big file.',
    ' ',
    'Reply "OK" to retry, "no" to keep the result, or pick a route: "1. opus high"',
  ])
})
test('an escalate row with no offer behind it, or a refused one, is drawn by Claude Code', async () => {
  const { hook, $ } = await firstWorkerLaunched()
  await workerEnds(hook, $, 'error')
  await hook('tool.call', ESCALATE)($, { task: 1, reason: 'crashed on a big file', tool_use_id: 'tuE' })
  const fallback = async () => 'drawn by Claude Code'
  expect(await hook('ui.render', ROW)($, escalateRow('tu-other'), fallback)).toBe('drawn by Claude Code')
  expect(await hook('ui.render', ROW)($, escalateRow('tuE', true), fallback)).toBe('drawn by Claude Code')
  expect($.drawn).toEqual([])
})
test('the escalate tool is refused when the orchestrator is off, for a worker, and for a task that cannot be retried', async () => {
  const off = hooksWith(register, {})
  expect(await off('tool.call', ESCALATE)(fakeApi(), { task: 1, reason: 'r' })).toEqual({ deny: ESCALATE_OFF })
  const { hook, $ } = await firstWorkerLaunched()
  expect(await hook('tool.call', ESCALATE)($, { task: 1, reason: 'r', agentId: 'ag1' })).toEqual({ deny: PLAN_WORKER })
  expect(await hook('tool.call', ESCALATE)($, { task: 1, reason: 'r' })).toEqual({ deny: escalateNotFinished(1) })
})
test('OK to the offer lets the task launch again, on the stronger route and effort', async () => {
  const { hook, $ } = await firstWorkerLaunched()
  await workerEnds(hook, $, 'error')
  await hook('tool.call', ESCALATE)($, { task: 1, reason: 'crashed on a big file', tool_use_id: 'tuE' })
  let sent: any
  await hook('prompt.submit')($, { text: 'ok' }, async (e: any) => { sent = e; return e })
  expect($.logs.at(-1)).toBe('Retrying task 1 on Haiku · high')
  expect(sent.context[0]).toContain('Retry approved: T1 worker haiku/high')
  expect((await hook('agent.spawn')($, spawnInput('[T1] again', 'tu2'), startedAs('ag9'))).model).toBe('haiku')
  let effort: unknown
  const stream = hook('turn.step')($, { agentId: 'ag9' }, async function* (e: any) { effort = e.effort; return {} })
  let step = await stream.next()
  while (step.done !== true) step = await stream.next()
  expect(effort).toBe('high')
})
test('a worker that failed comes back to Claude with a hint to offer a retry', async () => {
  const failedTurn = await firstWorkerLaunched()
  await workerEnds(failedTurn.hook, failedTurn.$, 'error')
  expect((await agentReturns(failedTurn.hook, failedTurn.$, { result: 'partial' })).context).toEqual([escalateHint(1)])
  const failedCall = await firstWorkerLaunched()
  expect((await agentReturns(failedCall.hook, failedCall.$, { isError: true, result: 'crashed', context: ['kept'] })).context).toEqual(['kept', escalateHint(1)])
})
test('no hint for a worker that answered, was interrupted, or has no stronger route', async () => {
  const fine = await firstWorkerLaunched()
  await workerEnds(fine.hook, fine.$, 'answer')
  expect(await agentReturns(fine.hook, fine.$, { result: 'done' })).toEqual({ result: 'done' })
  const stopped = await firstWorkerLaunched()
  await workerEnds(stopped.hook, stopped.$, 'aborted')
  expect(await agentReturns(stopped.hook, stopped.$, { result: 'cut off' })).toEqual({ result: 'cut off' })
  const top = await firstWorkerLaunched({}, { ...W1, model: 'opus', effort: 'max' })
  await workerEnds(top.hook, top.$, 'error')
  expect(await agentReturns(top.hook, top.$, { result: 'partial' })).toEqual({ result: 'partial' })
})
test('a Fable worker out of credits gets the Fable note, not a retry hint', async () => {
  const { hook, $ } = await firstWorkerLaunched({ fable: 'included' }, FABLE)
  const dead = { isError: true, text: 'Agent terminated early due to an API error: Fable 5.1 requires usage credits.' }
  expect((await agentReturns(hook, $, dead)).context).toEqual([FABLE_BLOCKED_NOTE])
})
