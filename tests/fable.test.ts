import { expect, test } from 'claude-code/testing'
import { register } from '../hooks/register.js'
import { renderPlan, routeLabel, validatePlan } from '../lib/plan.js'
import { parseReply, startingLine } from '../lib/reply.js'
import { OrchestratorSession, fableAccessFrom, isFableCreditsFailure } from '../lib/session.js'
import { DROP_FABLE_OFF, FABLE_BLOCKED_LOG, FABLE_BLOCKED_NOTE, PLAN_SHOWN, fullBriefing, planInvalid, planToolSchema } from '../lib/text.js'
import { FABLE, W1, fakeApi, hooksWith, propose, setup, turnOn } from './helpers.js'

const NOW = 1_000_000
const WEEK = 7 * 24 * 60 * 60 * 1000
const typed = { midTurn: false, isCommand: false }
const session = (access: any) => { const s = new OrchestratorSession(access); s.turnOn(); return s }
const PLAN = { tasks: [W1] } as any

// --- The setting ---

test('the setting: included and credits pass through, anything else is off', async () => {
  expect(fableAccessFrom({ fable: 'included' })).toBe('included')
  expect(fableAccessFrom({ fable: 'credits' })).toBe('credits')
  for (const options of [{ fable: 'off' }, { fable: 'yes' }, {}, undefined]) expect(fableAccessFrom(options)).toBe('off')
})
test('off by default: Fable is neither allowed nor offered in the briefing', async () => {
  const s = session(undefined)
  expect(s.allowedModels(NOW)).toEqual(['haiku', 'sonnet', 'opus'])
  expect(s.handlePrompt('fix it', typed, 'Opus', NOW)).toEqual({ context: fullBriefing('none') })
})
test('included and credits offer Fable, each with its own briefing', async () => {
  expect(session('included').allowedModels(NOW)).toEqual(['haiku', 'sonnet', 'opus', 'fable'])
  expect(session('included').handlePrompt('fix it', typed, 'Opus', NOW)).toEqual({ context: fullBriefing('included') })
  expect(session('credits').handlePrompt('fix it', typed, 'Opus', NOW)).toEqual({ context: fullBriefing('credits') })
})
test('the briefing only mentions paying under credits, and forbids Fable when it is unavailable', async () => {
  expect(fullBriefing('included')).toContain('fable high')
  expect(fullBriefing('included')).not.toContain('paid')
  expect(fullBriefing('credits')).toContain('paid usage credits')
  expect(fullBriefing('none')).toContain('never propose it')
  expect(fullBriefing('none')).not.toContain('fable high')
})

// --- Labels ---

test('only the credits setting labels Fable as paid, and only Fable', async () => {
  expect(routeLabel(FABLE as any, 'Opus')).toBe('Fable · high')
  expect(routeLabel(FABLE as any, 'Opus', true)).toBe('Fable · high (paid credits)')
  expect(routeLabel(W1 as any, 'Opus', true)).toBe('Haiku · medium')
  expect(renderPlan({ tasks: [FABLE] } as any, 'Opus', true)).toContain('Fable · high (paid credits): hardest problem.')
  const r: any = parseReply('1. fable high', PLAN)
  expect(startingLine(r.plan, r.edits, 'Opus', true)).toBe('Starting: 1 → Fable · high (paid credits)')
})
test('validatePlan refuses a model outside the allowed list, and allows all by default', async () => {
  expect(validatePlan({ tasks: [FABLE] }).ok).toBe(true)
  expect(validatePlan({ tasks: [FABLE] }, ['haiku', 'sonnet', 'opus'])).toEqual({ ok: false, error: 'task 1: model must be one of haiku, sonnet, opus' })
})
test('the plan tool schema lists only the allowed models', async () => {
  const models = (planToolSchema(['haiku', 'opus']) as any).properties.tasks.items.properties.model.enum
  expect(models).toEqual(['haiku', 'opus'])
})

// --- Editing a plan to Fable ---

test('with Fable off, an edit to Fable is dropped with a reason and the plan stays pending', async () => {
  const s = session('off'); s.proposePlan(PLAN)
  expect(s.handlePrompt('1. fable high', typed, 'Opus', NOW)).toEqual({ drop: DROP_FABLE_OFF })
  expect(s.mode).toBe('pending')
})
test('a learned block stops proposals, but your own edit to Fable still goes through', async () => {
  const s = session('included'); s.blockFable(NOW); s.proposePlan(PLAN)
  const action: any = s.handlePrompt('1. fable high', typed, 'Opus', NOW)
  expect(action.log).toBe('Starting: 1 → Fable · high')
  expect(s.mode).toBe('executing')
})

test('"stronger" never steps a task onto Fable while Fable is off or blocked', async () => {
  const top = { tasks: [{ ...W1, model: 'opus', effort: 'xhigh' }] } as any
  const off = session('off'); off.proposePlan(top)
  expect((off.handlePrompt('1 stronger', typed, 'Opus', NOW) as any).log).toBe('Starting: 1 → Opus · max')
  expect(off.mode).toBe('executing')
  const blocked = session('included'); blocked.blockFable(NOW); blocked.proposePlan(top)
  expect((blocked.handlePrompt('1 stronger', typed, 'Opus', NOW) as any).log).toBe('Starting: 1 → Opus · max')
  const open = session('included'); open.proposePlan(top)
  expect((open.handlePrompt('1 stronger', typed, 'Opus', NOW) as any).log).toBe('Starting: 1 → Fable · high')
})

// --- Learning ---

test('a learned block lasts 7 days and takes Fable out of the allowed models', async () => {
  const s = session('included')
  expect(s.blockFable(NOW)).toEqual({ until: NOW + WEEK, setting: 'included' })
  expect(s.allowedModels(NOW)).toEqual(['haiku', 'sonnet', 'opus'])
  expect(s.handlePrompt('fix it', typed, 'Opus', NOW)).toEqual({ context: fullBriefing('none') })
  expect(s.allowedModels(NOW + WEEK)).toEqual(['haiku', 'sonnet', 'opus', 'fable'])
})
test('a saved block applies only if it is unexpired and from the same setting', async () => {
  const restored = (saved: unknown) => { const s = session('included'); s.restoreFableBlock(saved, NOW); return s.allowedModels(NOW).includes('fable') }
  expect(restored({ until: NOW + 1, setting: 'included' })).toBe(false)
  expect(restored({ until: NOW - 1, setting: 'included' })).toBe(true)
  expect(restored({ until: NOW + 1, setting: 'credits' })).toBe(true)
  for (const junk of [undefined, null, 'x', { until: 'soon', setting: 'included' }]) expect(restored(junk)).toBe(true)
})
test('clearing a block says whether there was one', async () => {
  const s = session('included')
  expect(s.clearFableBlock()).toBe(false)
  s.blockFable(NOW)
  expect(s.clearFableBlock()).toBe(true)
  expect(s.allowedModels(NOW)).toContain('fable')
})
test('isFableCreditsFailure: only an error result mentioning usage credits', async () => {
  const dead = 'Agent terminated early due to an API error: Fable 5.1 requires usage credits. Switch to another model.'
  expect(isFableCreditsFailure({ isError: true, text: dead })).toBe(true)
  expect(isFableCreditsFailure({ deny: dead })).toBe(true)
  expect(isFableCreditsFailure({ text: 'The report explains usage credits.' })).toBe(false)
  expect(isFableCreditsFailure({ isError: true, text: 'Overloaded' })).toBe(false)
  expect(isFableCreditsFailure({ deny: 'Orchestrator: no approved plan.' })).toBe(false)
})
test('isFableCreditsFailure reads a failed result wherever its message sits, and only a failed one', async () => {
  const dead = 'Agent terminated early due to an API error: Fable 5.1 requires usage credits.'
  expect(isFableCreditsFailure({ isError: true, result: dead } as any)).toBe(true)
  expect(isFableCreditsFailure({ isError: true, result: { content: [{ type: 'text', text: dead }] } } as any)).toBe(true)
  expect(isFableCreditsFailure({ result: dead } as any)).toBe(false)
  expect(isFableCreditsFailure({ result: { content: [{ type: 'text', text: dead }] } } as any)).toBe(false)
  const loop: any = {}; loop.self = loop
  expect(isFableCreditsFailure({ isError: true, result: loop } as any)).toBe(false)
})
test('isFableTask: a tagged worker task on Fable in the approved plan', async () => {
  const s = session('included'); const plan = { tasks: [{ ...FABLE, id: 1 }, { ...W1, id: 2 }] } as any
  expect(s.isFableTask('[T1] x')).toBe(false)
  s.proposePlan(plan); s.approve(plan)
  expect(s.isFableTask('[T1] x')).toBe(true)
  expect(s.isFableTask('[T2] x')).toBe(false)
  expect(s.isFableTask('no tag')).toBe(false)
})

// --- Wiring, through the real hooks ---

const ON = { command: 'efficient-model-orchestrator-on' }
const PLAN_TOOL = { tool: 'mcp__efficient-model-orchestrator__plan' }
const pass = async (e: any) => e
const started = async (e: any) => ({ model: e.model, agentId: 'ag1' })
const DEAD = { isError: true, text: 'Agent terminated early due to an API error: Fable 5.1 requires usage credits.' }

async function fableWorkerRunning($: any, hook: any) {
  await hook('command.run', ON)($, {})
  expect((await hook('tool.call', PLAN_TOOL)($, { tasks: [FABLE] })).result).toBe(PLAN_SHOWN)
  await hook('prompt.submit')($, { text: 'OK' }, pass)
  expect((await hook('agent.spawn')($, { description: '[T1] x', fork: false }, started)).model).toBe('fable')
}

test('off through the kit: a plan with Fable is refused and nothing goes pending', async ($, on) => {
  const { statuses } = await setup($, on)
  await turnOn($)
  expect((await propose($, [FABLE])).deny).toBe(planInvalid('task 1: model must be one of haiku, sonnet, opus'))
  expect(statuses.at(-1)).toBe('orchestrator on')
})
test('off: the plan tool schema leaves Fable out', async () => {
  let schema: any
  const hook = hooksWith(register, {})
  const api: any = { tool: { register: async (spec: any) => { schema = spec.inputSchema } }, command: { register: async () => {} } }
  await hook('session.start')(api, {}, pass)
  expect(schema.properties.tasks.items.properties.model.enum).toEqual(['haiku', 'sonnet', 'opus'])
})
test('credits: the drawn plan labels Fable as paid', async () => {
  const hook = hooksWith(register, { fable: 'credits' })
  const $ = fakeApi()
  const row = { props: { tool: PLAN_TOOL.tool, input: { tasks: [FABLE] }, isErrored: false } }
  await hook('ui.render', { component: 'ToolUse' })($, row, pass)
  expect($.drawn).toContain('   Fable · high (paid credits): hardest problem.')
})
test('a Fable worker failing on credits is learned: saved, shown, told to Claude, and refused next time', async () => {
  const hook = hooksWith(register, { fable: 'included' })
  const $: any = fakeApi()
  await fableWorkerRunning($, hook)
  const result = await hook('tool.call', { tool: 'Agent' })($, { description: '[T1] x' }, async () => DEAD)
  expect(result.context).toEqual([FABLE_BLOCKED_NOTE])
  expect($.logs).toContain(FABLE_BLOCKED_LOG)
  expect(($.saved.get('fable-block') as any).setting).toBe('included')
  expect((await hook('tool.call', PLAN_TOOL)($, { tasks: [FABLE] })).deny).toBe(planInvalid('task 1: model must be one of haiku, sonnet, opus'))
})
test('another worker failing, or Fable failing for another reason, teaches nothing', async () => {
  const hook = hooksWith(register, { fable: 'included' })
  const $: any = fakeApi()
  await fableWorkerRunning($, hook)
  const agent = hook('tool.call', { tool: 'Agent' })
  await agent($, { description: '[T1] x' }, async () => ({ isError: true, text: 'Overloaded' }))
  await agent($, { description: '[T9] x' }, async () => DEAD)
  expect($.saved.has('fable-block')).toBe(false)
})
test('/on restores a saved block, so Fable stays out in a new session', async () => {
  const hook = hooksWith(register, { fable: 'included' })
  const $: any = fakeApi()
  $.saved.set('fable-block', { until: Date.now() + 60_000, setting: 'included' })
  await hook('command.run', ON)($, {})
  expect((await hook('tool.call', PLAN_TOOL)($, { tasks: [FABLE] })).deny).toBe(planInvalid('task 1: model must be one of haiku, sonnet, opus'))
})
test('a Fable worker that answers clears a saved block', async () => {
  const hook = hooksWith(register, { fable: 'included' })
  const $: any = fakeApi()
  await fableWorkerRunning($, hook)
  await hook('tool.call', { tool: 'Agent' })($, { description: '[T1] x' }, async () => DEAD)
  await hook('turn.complete')($, { agentId: 'ag1', reason: 'answer', durationMs: 1 }, pass)
  expect($.saved.has('fable-block')).toBe(false)
  expect((await hook('tool.call', PLAN_TOOL)($, { tasks: [FABLE] })).result).toBe(PLAN_SHOWN)
})

// --- The plan tool follows what is learned ---

const offersFable = ($: any) => $.registered.filter((spec: any) => spec.name === 'plan').at(-1).inputSchema.properties.tasks.items.properties.model.enum.includes('fable')
test('the plan tool stops listing Fable once a block is learned, and lists it again once Fable answers', async () => {
  const hook = hooksWith(register, { fable: 'included' })
  const $: any = fakeApi()
  await hook('session.start')($, {}, pass)
  expect(offersFable($)).toBe(true)
  await fableWorkerRunning($, hook)
  await hook('tool.call', { tool: 'Agent' })($, { description: '[T1] x' }, async () => DEAD)
  expect(offersFable($)).toBe(false)
  await hook('turn.complete')($, { agentId: 'ag1', reason: 'answer', durationMs: 1 }, pass)
  expect(offersFable($)).toBe(true)
})
test('/on with a saved block takes Fable out of the plan tool', async () => {
  const hook = hooksWith(register, { fable: 'included' })
  const $: any = fakeApi()
  $.saved.set('fable-block', { until: Date.now() + 60_000, setting: 'included' })
  await hook('session.start')($, {}, pass)
  expect(offersFable($)).toBe(true)
  await hook('command.run', ON)($, {})
  expect(offersFable($)).toBe(false)
})
