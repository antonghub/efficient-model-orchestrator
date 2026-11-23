import { expect, test } from 'claude-code/testing'
import { register } from '../hooks/register.js'
import { logPath } from '../lib/log.js'
import { PLAN_TOOL, W1, fakeApi, hooksWith, partial, propose, setup, turnOn } from './helpers.js'

const toolRow = (tool: string, input: unknown) => ({
  plugin: 'efficient-model-orchestrator', component: 'ToolUse', requestId: 'tu1', surface: 'desktop',
  viewport: { columns: 100, rows: 30 },
  props: { tool_use_id: 'tu1', tool, input, isRunning: false, isErrored: false },
})

test('the plan tool row draws the rendered plan', async ($, on) => {
  await setup($, on, on => on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by Claude Code'] })))
  const ui = await $.ui.mount(partial(toolRow(PLAN_TOOL, { tasks: [W1] })))
  expect(await ui.find({ type: 'Text', text: 'Plan: 1 task' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '   Haiku · medium: read-only search.' })).toBeDefined()
})
test('a refused plan row is drawn by Claude Code, not as a plan to approve', async ($, on) => {
  await setup($, on, on => on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by Claude Code'] })))
  const row = toolRow(PLAN_TOOL, { tasks: [W1] })
  const ui = await $.ui.mount(partial({ ...row, props: { ...row.props, isErrored: true } }))
  expect(await ui.find({ type: 'Text', text: 'drawn by Claude Code' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Plan:/ })).toBeUndefined()
})
test('other tool rows are drawn by Claude Code', async ($, on) => {
  await setup($, on, on => on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by Claude Code'] })))
  const ui = await $.ui.mount(partial(toolRow('Bash', { command: 'ls' })))
  expect(await ui.find({ type: 'Text', text: 'drawn by Claude Code' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Plan:/ })).toBeUndefined()
})
// Runs one edited worker task to its end; `stubs` adds the file and process stubs under test.
async function finishedWorker($: any, on: any, stubs: (on: any) => void) {
  await setup($, on, on => {
    on('session.id', () => ({ value: 'sess' }))
    on('env.get', () => ({ value: '/Users/a' }))
    stubs(on)
    on('agent.spawn', ($: any, e: any) => ({ model: e.model, agentId: 'ag1' }))
    on('turn.complete', () => ({ text: '' }))
  })
  await turnOn($)
  await propose($, [W1]); await $.prompt.submit(partial({ text: '1. sonnet high' }))
  await $.agent.spawn({ tool_use_id: 'tu', prompt: 'p', description: '[T1] Find callers', subagentType: 'general-purpose', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: false, fork: false })
  await $.turn.complete(partial({ turnId: 't', agentId: 'ag1', answer: '', durationMs: 5, isAborted: false, reason: 'answer',
    usage: { model: 'claude-sonnet-5-5', input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 5 } }))
}
const LOGGED = { taskId: 1, title: 'Find callers', edited: true,
  approved: { route: 'worker', model: 'sonnet', effort: 'high' }, recommended: { route: 'worker', model: 'haiku', effort: 'medium' },
  inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 5, durationMs: 5, outcome: 'answer', mainModel: 'sonnet' }

test('a worker turn appends one log line with its usage, without reading the log back', async ($, on) => {
  const runs: any[] = []
  let fileCalls = 0
  await finishedWorker($, on, on => {
    on('process.run', ($: any, e: any) => { runs.push(e); return { value: { exitCode: 0, stdout: '', stderr: '' } } })
    on('fs.exists', () => { fileCalls++; return { value: false } })
    on('fs.read', () => { fileCalls++; return { value: '' } })
    on('fs.write', () => { fileCalls++; return { value: undefined } })
  })
  expect(runs.length).toBe(1)
  expect(runs[0].argv).toEqual(['sh', '-c', 'mkdir -p "$1" && cat >> "$2"', 'sh', '/Users/a/.claude/efficient-model-orchestrator/logs', logPath('/Users/a', 'sess')])
  expect(runs[0].init.stdin.endsWith('\n')).toBe(true)
  expect(JSON.parse(runs[0].init.stdin)).toMatchObject(LOGGED)
  expect(fileCalls).toBe(0)
})
test('where the append command fails, the line is still added by rewriting the file', async ($, on) => {
  const path = logPath('/Users/a', 'sess')
  const files = new Map([[path, '{"old":true}\n']])
  await finishedWorker($, on, on => {
    on('process.run', () => ({ value: { exitCode: 127, stdout: '', stderr: 'sh: not found' } }))
    on('fs.exists', ($: any, e: any) => ({ value: files.has(e.path) }))
    on('fs.read', ($: any, e: any) => ({ value: files.get(e.path) ?? '' }))
    on('fs.write', ($: any, e: any) => { files.set(e.path, e.text); return { value: undefined } })
  })
  const lines = (files.get(path) ?? '').trim().split('\n').map(l => JSON.parse(l))
  expect(lines.length).toBe(2)
  expect(lines[0]).toEqual({ old: true })
  expect(lines[1]).toMatchObject(LOGGED)
})

// --- The Desktop app folds tool rows into one count line ---

const ESCALATE_TOOL = 'mcp__efficient-model-orchestrator__escalate'
const call = (tool: string, isErrored = false) => ({ tool_use_id: `tu-${tool}`, tool, input: {}, isRunning: false, isErrored, isInterrupted: false })
const group = (calls: unknown[], isExpanded = false) => ({ props: { calls, isActive: false, isExpanded } })
const echo = async (e: any) => e

const TOOL_GROUP = { component: 'ToolGroup' }
const TOOL_USE = { component: 'ToolUse' }
const planCall = (id = 'tuP', isErrored = false) => ({ ...call(PLAN_TOOL, isErrored), tool_use_id: id, input: { tasks: [W1] } })
const planRow = (id = 'tuP') => ({ props: { tool: PLAN_TOOL, tool_use_id: id, input: { tasks: [W1] }, isRunning: false, isErrored: false } })

test('the plan is drawn right after the folded group line, in the flow, and the group stays folded', async () => {
  const hook = hooksWith(register, {})
  const $: any = fakeApi()
  const e = group([call('Read'), call('Bash', true), planCall()])
  const drawn: any = await hook('ui.render', TOOL_GROUP)($, e, echo)
  expect(drawn.children[0]).toBe(e)
  expect($.drawn).toContain('Plan: 1 task')
  expect($.drawn).toContain('   Haiku · medium: read-only search.')
})
test('opening the group shows the plain plan call, so the plan is not drawn twice', async () => {
  const hook = hooksWith(register, {})
  const $: any = fakeApi()
  await hook('ui.render', TOOL_GROUP)($, group([call('Read'), planCall()]), echo)
  const row = planRow()
  expect(await hook('ui.render', TOOL_USE)($, row, echo)).toBe(row)
})
test('a group drawn open leaves the plan to its own row', async () => {
  const hook = hooksWith(register, {})
  const $: any = fakeApi()
  await hook('ui.render', TOOL_GROUP)($, group([call('Read'), planCall()]), echo)
  const open = group([call('Read'), planCall()], true)
  expect(await hook('ui.render', TOOL_GROUP)($, open, echo)).toBe(open)
  $.drawn.length = 0
  await hook('ui.render', TOOL_USE)($, planRow(), echo)
  expect($.drawn).toContain('Plan: 1 task')
})
test('a plan row that was never in a folded group draws the plan itself', async () => {
  const hook = hooksWith(register, {})
  const $: any = fakeApi()
  await hook('ui.render', TOOL_USE)($, planRow('tu-alone'), echo)
  expect($.drawn).toContain('Plan: 1 task')
})
test('only the last plan of a group is drawn after it', async () => {
  const hook = hooksWith(register, {})
  const $: any = fakeApi()
  const later = { ...planCall('tuP2'), input: { tasks: [{ ...W1, title: 'Second try' }] } }
  await hook('ui.render', TOOL_GROUP)($, group([planCall('tuP1'), later]), echo)
  expect($.drawn).toContain('1. Second try')
  expect($.drawn).not.toContain('1. Find callers')
})
test('groups with no plan, a refused plan, a plan still running, or an offer with nothing behind it are left alone', async () => {
  const hook = hooksWith(register, {})
  const running = { ...planCall(), isRunning: true }
  for (const e of [group([call('Read'), call('Grep')]), group([call('Read'), planCall('tuP', true)]), group([running]), group([call(ESCALATE_TOOL)]), group([])])
    expect(await hook('ui.render', TOOL_GROUP)(fakeApi(), e, echo)).toBe(e)
})
test('a retry offer is drawn right after its folded group too', async () => {
  const hook = hooksWith(register, {})
  const $: any = fakeApi()
  await hook('command.run', { command: 'efficient-model-orchestrator-on' })($, {})
  await hook('tool.call', { tool: PLAN_TOOL })($, { tasks: [W1] })
  await hook('prompt.submit')($, { text: 'OK' }, echo)
  await hook('agent.spawn')($, { description: '[T1] x', fork: false, tool_use_id: 'tu1' }, async (e: any) => ({ model: e.model, agentId: 'ag1' }))
  await hook('turn.complete')($, { agentId: 'ag1', reason: 'error', durationMs: 1 }, echo)
  await hook('tool.call', { tool: ESCALATE_TOOL })($, { task: 1, reason: 'crashed', tool_use_id: 'tuE' })
  const offerCall = { ...call(ESCALATE_TOOL), tool_use_id: 'tuE' }
  await hook('ui.render', TOOL_GROUP)($, group([call('Read'), offerCall]), echo)
  expect($.drawn).toContain('Retry task 1: Find callers')
})
// The kit never paints a surface, but it does check the tree against the desktop's elements.
test('the desktop accepts the folded group with the plan drawn after it', async ($, on) => {
  await setup($, on, on => on('ui.render', () => ({ type: 'Text', props: {}, children: ['Read 1 file'] })))
  const ui = await $.ui.mount(partial({ plugin: 'efficient-model-orchestrator', component: 'ToolGroup', requestId: 'g1', surface: 'desktop',
    viewport: { columns: 100, rows: 30 }, props: { calls: [call('Read'), planCall()], isActive: false, isExpanded: false } } as any))
  expect(await ui.find({ type: 'Text', text: 'Read 1 file' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Plan: 1 task' })).toBeDefined()
})
