import type { EngineInterface, Register } from 'claude-code'
import { CMD_OFF, CMD_ON, CMD_STATS, ESCALATE_TOOL, ESCALATE_TOOL_NAME, FABLE_BLOCK_KEY, MAX_LOG_FILES, PLAN_TOOL, PLAN_TOOL_NAME } from '../lib/constants.js'
import { type LogEntry, logDir, logLine, logPath } from '../lib/log.js'
import { type Offer, modelAlias, modelLabel, renderOffer, renderPlan, validatePlan } from '../lib/plan.js'
import { type FableBlock, OrchestratorSession, fableAccessFrom, isFableCreditsFailure } from '../lib/session.js'
import { type StatsScope, renderStats, summarize } from '../lib/stats.js'
import {
  CHECK_GUARD_FAILED, DENY_GUARD_FAILED, ESCALATE_OFF, ESCALATE_SHOWN, ESCALATE_TOOL_DESCRIPTION, ESCALATE_TOOL_SCHEMA,
  FABLE_BLOCKED_LOG, FABLE_BLOCKED_NOTE, OFF_TEXT, PLAN_OFF, PLAN_WORKER, PLAN_SHOWN, PLAN_TOOL_DESCRIPTION, PROMPT_GUARD_FAILED,
  escalateHint, onText, planInvalid, planToolSchema,
} from '../lib/text.js'

// The engine interface every hook gets as `$`.
type Api = EngineInterface
type Render = Parameters<Api['ui']['resolve']>[0]
type AgentRecord = NonNullable<ReturnType<OrchestratorSession['agentRecord']>>

// One session per loaded module: a reload (or a new session) starts with the orchestrator off.
let session = new OrchestratorSession()
// The main chat's model as the plan shows it, e.g. "Opus"; updated whenever a plan or a retry is proposed.
let mainLabel = 'Main'
// The retry offers made so far, by the id of the escalate call that made each: its row draws from here.
const offers = new Map<string, Offer>()
// Plan and escalate calls whose plan or offer is drawn after their folded group's line; their own rows,
// seen when the group is opened, draw plain so it doesn't show twice.
const drawnAfterGroup = new Set<string>()

// Only the user's own prompts count as requests or replies; a worker's completion notice, a peer
// session's message or a mod's prompt carries an origin and passes through untouched.
// The Desktop app may stamp the user's prompts `sdk` or `unclassified`, so those count as the user's too.
// A prompt marked isMeta is one the person does not see as typed (the app wrote it), so it is never theirs.
const USER_ORIGINS = ['composer', 'bridge', 'sdk', 'unclassified']

export function isFromUser(e: { origin?: unknown; isMeta?: unknown }): boolean {
  if (e.isMeta === true) return false
  const kind = (e.origin as { kind?: string } | undefined)?.kind
  return e.origin === undefined || USER_ORIGINS.includes(kind ?? '')
}

// A slash command arrives with `command` set: `{ name, args }`.
function isCommand(e: { command?: unknown }): boolean {
  return e.command != null && e.command !== ''
}

function withContext<E extends { context?: readonly string[] }>(e: E, text: string): E {
  return { ...e, context: [...(e.context ?? []), text] }
}

// The status line and transcript lines are extras: a surface that can't show them must not break a hook.
async function showStatus($: Api, text: string | undefined) {
  try {
    await $.ui.status(text)
  } catch {}
}

async function showLog($: Api, text: string) {
  try {
    await $.ui.log(text)
  } catch {}
}

async function refreshStatus($: Api) {
  await showStatus($, session.statusText())
}

type DrawnCall = { tool: string; tool_use_id?: string; input: unknown; isErrored: boolean }

// What a call of the mod's tools shows: its plan, or its retry offer. Undefined for any other call, a refused
// one, or one with nothing behind it.
function shownBy(call: DrawnCall): string | undefined {
  if (call.isErrored) return undefined
  const credits = session.fableAccess === 'credits'
  if (call.tool === PLAN_TOOL) {
    const checked = validatePlan(call.input)
    return checked.ok ? renderPlan(checked.plan, mainLabel, credits) : undefined
  }
  const offer = call.tool === ESCALATE_TOOL && call.tool_use_id !== undefined ? offers.get(call.tool_use_id) : undefined
  return offer && renderOffer(offer, mainLabel, credits)
}

// A plan or an offer: one text per line, the first one bold.
function drawLines($: Api, e: Render, text: string) {
  const { Box, Text } = $.ui.resolve(e)
  return Box({
    flexDirection: 'column',
    children: text.split('\n').map((line, i) => Text(i === 0 ? { weight: 'semibold', children: line } : { children: line || ' ' })),
  })
}

// Registering again replaces the tool, so its schema lists the models Claude may propose right now.
async function registerPlanTool($: Api) {
  await $.tool.register({ name: PLAN_TOOL_NAME, description: PLAN_TOOL_DESCRIPTION, inputSchema: planToolSchema(session.allowedModels(Date.now())) })
}

// After Fable's availability changed. A stale schema only costs Claude one refused plan: the plan hook
// checks the models itself.
async function refreshPlanTool($: Api) {
  try {
    await registerPlanTool($)
  } catch {}
}

type Finished = { durationMs: number; reason: string; usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number } }

function logEntryFor(record: AgentRecord, e: Finished, sessionId: string, agentId: string, mainModel: string | undefined): LogEntry {
  const approved = { route: record.task.route, model: record.task.model, effort: record.task.effort }
  const rec = record.recommended ?? record.task
  const recommended = { route: rec.route, model: rec.model, effort: rec.effort }
  return {
    ts: Date.now(),
    sessionId,
    agentId,
    taskId: record.task.id,
    title: record.task.title,
    recommended,
    approved,
    edited: approved.route !== recommended.route || approved.model !== recommended.model || approved.effort !== recommended.effort,
    inputTokens: e.usage?.input_tokens ?? 0,
    outputTokens: e.usage?.output_tokens ?? 0,
    cacheReadTokens: e.usage?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: e.usage?.cache_creation_input_tokens ?? 0,
    durationMs: e.durationMs,
    outcome: e.reason,
    ...(mainModel ? { mainModel } : {}),
  }
}

// Lines waiting to be written, and whether a write is running: one writer at a time, so two workers
// finishing together can't interleave or lose a line.
const queuedLines: string[] = []
let logWriting = false

const APPEND_COMMAND = 'mkdir -p "$1" && cat >> "$2"'

// Adds the text to the end of the file without reading it. False where there is no sh, or the command failed.
async function appendWithShell($: Api, path: string, text: string): Promise<boolean> {
  try {
    const ran = await $.process.run(['sh', '-c', APPEND_COMMAND, 'sh', path.slice(0, path.lastIndexOf('/')), path], { stdin: text, timeoutMs: 5000 })
    return ran.exitCode === 0
  } catch {
    return false
  }
}

// The slow way, for a host without sh: the file API has no append, so the whole file is written again.
async function appendByRewrite($: Api, path: string, text: string) {
  const existing = (await $.fs.exists(path)) ? await $.fs.read(path) : ''
  await $.fs.write(path, existing + text)
}

// Appends one line to this session's log file. A failure here never touches the turn.
async function appendLog($: Api, record: AgentRecord, e: Finished & { agentId: string }) {
  try {
    const home = await $.env.get('HOME')
    if (!home) return
    const sessionId = await $.session.id()
    const path = logPath(home, sessionId)
    const mainModel = await $.session.model().then(modelAlias, () => undefined)
    queuedLines.push(logLine(logEntryFor(record, e, sessionId, e.agentId, mainModel)))
    if (logWriting) return
    logWriting = true
    try {
      while (queuedLines.length > 0) {
        const batch = queuedLines.splice(0).join('')
        if (!(await appendWithShell($, path, batch))) await appendByRewrite($, path, batch)
      }
    } finally {
      logWriting = false
    }
  } catch {
    // Logging is best effort.
  }
}

// Every line of this session's log, or of the newest log files; none when there is no log yet. A file that
// can't be read is skipped.
async function readLogLines($: Api, scope: StatsScope): Promise<string[]> {
  try {
    const home = await $.env.get('HOME')
    if (!home) return []
    if (scope === 'session') return String(await $.fs.read(logPath(home, await $.session.id()))).split('\n')
    const dir = logDir(home)
    const files = (await $.fs.list(dir))
      .filter(entry => entry.kind === 'file' && entry.name.endsWith('.jsonl'))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, MAX_LOG_FILES)
    const texts = await Promise.all(files.map(file => $.fs.read(`${dir}/${file.name}`).catch(() => '')))
    return texts.flatMap(text => String(text).split('\n'))
  } catch {
    return []
  }
}

// The store only remembers the learned block; losing it costs one more failed Fable worker at most.
async function restoreFableBlock($: Api) {
  try {
    session.restoreFableBlock(await $.store.get(FABLE_BLOCK_KEY), Date.now())
  } catch {}
}

async function saveFableBlock($: Api, block: FableBlock) {
  try {
    await $.store.set(FABLE_BLOCK_KEY, block)
  } catch {}
}

async function forgetFableBlock($: Api) {
  try {
    await $.store.delete(FABLE_BLOCK_KEY)
  } catch {}
}

export const register: Register = (on, options) => {
  session = new OrchestratorSession(fableAccessFrom(options))
  offers.clear()
  drawnAfterGroup.clear()

  on('session.start', async ($, e, next) => {
    await $.tool.register({ name: ESCALATE_TOOL_NAME, description: ESCALATE_TOOL_DESCRIPTION, inputSchema: ESCALATE_TOOL_SCHEMA })
    await registerPlanTool($)
    await $.command.register({ name: CMD_ON, description: 'Plan each request and route tasks to the right model and effort' })
    await $.command.register({ name: CMD_OFF, description: 'Stop planning and routing requests' })
    await $.command.register({ name: CMD_STATS, description: 'Show what the routed workers used and saved' })
    return next(e)
  })

  on('command.run', { command: 'efficient-model-orchestrator-on' }, async ($) => {
    await restoreFableBlock($)
    session.turnOn()
    await refreshPlanTool($)
    await refreshStatus($)
    return { text: onText(await $.session.model()) }
  })

  on('command.run', { command: 'efficient-model-orchestrator-off' }, async ($) => {
    session.turnOff()
    await showStatus($, undefined)
    return { text: OFF_TEXT }
  })

  // This session's workers, or every session's with "all". Works whether the orchestrator is on or off: it only
  // reads the logs.
  on('command.run', { command: 'efficient-model-orchestrator-stats' }, async ($, e) => {
    const scope: StatsScope = e.args?.trim().toLowerCase() === 'all' ? 'all' : 'session'
    return { text: renderStats(summarize(await readLogLines($, scope)), scope) }
  })

  on('tool.call', { tool: 'mcp__efficient-model-orchestrator__plan' }, async ($, e) => {
    if (session.mode === 'off') return { deny: PLAN_OFF }
    if (e.agentId !== undefined) return { deny: PLAN_WORKER }
    const checked = validatePlan({ tasks: e.tasks }, session.allowedModels(Date.now()))
    if (!checked.ok) return { deny: planInvalid(checked.error) }
    mainLabel = modelLabel(await $.session.model())
    session.proposePlan(checked.plan)
    await refreshStatus($)
    return { result: PLAN_SHOWN }
  })

  // Claude offers a retry of a finished worker task, one step stronger; the user answers as for a plan.
  on('tool.call', { tool: 'mcp__efficient-model-orchestrator__escalate' }, async ($, e) => {
    if (session.mode === 'off') return { deny: ESCALATE_OFF }
    if (e.agentId !== undefined) return { deny: PLAN_WORKER }
    const proposed = session.proposeEscalation(e.task, e.reason, Date.now())
    if ('deny' in proposed) return { deny: proposed.deny }
    if (e.tool_use_id !== undefined) offers.set(e.tool_use_id, proposed.offer)
    mainLabel = modelLabel(await $.session.model())
    await refreshStatus($)
    return { result: ESCALATE_SHOWN }
  })

  on('prompt.submit', async ($, e, next) => {
    const midTurn = e.turnId !== undefined
    if (!isFromUser(e)) {
      // A worker's notice or another automated prompt: never a reply, but the turn it starts gets its own looks.
      if (!midTurn) session.beginTurn()
      return next(e)
    }
    const action = session.handlePrompt(e.text, { midTurn, isCommand: isCommand(e) }, mainLabel)
    if ('pass' in action) return next(e)
    if ('drop' in action) return { drop: action.drop }
    if (action.log) await showLog($, action.log)
    await refreshStatus($)
    return next(withContext(e, action.context))
    // Failing open would send a request past the plan, or a reply past the pending plan: say so instead.
  }).catch(async ($, e, next) => (next.called || session.mode === 'off' || isCommand(e) || !isFromUser(e) ? next(e) : { drop: PROMPT_GUARD_FAILED }))

  // /clear and /resume start another conversation, so the orchestrator goes off as in a new session.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') {
      session.turnOff()
      await showStatus($, undefined)
    }
    return next(e)
  })

  // Keep the plan tool loaded, so planning never spends a look on tool search.
  on('tool.describe', { tool: 'mcp__efficient-model-orchestrator__plan' }, async ($, e, next) => {
    const described = await next(e)
    return { ...described, isDeferred: false }
  })

  on('tool.describe', { tool: 'mcp__efficient-model-orchestrator__escalate' }, async ($, e, next) => {
    const described = await next(e)
    return { ...described, isDeferred: false }
  })

  // A worker's result on its way back to Claude. A Fable worker that failed for lack of usage credits is
  // remembered, so Fable stops being proposed; any other failed worker comes with a hint to offer a retry.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const result = await next(e)
    if (session.mode === 'off') return result
    const taskId = session.launchReturned(e.tool_use_id, result.deny !== undefined || result.isError === true)
    const outOfCredits = isFableCreditsFailure(result) && session.isFableTask(e.description)
    if (outOfCredits) {
      await saveFableBlock($, session.blockFable(Date.now()))
      await refreshPlanTool($)
      await showLog($, FABLE_BLOCKED_LOG)
    }
    if (result.deny !== undefined) return result
    if (outOfCredits) return { ...result, context: [...(result.context ?? []), FABLE_BLOCKED_NOTE] }
    if (taskId === undefined || !session.canEscalate(taskId, Date.now())) return result
    return { ...result, context: [...(result.context ?? []), escalateHint(taskId)] }
  })

  // Every subagent launch: only approved worker tasks start, on their approved model. Fails closed.
  on('agent.spawn', async ($, e, next) => {
    if (session.mode === 'off') return next(e)
    const checked = session.checkSpawn(e.description, e.fork, e.parentAgentId)
    if ('deny' in checked) return { deny: checked.deny }
    // Marked before the launch: a second launch of this task, or the worker's first request, can arrive
    // before next() has returned the worker's id.
    session.markLaunched(checked.task, e.tool_use_id)
    try {
      // Foreground, so tasks that wait for this one can start in the same turn under the approved plan.
      const started = await next({ ...e, model: checked.task.model, background: false })
      if ('deny' in started) session.unmarkLaunched(checked.task.id)
      else session.recordAgent(started.agentId, checked.task)
      return started
    } catch (error) {
      session.unmarkLaunched(checked.task.id)
      throw error
    }
  }).catch(async ($, e, next) => (next.called ? next(e) : { deny: DENY_GUARD_FAILED }))

  // The main chat's own tools: a few read-only looks while planning, nothing while a plan waits.
  on('tool.check', async ($, e, next) => {
    if (session.mode === 'off') return next(e)
    const checked = session.checkTool(e.tool, e.isReadOnly === true, e.agentId)
    if ('deny' in checked) return { decision: 'deny', reason: checked.deny }
    return next(e)
    // Fails closed for the main chat, like the launch check; workers are never gated.
  }).catch(async ($, e, next) => (next.called || session.mode === 'off' || e.agentId !== undefined ? next(e) : { decision: 'deny', reason: CHECK_GUARD_FAILED }))

  // Each request to the model: a worker runs at its approved effort, the main chat at its main-task effort.
  on('turn.step', async function* ($, e, next) {
    const effort = session.effortFor(e.agentId)
    return yield* next(effort ? { ...e, effort } : e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      const paused = session.completeMainTurn(e.reason)
      if (paused) await showLog($, paused)
      await refreshStatus($)
    } else {
      // Cache reads are left out: they repeat the same context on every request and would swamp the count.
      const used = (e.usage?.input_tokens ?? 0) + (e.usage?.cache_creation_input_tokens ?? 0) + (e.usage?.output_tokens ?? 0)
      const record = session.workerFinished(e.agentId, e.reason, used)
      await refreshStatus($)
      if (record) await appendLog($, record, { ...e, agentId: e.agentId })
      if (record?.task.model === 'fable' && e.reason === 'answer' && session.clearFableBlock()) {
        await forgetFableBlock($)
        await refreshPlanTool($)
      }
    }
    return next(e)
  })

  // The rows of the mod's own tools show the plan, or the retry offer, in the agreed format.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (drawnAfterGroup.has(e.props.tool_use_id)) return next(e)
    const shown = shownBy(e.props)
    return shown === undefined ? next(e) : drawLines($, e, shown)
  })

  // The Desktop app folds a run of tool calls into one collapsed line ("used efficient-model-orchestrator,
  // 1 blocked"), which hid the plan. A folded group draws its last plan or offer right after its line, in
  // the flow; a group drawn open leaves it to the call's own row.
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    const call = [...e.props.calls].reverse().find(c => !c.isRunning && shownBy(c) !== undefined)
    if (!call) return next(e)
    if (e.props.isExpanded) {
      if (call.tool_use_id !== undefined) drawnAfterGroup.delete(call.tool_use_id)
      return next(e)
    }
    if (call.tool_use_id !== undefined) drawnAfterGroup.add(call.tool_use_id)
    const { Box } = $.ui.resolve(e)
    return Box({ flexDirection: 'column', children: [await next(e), drawLines($, e, shownBy(call) as string)] })
  })

  on('session.compact', async ($, e, next) => {
    session.markCompacted()
    return next(e)
  })
}
