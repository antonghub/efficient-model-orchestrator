import { EFFORTS, FABLE_ACCESS, FABLE_BLOCK_MS, FREE_TOOLS, FREE_TOOL_PREFIXES, LOOK_EXCLUDED, MAX_LOOKS, MODELS, TASK_TAG } from './constants.js'
import { stepRoute } from './ladder.js'
import type { Offer } from './plan.js'
import { isDecline, isResume, parseReply, startingLine } from './reply.js'
import {
  DENY_FORK, DENY_NESTED, DENY_NO_PLAN, DENY_NO_TAG, DENY_PENDING, DENY_PLAN_FIRST, DROP_FABLE_OFF, DROP_STILL_WORKING,
  ESCALATE_BAD_INPUT, ESCALATE_NO_PLAN, MIDTURN_NOTE, REPLAN_CONTEXT, RETRY_REPLY_CONTEXT, SHORT_REMINDER, approvedContext,
  denyNotWorker, denyTwice, denyWaits, escalateNoStronger, escalateNotFinished, escalateNotWorker, fullBriefing, keepingLine,
  formatTokens, pausedLog, resumedContext, resumedLog, retryApprovedContext, retryDeclinedContext, retryLine,
} from './text.js'
import type { Effort, FableAccess, Mode, Model, Plan, Task } from './types.js'

type Decision = { allow: true } | { deny: string }
export type PromptAction = { pass: true } | { drop: string } | { context: string; log?: string }
type AgentRecord = { task: Task; recommended: Task | undefined }

export type FableBlock = { until: number; setting: FableAccess }
// A retry on offer: the task as it ran, and what was proposed before the offer took its place.
type Escalation = { id: number; original: Task; proposedBefore: Plan | undefined }

const swapTask = (plan: Plan, task: Task): Plan => ({ tasks: plan.tasks.map(t => (t.id === task.id ? task : t)) })

export function fableAccessFrom(options: unknown): FableAccess {
  const value = (options as { fable?: FableAccess } | null | undefined)?.fable
  return value && FABLE_ACCESS.includes(value) ? value : 'off'
}

const CREDITS = /usage credits/i

function asText(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

// True for a worker's result that failed because Fable needs usage credits. Only a refused or failed
// result counts, wherever its message sits; a worker that merely wrote about credits does not.
export function isFableCreditsFailure(result: { deny?: string; isError?: boolean; text?: string; result?: unknown }): boolean {
  if (typeof result.deny === 'string') return CREDITS.test(result.deny)
  if (result.isError !== true) return false
  return [result.text, result.result].some(part => CREDITS.test(asText(part)))
}

// One per session: off → idle → pending → executing → idle (or paused, when the plan was cut short), and
// every allow/deny the hooks ask for.
export class OrchestratorSession {
  mode: Mode = 'off'
  private proposed: Plan | undefined
  private current: Plan | undefined
  private looks = 0
  private fullBriefing = true
  // Progress of the current plan, by task id. launched: accepted launches. starting: those whose worker has
  // no agent id yet. finished: worker tasks whose worker has ended, with how it ended.
  private launched = new Set<number>()
  private starting = new Map<number, Task>()
  private finished = new Map<number, string>()
  // The Agent tool call behind each accepted launch.
  private launchCalls = new Map<string, number>()
  // Tokens the current plan's workers have used so far; kept across a pause.
  private tokens = 0
  // Kept past the execution turn, so a resumed or late-finishing worker keeps its route.
  private agents = new Map<string, AgentRecord>()
  // Set while a retry offer waits for the user's reply (mode pending).
  private escalation: Escalation | undefined
  private fableBlockedUntil = 0

  constructor(readonly fableAccess: FableAccess = 'off') {}

  turnOn(): void {
    this.mode = 'idle'
    this.looks = 0
    this.fullBriefing = true
  }

  turnOff(): void {
    this.mode = 'off'
    this.proposed = undefined
    this.current = undefined
    this.escalation = undefined
    this.resetProgress()
    this.tokens = 0
    this.agents.clear()
  }

  private resetProgress(): void {
    this.launched.clear()
    this.starting.clear()
    this.finished.clear()
    this.launchCalls.clear()
  }

  // A turn that is not a request from the user (a slash command, a worker's notice): fresh looks only.
  beginTurn(): void {
    this.looks = 0
  }

  // A new request drops whatever plan was running or paused.
  beginRequest(): 'full' | 'short' {
    this.looks = 0
    if (this.mode === 'executing' || this.mode === 'paused') {
      this.mode = 'idle'
      this.current = undefined
      this.escalation = undefined
      this.resetProgress()
      this.tokens = 0
    }
    const kind = this.fullBriefing ? 'full' : 'short'
    this.fullBriefing = false
    return kind
  }

  proposePlan(plan: Plan): void {
    this.mode = 'pending'
    this.proposed = plan
    this.current = plan
    this.escalation = undefined
  }

  approve(plan: Plan): void {
    this.mode = 'executing'
    this.current = plan
    this.escalation = undefined
    this.resetProgress()
    this.tokens = 0
  }

  // Claude asks to retry a finished worker task one step stronger. The plan waits for the user's reply with
  // the stronger route in the task's place; everything else keeps its progress.
  proposeEscalation(id: unknown, reason: unknown, now = Date.now()): { offer: Offer } | { deny: string } {
    if (this.mode === 'pending') return { deny: DENY_PENDING }
    if (this.mode !== 'executing' || !this.current) return { deny: ESCALATE_NO_PLAN }
    if (typeof id !== 'number' || !Number.isInteger(id) || typeof reason !== 'string' || reason.trim() === '') return { deny: ESCALATE_BAD_INPUT }
    const task = this.workerTask(id)
    if (!task) return { deny: escalateNotWorker(id) }
    if (!this.finished.has(id)) return { deny: escalateNotFinished(id) }
    const stronger = stepRoute(task, 'stronger', this.allowedModels(now))
    if (stronger === task) return { deny: escalateNoStronger(id) }
    const to = { ...stronger, reason: reason.trim() }
    this.escalation = { id, original: task, proposedBefore: this.proposed }
    this.current = swapTask(this.current, to)
    // The offered route is what the retry's log line counts as recommended.
    this.proposed = this.proposed && swapTask(this.proposed, to)
    this.mode = 'pending'
    return { offer: { id, title: task.title, from: task, to, reason: to.reason } }
  }

  // The user's reply to a retry offer: "no" keeps the result, "OK" or a route retries, anything else waits.
  private answerEscalation(offer: Escalation, plan: Plan, text: string, mainLabel: string, now: number): PromptAction {
    const { id } = offer
    if (isDecline(text)) {
      this.current = swapTask(plan, offer.original)
      this.proposed = offer.proposedBefore
      // The user took the result as it is, so the task counts as done.
      this.finished.set(id, 'answer')
      this.escalation = undefined
      this.mode = 'executing'
      return { context: retryDeclinedContext(id), log: keepingLine(id) }
    }
    // Only the offered task can change, and its number may be left out: "opus high".
    const single = { tasks: plan.tasks.filter(t => t.id === id) }
    const models = this.allowedModels(now)
    let reply = parseReply(text, single, models)
    if (reply.kind === 'other') reply = parseReply(`${id}. ${text}`, single, models)
    if (reply.kind === 'other') return { context: RETRY_REPLY_CONTEXT }
    const task = reply.plan.tasks[0]
    if (!task) return { context: RETRY_REPLY_CONTEXT }
    if (this.fableAccess === 'off' && task.model === 'fable') return { drop: DROP_FABLE_OFF }
    this.current = swapTask(plan, task)
    this.unmarkLaunched(id)
    this.finished.delete(id)
    this.escalation = undefined
    this.mode = 'executing'
    return { context: retryApprovedContext(this.current, id, this.answered()), log: retryLine(task, mainLabel, this.fableAccess === 'credits') }
  }

  // Whether a retry is worth suggesting to Claude: the task's worker failed and a stronger route is left.
  canEscalate(id: number, now = Date.now()): boolean {
    const task = this.mode === 'executing' ? this.workerTask(id) : undefined
    const outcome = this.finished.get(id)
    return task !== undefined && (outcome === 'error' || outcome === 'refusal') && stepRoute(task, 'stronger', this.allowedModels(now)) !== task
  }

  // A prompt from the user. midTurn: typed while a turn was running; isCommand: a slash command.
  handlePrompt(text: string, opts: { midTurn: boolean; isCommand: boolean }, mainLabel: string, now = Date.now()): PromptAction {
    if (this.mode === 'off') return { pass: true }
    if (opts.isCommand) {
      // Not a request, so no briefing; but a command may start a turn, and that turn gets its own looks.
      if (!opts.midTurn) this.beginTurn()
      return { pass: true }
    }
    const pending = this.pendingPlan()
    if (pending) {
      if (opts.midTurn) return { drop: DROP_STILL_WORKING }
      if (this.escalation) return this.answerEscalation(this.escalation, pending, text, mainLabel, now)
      const reply = parseReply(text, pending, this.allowedModels(now))
      if (reply.kind === 'other') return { context: REPLAN_CONTEXT }
      if (this.fableAccess === 'off' && reply.plan.tasks.some(t => t.model === 'fable')) return { drop: DROP_FABLE_OFF }
      this.approve(reply.plan)
      return { context: approvedContext(reply.plan), log: startingLine(reply.plan, reply.edits, mainLabel, this.fableAccess === 'credits') }
    }
    if (opts.midTurn) return this.mode === 'executing' ? { context: MIDTURN_NOTE } : { pass: true }
    // A prompt that starts a turn while a plan still counts as running: its turn ended unseen, so it is paused too.
    if ((this.mode === 'paused' || this.mode === 'executing') && this.current && isResume(text)) return this.resume(this.current)
    if (this.beginRequest() === 'short') return { context: SHORT_REMINDER }
    const offered = this.allowedModels(now).includes('fable')
    return { context: fullBriefing(offered && this.fableAccess !== 'off' ? this.fableAccess : 'none') }
  }

  // The models Claude may propose: Fable only if the setting allows it and no learned block is running.
  allowedModels(now: number): readonly Model[] {
    const offered = this.fableAccess !== 'off' && now >= this.fableBlockedUntil
    return offered ? MODELS : MODELS.filter(m => m !== 'fable')
  }

  blockFable(now: number): FableBlock {
    this.fableBlockedUntil = now + FABLE_BLOCK_MS
    return { until: this.fableBlockedUntil, setting: this.fableAccess }
  }

  // A saved block counts only under the setting it was learned with: changing the setting starts over.
  restoreFableBlock(saved: unknown, now: number): void {
    const block = saved as Partial<FableBlock> | null | undefined
    if (block?.setting === this.fableAccess && typeof block.until === 'number' && now < block.until) this.fableBlockedUntil = block.until
  }

  // Returns whether there was a block to clear.
  clearFableBlock(): boolean {
    const had = this.fableBlockedUntil > 0
    this.fableBlockedUntil = 0
    return had
  }

  isFableTask(description: string): boolean {
    const tag = TASK_TAG.exec(description)
    const task = tag ? this.current?.tasks.find(t => t.id === Number(tag[1])) : undefined
    return task?.route === 'worker' && task.model === 'fable'
  }

  pendingPlan(): Plan | undefined {
    return this.mode === 'pending' ? this.current : undefined
  }

  checkTool(tool: string, isReadOnly: boolean, agentId?: string): Decision {
    if (this.mode === 'off' || agentId !== undefined || tool === 'Agent') return { allow: true }
    if (FREE_TOOLS.includes(tool) || FREE_TOOL_PREFIXES.some(prefix => tool.startsWith(prefix))) return { allow: true }
    if (this.mode === 'pending') return { deny: DENY_PENDING }
    if (this.mode === 'executing') return { allow: true }
    if (isReadOnly && !LOOK_EXCLUDED.includes(tool) && this.looks < MAX_LOOKS) {
      this.looks++
      return { allow: true }
    }
    return { deny: DENY_PLAN_FIRST }
  }

  checkSpawn(description: string, fork: boolean, parentAgentId?: string): { task: Task } | { deny: string } {
    if (parentAgentId !== undefined) return { deny: DENY_NESTED }
    if (this.mode !== 'executing') return { deny: DENY_NO_PLAN }
    if (fork) return { deny: DENY_FORK }
    const tag = TASK_TAG.exec(description)
    if (!tag) return { deny: DENY_NO_TAG }
    const id = Number(tag[1])
    const task = this.current?.tasks.find(t => t.id === id)
    if (!task || task.route !== 'worker') return { deny: denyNotWorker(id) }
    if (this.launched.has(id)) return { deny: denyTwice(id) }
    // Only workers can be waited for: the mod can't tell when a main-chat task is done.
    const waiting = (task.after ?? []).filter(dep => this.workerTask(dep) && !this.finished.has(dep))
    if (waiting.length > 0) return { deny: denyWaits(id, waiting) }
    return { task }
  }

  private workerTask(id: number): Task | undefined {
    const task = this.current?.tasks.find(t => t.id === id)
    return task?.route === 'worker' ? task : undefined
  }

  // Call as soon as a launch is accepted: a second launch of the task, or the worker's first request, can
  // arrive before the launch has returned the worker's id.
  markLaunched(task: Task, toolUseId?: string): void {
    this.launched.add(task.id)
    this.starting.set(task.id, task)
    if (toolUseId !== undefined) this.launchCalls.set(toolUseId, task.id)
  }

  // The launch did not start a worker, so the task may be launched again.
  unmarkLaunched(id: number): void {
    this.launched.delete(id)
    this.starting.delete(id)
    for (const [call, task] of this.launchCalls) if (task === id) this.launchCalls.delete(call)
  }

  recordAgent(agentId: string | undefined, task: Task): void {
    this.launched.add(task.id)
    this.starting.delete(task.id)
    if (agentId !== undefined) this.agents.set(agentId, { task, recommended: this.proposed?.tasks.find(t => t.id === task.id) })
  }

  // A worker's turn ended, having used `tokens`. Counts for the current plan only if this worker runs one
  // of its tasks.
  workerFinished(agentId: string, outcome: string, tokens = 0): AgentRecord | undefined {
    const record = this.agents.get(agentId)
    if (record && this.current?.tasks.includes(record.task)) {
      this.finished.set(record.task.id, outcome)
      this.tokens += tokens
    }
    return record
  }

  // The Agent call of an accepted launch returned: the worker is over even if its turn end was never seen.
  // Returns the task's id.
  launchReturned(toolUseId: string | undefined, failed: boolean): number | undefined {
    const id = toolUseId === undefined ? undefined : this.launchCalls.get(toolUseId)
    if (id !== undefined && !this.finished.has(id)) this.finished.set(id, failed ? 'error' : 'answer')
    return id
  }

  agentRecord(agentId: string): AgentRecord | undefined {
    return this.agents.get(agentId)
  }

  effortFor(agentId?: string): Effort | undefined {
    if (agentId !== undefined) {
      const known = this.agents.get(agentId)
      if (known) return known.task.effort
      // A worker whose launch has not returned its id yet: safe to guess only if every such launch agrees.
      const efforts = new Set([...this.starting.values()].map(t => t.effort))
      return efforts.size === 1 ? [...efforts][0] : undefined
    }
    if (this.mode !== 'executing') return undefined
    const mainEfforts = (this.current?.tasks ?? []).filter(t => t.route === 'main').map(t => t.effort)
    if (mainEfforts.length === 0) return undefined
    return mainEfforts.reduce((a, b) => (EFFORTS.indexOf(b) > EFFORTS.indexOf(a) ? b : a))
  }

  // Back to running the plan, keeping only what is safely done: workers that answered. A worker that was
  // cut off or failed may be launched again.
  private resume(plan: Plan): PromptAction {
    const done = this.answered()
    this.mode = 'executing'
    this.looks = 0
    this.resetProgress()
    for (const id of done) {
      this.launched.add(id)
      this.finished.set(id, 'answer')
    }
    return { context: resumedContext(plan, done), log: resumedLog(done.length, this.workers().length) }
  }

  private workers(): Task[] {
    return (this.current?.tasks ?? []).filter(t => t.route === 'worker')
  }

  // Ids of the worker tasks whose worker answered.
  private answered(): number[] {
    return this.workers().filter(t => this.finished.get(t.id) === 'answer').map(t => t.id)
  }

  // The main chat's turn ended. A plan that was cut short, or whose workers have not all answered, is kept
  // as paused; the returned line tells the user so.
  completeMainTurn(reason = 'answer'): string | undefined {
    if (this.mode !== 'executing') return undefined
    const total = this.workers().length
    const left = total - this.answered().length
    if (reason === 'answer' && left === 0) {
      this.mode = 'idle'
      this.current = undefined
      this.resetProgress()
      this.tokens = 0
      return undefined
    }
    this.mode = 'paused'
    return pausedLog(left, total)
  }

  markCompacted(): void {
    this.fullBriefing = true
  }

  statusText(): string | undefined {
    switch (this.mode) {
      case 'off': return undefined
      case 'idle': return 'orchestrator on'
      case 'executing': {
        const total = this.workers().length
        if (total === 0) return 'orchestrator on · running plan'
        const used = this.tokens > 0 ? ` · ${formatTokens(this.tokens)} tokens` : ''
        return `orchestrator on · ${this.answered().length}/${total} workers done${used}`
      }
      case 'paused': return 'orchestrator on · plan paused ("continue" resumes)'
      case 'pending': {
        if (this.escalation) return `orchestrator on · retry pending (task ${this.escalation.id})`
        const n = this.current?.tasks.length ?? 0
        return `orchestrator on · plan pending (${n} task${n === 1 ? '' : 's'})`
      }
    }
  }
}
