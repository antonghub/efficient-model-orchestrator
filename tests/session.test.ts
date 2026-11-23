import { expect, test } from 'claude-code/testing'
import { OrchestratorSession } from '../lib/session.js'
import {
  DENY_PENDING, DENY_PLAN_FIRST, DENY_NO_PLAN, DENY_NO_TAG, DENY_FORK, DENY_NESTED, DROP_STILL_WORKING, MIDTURN_NOTE, SHORT_REMINDER,
  approvedContext, fullBriefing, denyNotWorker, denyTwice, denyWaits, pausedLog, resumedContext, resumedLog,
} from '../lib/text.js'

const plan = { tasks: [
  { id: 1, title: 'a', route: 'worker', model: 'haiku', effort: 'medium', reason: 'r' },
  { id: 2, title: 'b', route: 'main', effort: 'high', reason: 'r' },
  { id: 3, title: 'c', route: 'main', effort: 'low', reason: 'r' },
] } as any
const on = () => { const s = new OrchestratorSession(); s.turnOn(); return s }

test('off allows everything', async () => {
  const s = new OrchestratorSession()
  expect(s.checkTool('Edit', false)).toEqual({ allow: true })
  expect(s.statusText()).toBeUndefined()
})
test('full briefing once, again after compaction', async () => {
  const s = on()
  expect(s.beginRequest()).toBe('full'); expect(s.beginRequest()).toBe('short')
  s.markCompacted(); expect(s.beginRequest()).toBe('full')
  s.turnOff(); s.turnOn(); expect(s.beginRequest()).toBe('full')
})
test('planning allows 3 read-only looks, never Agent/WebFetch/WebSearch, resets per request', async () => {
  const s = on(); s.beginRequest()
  expect(s.checkTool('WebSearch', true)).toEqual({ deny: DENY_PLAN_FIRST })
  for (let i = 0; i < 3; i++) expect(s.checkTool('Read', true)).toEqual({ allow: true })
  expect(s.checkTool('Read', true)).toEqual({ deny: DENY_PLAN_FIRST })
  expect(s.checkTool('Edit', false)).toEqual({ deny: DENY_PLAN_FIRST })
  s.beginRequest(); expect(s.checkTool('Grep', true)).toEqual({ allow: true })
})
test('Agent passes checkTool (agent.spawn decides); subagent calls are never gated', async () => {
  const s = on(); s.beginRequest()
  expect(s.checkTool('Agent', true)).toEqual({ allow: true })
  expect(s.checkTool('Edit', false, 'agent-1')).toEqual({ allow: true })
})
test('pending denies every tool; executing allows', async () => {
  const s = on(); s.proposePlan(plan)
  expect(s.checkTool('Read', true)).toEqual({ deny: DENY_PENDING })
  expect(s.statusText()).toBe('orchestrator on · plan pending (3 tasks)')
  s.approve(plan)
  expect(s.checkTool('Edit', false)).toEqual({ allow: true })
  expect(s.statusText()).toBe('orchestrator on · 0/1 workers done')
})
test('spawn rules', async () => {
  const s = on(); s.beginRequest()
  expect(s.checkSpawn('[T1] a', false)).toEqual({ deny: DENY_NO_PLAN })
  s.proposePlan(plan); expect(s.checkSpawn('[T1] a', false)).toEqual({ deny: DENY_NO_PLAN })
  s.approve(plan)
  expect(s.checkSpawn('find stuff', false)).toEqual({ deny: DENY_NO_TAG })
  expect(s.checkSpawn('[T2] b', false)).toEqual({ deny: denyNotWorker(2) })
  expect(s.checkSpawn('[T9] z', false)).toEqual({ deny: denyNotWorker(9) })
  expect(s.checkSpawn('[T1] a', true)).toEqual({ deny: DENY_FORK })
  expect(s.checkSpawn('[T1] a', false, 'agent-0')).toEqual({ deny: DENY_NESTED })
  const ok = s.checkSpawn('[T1] a', false) as any
  expect(ok.task).toMatchObject({ id: 1, model: 'haiku', effort: 'medium' })
  s.recordAgent('agent-1', ok.task)
  expect(s.checkSpawn('[T1] again', false)).toEqual({ deny: denyTwice(1) })
})
test('efforts: worker by agent id, main = highest main-task effort while executing', async () => {
  const s = on(); s.proposePlan(plan); s.approve(plan)
  s.recordAgent('agent-1', plan.tasks[0])
  expect(s.effortFor('agent-1')).toBe('medium')
  expect(s.effortFor(undefined)).toBe('high')
  expect(s.effortFor('agent-unknown')).toBeUndefined()
  s.workerFinished('agent-1', 'answer')
  expect(s.completeMainTurn()).toBeUndefined()
  expect(s.mode).toBe('idle')
  expect(s.effortFor(undefined)).toBeUndefined()
  expect(s.effortFor('agent-1')).toBe('medium')
})
test('all-main plan: approval executes, every spawn refused', async () => {
  const s = on(); const allMain = { tasks: [plan.tasks[1]] }
  s.proposePlan(allMain); s.approve(allMain)
  expect(s.mode).toBe('executing')
  expect(s.checkSpawn('[T2] b', false)).toEqual({ deny: denyNotWorker(2) })
  expect(s.effortFor(undefined)).toBe('high')
})
test('a new plan while executing goes back to pending', async () => {
  const s = on(); s.proposePlan(plan); s.approve(plan); s.proposePlan(plan)
  expect(s.mode).toBe('pending')
})
test('agent record keeps the recommended task even after a new plan', async () => {
  const s = on(); s.proposePlan(plan)
  const edited = { tasks: [{ ...plan.tasks[0], model: 'sonnet', effort: 'high' }, plan.tasks[1], plan.tasks[2]] }
  s.approve(edited)
  const ok = s.checkSpawn('[T1] a', false) as any
  s.recordAgent('agent-1', ok.task)
  s.completeMainTurn()
  s.proposePlan({ tasks: [{ ...plan.tasks[0], title: 'other' }] })
  expect(s.agentRecord('agent-1')).toEqual({ task: edited.tasks[0], recommended: plan.tasks[0] })
  expect(s.effortFor('agent-1')).toBe('high')
})

const typed = { midTurn: false, isCommand: false }
test('a reply typed while the planning turn is still running is dropped; the plan stays pending', async () => {
  const s = on(); s.proposePlan(plan)
  expect(s.handlePrompt('OK', { midTurn: true, isCommand: false }, 'Opus')).toEqual({ drop: DROP_STILL_WORKING })
  expect(s.mode).toBe('pending')
})
test('a prompt typed during execution gets a note and keeps the plan running', async () => {
  const s = on(); s.proposePlan(plan); s.approve(plan)
  expect(s.handlePrompt('also fix the docs', { midTurn: true, isCommand: false }, 'Opus')).toEqual({ context: MIDTURN_NOTE })
  expect(s.mode).toBe('executing')
  expect(s.effortFor(undefined)).toBe('high')
})
test('a prompt typed while planning passes through and does not reset the looks', async () => {
  const s = on(); s.beginRequest()
  for (let i = 0; i < 3; i++) s.checkTool('Read', true)
  expect(s.handlePrompt('more info', { midTurn: true, isCommand: false }, 'Opus')).toEqual({ pass: true })
  expect(s.checkTool('Read', true)).toEqual({ deny: DENY_PLAN_FIRST })
})
test('slash commands pass through and do not use up the full briefing', async () => {
  const s = on()
  expect(s.handlePrompt('/model opus', { midTurn: false, isCommand: true }, 'Opus')).toEqual({ pass: true })
  expect(s.handlePrompt('fix it', typed, 'Opus')).toEqual({ context: fullBriefing('none') })
})
test('OK approves through handlePrompt with a starting line', async () => {
  const s = on(); s.proposePlan(plan)
  expect(s.handlePrompt('OK', typed, 'Opus')).toEqual({ context: approvedContext(plan), log: 'Starting: plan as shown (3 tasks)' })
  expect(s.mode).toBe('executing')
})
test('a nested spawn is refused as nested even with no plan', async () => {
  const s = on()
  expect(s.checkSpawn('[T1] a', false, 'agent-0')).toEqual({ deny: DENY_NESTED })
})
const FREE = ['ToolSearch', 'Skill', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'AskUserQuestion', 'ReadNotifications',
  'mcp__ccd_turn__update_plan', 'mcp__ccd_turn__wrap_up', 'mcp__efficient-model-orchestrator__plan', 'mcp__efficient-model-orchestrator__escalate']
test('bookkeeping tools are free while planning and never count as a look', async () => {
  const s = on(); s.beginRequest()
  for (const tool of FREE) expect(s.checkTool(tool, false)).toEqual({ allow: true })
  for (let i = 0; i < 3; i++) expect(s.checkTool('Read', true)).toEqual({ allow: true })
  expect(s.checkTool('Read', true)).toEqual({ deny: DENY_PLAN_FIRST })
  for (const tool of FREE) expect(s.checkTool(tool, false)).toEqual({ allow: true })
})
test('bookkeeping tools stay free while a plan waits; real work does not', async () => {
  const s = on(); s.proposePlan(plan)
  for (const tool of FREE) expect(s.checkTool(tool, false)).toEqual({ allow: true })
  expect(s.checkTool('Bash', false)).toEqual({ deny: DENY_PENDING })
})
test('a slash command that starts a turn gets fresh looks', async () => {
  const s = on(); s.beginRequest()
  for (let i = 0; i < 3; i++) s.checkTool('Read', true)
  expect(s.handlePrompt('/review', { midTurn: false, isCommand: true }, 'Opus')).toEqual({ pass: true })
  expect(s.checkTool('Read', true)).toEqual({ allow: true })
})
test('a slash command typed while a turn runs does not reset the looks', async () => {
  const s = on(); s.beginRequest()
  for (let i = 0; i < 3; i++) s.checkTool('Read', true)
  expect(s.handlePrompt('/model opus', { midTurn: true, isCommand: true }, 'Opus')).toEqual({ pass: true })
  expect(s.checkTool('Read', true)).toEqual({ deny: DENY_PLAN_FIRST })
})
test('beginTurn gives a turn the app started fresh looks, and keeps the full briefing for the user', async () => {
  const s = on()
  for (let i = 0; i < 3; i++) s.checkTool('Read', true)
  s.beginTurn()
  expect(s.checkTool('Read', true)).toEqual({ allow: true })
  expect(s.handlePrompt('fix it', typed, 'Opus')).toEqual({ context: fullBriefing('none') })
})
test('ToolSearch is always allowed while planning and never counts as a look', async () => {
  const s = on(); s.beginRequest()
  for (let i = 0; i < 5; i++) expect(s.checkTool('ToolSearch', true)).toEqual({ allow: true })
  for (let i = 0; i < 3; i++) expect(s.checkTool('Read', true)).toEqual({ allow: true })
  expect(s.checkTool('Read', true)).toEqual({ deny: DENY_PLAN_FIRST })
})

// --- Launch bookkeeping and task order ---

const chain = () => ({ tasks: [
  { id: 1, title: 'a', route: 'worker', model: 'haiku', effort: 'medium', reason: 'r' },
  { id: 2, title: 'b', route: 'worker', model: 'sonnet', effort: 'high', reason: 'r', after: [1] },
  { id: 3, title: 'c', route: 'main', effort: 'low', reason: 'r' },
  { id: 4, title: 'd', route: 'worker', model: 'opus', effort: 'high', reason: 'r', after: [3] },
  { id: 5, title: 'e', route: 'worker', model: 'opus', effort: 'high', reason: 'r', after: [1, 2] },
] }) as any
const running = (p = chain()) => { const s = on(); s.proposePlan(p); s.approve(p); return s }
const launch = (s: OrchestratorSession, id: number, agentId: string) => {
  const ok = s.checkSpawn(`[T${id}] x`, false) as any
  s.markLaunched(ok.task, `tu-${agentId}`); s.recordAgent(agentId, ok.task)
  return ok.task
}

test('a launch counts from the moment it is accepted, before the worker has an id', async () => {
  const s = running()
  const ok = s.checkSpawn('[T1] a', false) as any
  s.markLaunched(ok.task, 'tu1')
  expect(s.checkSpawn('[T1] again', false)).toEqual({ deny: denyTwice(1) })
  expect(s.effortFor('agent-not-recorded-yet')).toBe('medium')
  s.recordAgent('ag1', ok.task)
  expect(s.effortFor('ag1')).toBe('medium')
  expect(s.effortFor('agent-unknown')).toBeUndefined()
})
test('a launch that did not start can be tried again', async () => {
  const s = running()
  const ok = s.checkSpawn('[T1] a', false) as any
  s.markLaunched(ok.task, 'tu1'); s.unmarkLaunched(1)
  expect(s.effortFor('agent-unknown')).toBeUndefined()
  expect(s.checkSpawn('[T1] a', false)).toEqual({ task: ok.task })
})
test('a task waits for the worker tasks named in its after list', async () => {
  const s = running()
  expect(s.checkSpawn('[T2] b', false)).toEqual({ deny: denyWaits(2, [1]) })
  expect(s.checkSpawn('[T5] e', false)).toEqual({ deny: denyWaits(5, [1, 2]) })
  launch(s, 1, 'ag1')
  expect(s.checkSpawn('[T2] b', false)).toEqual({ deny: denyWaits(2, [1]) })
  s.workerFinished('ag1', 'answer')
  expect((s.checkSpawn('[T2] b', false) as any).task.id).toBe(2)
  expect(s.checkSpawn('[T5] e', false)).toEqual({ deny: denyWaits(5, [2]) })
})
test('a failed worker still unblocks the tasks waiting for it', async () => {
  const s = running(); launch(s, 1, 'ag1')
  s.workerFinished('ag1', 'error')
  expect((s.checkSpawn('[T2] b', false) as any).task.id).toBe(2)
})
test('waiting for a main-chat task is not enforced', async () => {
  expect((running().checkSpawn('[T4] d', false) as any).task.id).toBe(4)
})
test('a returned Agent call counts as finished when the worker turn end was missed', async () => {
  const s = running(); launch(s, 1, 'ag1')
  expect(s.launchReturned('tu-ag1', false)).toBe(1)
  expect((s.checkSpawn('[T2] b', false) as any).task.id).toBe(2)
  expect(s.launchReturned('tu-unknown', false)).toBeUndefined()
  expect(s.launchReturned(undefined, false)).toBeUndefined()
})
test('a late worker from an older plan does not count as finished in the new one', async () => {
  const s = running(); launch(s, 1, 'ag1')
  const next = chain(); s.proposePlan(next); s.approve(next)
  s.workerFinished('ag1', 'answer')
  expect(s.launchReturned('tu-ag1', false)).toBeUndefined()
  expect(s.checkSpawn('[T2] b', false)).toEqual({ deny: denyWaits(2, [1]) })
})

// --- Pause and resume ---

const PAUSED = 'orchestrator on · plan paused ("continue" resumes)'
test('an interrupted plan is kept as paused: gated like planning, nothing launches', async () => {
  const s = running(); launch(s, 1, 'ag1'); s.workerFinished('ag1', 'answer')
  expect(s.completeMainTurn('aborted')).toBe(pausedLog(3, 4))
  expect(s.mode).toBe('paused')
  expect(s.statusText()).toBe(PAUSED)
  expect(s.checkSpawn('[T2] b', false)).toEqual({ deny: DENY_NO_PLAN })
  expect(s.checkTool('Edit', false)).toEqual({ deny: DENY_PLAN_FIRST })
  expect(s.checkTool('Read', true)).toEqual({ allow: true })
  expect(s.effortFor(undefined)).toBeUndefined()
})
test('a turn that answers while workers have not answered pauses the plan too', async () => {
  const s = running(); launch(s, 1, 'ag1'); s.workerFinished('ag1', 'error')
  expect(s.completeMainTurn('answer')).toBe(pausedLog(4, 4))
  expect(s.mode).toBe('paused')
})
test('an interrupted plan without workers pauses as well', async () => {
  const allMain = { tasks: [plan.tasks[1]] }
  const s = running(allMain)
  expect(s.completeMainTurn('error')).toBe(pausedLog(0, 0))
  expect(s.mode).toBe('paused')
})
test('"continue" resumes a paused plan: answered workers stay done, the rest may launch', async () => {
  const p = chain(); const s = running(p)
  launch(s, 1, 'ag1'); s.workerFinished('ag1', 'answer')
  launch(s, 2, 'ag2'); s.workerFinished('ag2', 'aborted')
  s.completeMainTurn('aborted')
  expect(s.handlePrompt('Continue', typed, 'Opus')).toEqual({ context: resumedContext(p, [1]), log: resumedLog(1, 4) })
  expect(s.mode).toBe('executing')
  expect(s.effortFor(undefined)).toBe('low')
  expect(s.checkSpawn('[T1] a', false)).toEqual({ deny: denyTwice(1) })
  expect(s.checkSpawn('[T5] e', false)).toEqual({ deny: denyWaits(5, [2]) })
  expect((s.checkSpawn('[T2] b', false) as any).task.id).toBe(2)
})
test('the resume note names what is done and what is still open', async () => {
  const text = resumedContext(chain(), [1])
  expect(text).toContain('T1')
  expect(text).not.toContain('T1 worker')
  expect(text).toContain('T2 worker sonnet/high; T3 main chat/low; T4 worker opus/high; T5 worker opus/high')
  expect(resumedContext(chain(), [])).not.toContain('already finished')
})
test('any other message drops a paused plan and starts a new request', async () => {
  const s = running(); s.completeMainTurn('aborted')
  expect(s.handlePrompt('what happened?', typed, 'Opus')).toEqual({ context: fullBriefing('none') })
  expect(s.mode).toBe('idle')
  expect(s.handlePrompt('continue', typed, 'Opus')).toEqual({ context: SHORT_REMINDER })
  expect(s.mode).toBe('idle')
})
test('a slash command leaves a paused plan paused', async () => {
  const s = running(); s.completeMainTurn('aborted')
  expect(s.handlePrompt('/model opus', { midTurn: false, isCommand: true }, 'Opus')).toEqual({ pass: true })
  expect(s.mode).toBe('paused')
})
test('"continue" also resumes a plan whose turn end was never seen', async () => {
  const p = chain(); const s = running(p); launch(s, 1, 'ag1'); s.workerFinished('ag1', 'answer')
  expect(s.handlePrompt('continue', typed, 'Opus')).toEqual({ context: resumedContext(p, [1]), log: resumedLog(1, 4) })
  expect(s.mode).toBe('executing')
})
test('a worker that answers after the pause counts as done on resume', async () => {
  const p = chain(); const s = running(p); launch(s, 1, 'ag1')
  s.completeMainTurn('aborted'); s.workerFinished('ag1', 'answer')
  expect(s.handlePrompt('continue', typed, 'Opus')).toEqual({ context: resumedContext(p, [1]), log: resumedLog(1, 4) })
})

// --- Live progress ---

test('while a plan runs, the status counts answered workers and the tokens workers used', async () => {
  const s = running()
  expect(s.statusText()).toBe('orchestrator on · 0/4 workers done')
  launch(s, 1, 'ag1'); s.workerFinished('ag1', 'answer', 41_300)
  expect(s.statusText()).toBe('orchestrator on · 1/4 workers done · 41K tokens')
  launch(s, 2, 'ag2'); s.workerFinished('ag2', 'error', 700)
  expect(s.statusText()).toBe('orchestrator on · 1/4 workers done · 42K tokens')
})
test('a plan with no workers just shows as running', async () => {
  expect(running({ tasks: [plan.tasks[1]] }).statusText()).toBe('orchestrator on · running plan')
})
test('the token count survives a pause and resume, and starts over with the next plan', async () => {
  const s = running(); launch(s, 1, 'ag1'); s.workerFinished('ag1', 'answer', 5000)
  s.completeMainTurn('aborted'); s.handlePrompt('continue', typed, 'Opus')
  expect(s.statusText()).toBe('orchestrator on · 1/4 workers done · 5K tokens')
  const next = chain(); s.proposePlan(next); s.approve(next)
  expect(s.statusText()).toBe('orchestrator on · 0/4 workers done')
})
test('a late worker from an older plan adds no tokens to the new one', async () => {
  const s = running(); launch(s, 1, 'ag1')
  const next = chain(); s.proposePlan(next); s.approve(next)
  s.workerFinished('ag1', 'answer', 9000)
  expect(s.statusText()).toBe('orchestrator on · 0/4 workers done')
})
