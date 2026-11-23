// Every string Claude or the user reads, so wording lives in one place.

import { EFFORTS } from './constants.js'
import { modelLabel, routeLabel } from './plan.js'
import type { Model, Plan, Task } from './types.js'

export const DENY_PENDING = "A plan is waiting for the user's reply. End your turn now."
export const DENY_PLAN_FIRST = 'Orchestrator: plan first. Call mcp__efficient-model-orchestrator__plan now; put further reading into a task (usually a haiku worker).'
export const DENY_NO_PLAN = 'Orchestrator: no approved plan. Call mcp__efficient-model-orchestrator__plan and wait for approval before launching workers.'
export const DENY_NO_TAG = 'Orchestrator: start the Agent description with the task tag, like "[T2] Fix token refresh".'
export const DENY_FORK = "Orchestrator: forks always run on the main chat's model, so they aren't allowed. Use a normal worker."
export const DENY_NESTED = "Orchestrator: workers can't start their own subagents. Do this work yourself."
export const denyNotWorker = (id: number) => `Orchestrator: task ${id} is not an approved worker task. Do main-chat tasks yourself, or call the plan tool again.`
export const denyTwice = (id: number) =>
  `Orchestrator: task ${id} was already launched. To retry it on a stronger route, call mcp__efficient-model-orchestrator__escalate; any other change needs a new plan.`
export const denyWaits = (id: number, waiting: number[]) =>
  `Orchestrator: task ${id} waits for task${waiting.length === 1 ? '' : 's'} ${waiting.join(', ')}. Launch it once ${waiting.length === 1 ? 'that worker has' : 'those workers have'} finished.`
export const pausedLog = (left: number, total: number) =>
  `Plan paused${left > 0 ? `: ${left} of ${total} worker${total === 1 ? '' : 's'} not finished` : ' before it finished'}. Reply "continue" to resume it; any other message drops it.`
export const resumedLog = (done: number, total: number) =>
  total > 0 ? `Resuming plan: ${done} of ${total} worker${total === 1 ? '' : 's'} done` : 'Resuming plan'
export const DENY_GUARD_FAILED = 'Orchestrator: the launch check failed, so this worker was not started.'
export const CHECK_GUARD_FAILED = 'Orchestrator: the tool check failed, so this call was not allowed. Tell the user; /efficient-model-orchestrator-off turns the orchestrator off.'
export const PROMPT_GUARD_FAILED = 'The orchestrator could not handle this message, so it was not sent. Send it again, or run /efficient-model-orchestrator-off to turn the orchestrator off.'

const FABLE_ROUTE = {
  none: '- Hardest or novel problems: opus xhigh. Fable is not available; never propose it.',
  included: '- Hardest or novel problems, or after opus failed: fable high',
  credits: '- Hardest or novel problems, or after opus failed: fable high, only when worth paying for: it spends paid usage credits',
}

export const fullBriefing = (fable: keyof typeof FABLE_ROUTE) => `Model/effort orchestrator is ON. For every request from the user:
1. Plan first. You may make up to 3 read-only tool calls to scope the plan; put any bigger reading into a task.
2. Call mcp__efficient-model-orchestrator__plan with the tasks. Each task gets a route: a worker (a subagent on a model and effort) or "main" (you do it here). The tool shows the plan to the user; do not repeat it. Then end your turn and wait.
3. When the user approves, you get the approved routes. Launch each worker with the Agent tool, its description starting "[T<n>]". Do main-chat tasks yourself. Sum up each worker's result in a few lines.
4. A worker that failed, or whose result is too weak to use: call mcp__efficient-model-orchestrator__escalate with its task number and why. The user gets an offer to retry it one step stronger. Then end your turn and wait.
5. Anything else not in the approved plan (a new task, another route) needs a new plan.
Plain chat, or a question about the current plan: just answer, no plan.

Routes (starting points, not measured):
- Search, read and summarize files, run tests or builds, git, renames, commit messages: haiku medium
- Lookups needing some judgment, simple docs: haiku high
- Small, clearly specified code change with tests: sonnet high (never sonnet medium)
- Normal engineering, debugging, review, explanations: opus medium
- Hard debugging, architecture, security, multi-file features: opus high or xhigh
${FABLE_ROUTE[fable]}
- Small task, or one that needs this conversation's context: main
Adjust: no tests and high stakes, one step stronger; tests or another check exist, start cheaper; a worker that will read over 100K tokens, avoid haiku.
Titles say what the task does in about 12 words; reasons say why this route in about 15 words.`
export const SHORT_REMINDER = 'Orchestrator is on: plan this request with mcp__efficient-model-orchestrator__plan first (up to 3 read-only looks), then end your turn. Plain chat or questions about the current plan: just answer.'
export const REPLAN_CONTEXT = "The user replied to the pending plan without approving it. If they asked a question about the plan, answer it briefly and end your turn; the plan stays pending. Otherwise call mcp__efficient-model-orchestrator__plan with a revised plan and end your turn."
export const PLAN_TOOL_DESCRIPTION = 'Model/effort orchestrator: propose the plan for the current request, one entry per task with its route (a worker subagent on a model and effort, or main for this chat). Shows the plan to the user and waits for approval. Use only while the orchestrator is on.'
export const PLAN_SHOWN = 'The plan is shown to the user. Do not repeat it. End your turn now and wait for their reply.'
export const PLAN_OFF = 'The orchestrator is off, so no plan is needed. Carry on with the request.'
export const planInvalid = (error: string) => `Plan not accepted: ${error}. Fix it and call the tool again.`
export const OFF_TEXT = 'Orchestrator off.'
export const NO_STATS = 'No worker runs are logged yet. Approve a plan with a worker task first; the report is built from the usage logs.'
export const NO_STATS_SESSION = 'No worker runs in this session yet. Every session: /efficient-model-orchestrator-stats all'

// 950 → "950", 41300 → "41K", 1240000 → "1.2M"
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens)
  if (tokens < 999_500) return `${Math.round(tokens / 1000)}K`
  return `${(tokens / 1_000_000).toFixed(1)}M`
}
export const DROP_FABLE_OFF = "Fable is off in the orchestrator's settings, so nothing was approved. Pick another model, or turn Fable on in /config and run /reload-plugins."
export const FABLE_BLOCKED_NOTE = "Fable needs usage credits this account doesn't have. Don't propose it again; call mcp__efficient-model-orchestrator__plan to re-plan this task on another model."
export const FABLE_BLOCKED_LOG = "Fable needs usage credits, so the orchestrator won't propose it for 7 days. You can still edit a task to fable."
export const PLAN_WORKER = 'Only the main chat plans. Finish your task with what you have.'

export const ESCALATE_TOOL_DESCRIPTION = 'Model/effort orchestrator: offer the user a retry of one worker task on the next stronger route, after its worker failed or its result was too weak to use. Shows the offer and waits for their reply. Use only while an approved plan is running.'
export const ESCALATE_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    task: { type: 'integer', minimum: 1, description: 'Number of the worker task to retry' },
    reason: { type: 'string', description: 'What went wrong with the first attempt, in about 15 words' },
  },
  required: ['task', 'reason'],
}
export const ESCALATE_SHOWN = 'The retry offer is shown to the user. Do not repeat it. End your turn now and wait for their reply.'
export const ESCALATE_OFF = 'The orchestrator is off, so no offer is needed. Retry the task however you see fit.'
export const ESCALATE_NO_PLAN = 'Orchestrator: no approved plan is running, so there is no task to retry. Call mcp__efficient-model-orchestrator__plan instead.'
export const ESCALATE_BAD_INPUT = 'Offer not accepted: give the task number as a whole number and a short reason. Fix it and call the tool again.'
export const escalateNotWorker = (id: number) => `Orchestrator: task ${id} is not a worker task of the running plan, so it has no route to step up.`
export const escalateNotFinished = (id: number) => `Orchestrator: task ${id} has no finished worker yet. Launch it, or wait for its result, before offering a retry.`
export const escalateNoStronger = (id: number) => `Orchestrator: task ${id} is already on the strongest route on offer. Call mcp__efficient-model-orchestrator__plan to re-plan it another way.`
export const escalateHint = (id: number) =>
  `Orchestrator: the worker for task ${id} failed. If the task still matters, call mcp__efficient-model-orchestrator__escalate with the task number and a short reason; the user then gets an offer to retry it on a stronger route.`
export const RETRY_REPLY_CONTEXT = 'The user replied to the retry offer without accepting or declining it. If they asked a question about it, answer briefly and end your turn; the offer stays open. If they want something else, call mcp__efficient-model-orchestrator__plan with a new plan and end your turn.'
export const retryDeclinedContext = (id: number) => `The user declined the retry: keep task ${id}'s result as it is and carry on with the approved plan. Do not offer this retry again.`
export const keepingLine = (id: number) => `Keeping task ${id} as it is`
export const retryLine = (task: Task, mainModelLabel: string, fableCredits = false) => `Retrying task ${task.id} on ${routeLabel(task, mainModelLabel, fableCredits)}`
export const DROP_STILL_WORKING = 'Claude is still finishing its turn. Send your reply again once it stops.'
export const MIDTURN_NOTE = 'Orchestrator: this message arrived while you were working. Anything it asks for that is not in the approved plan needs a new plan.'

export const planToolSchema = (models: readonly Model[]) => ({
  type: 'object',
  properties: {
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer', minimum: 1 },
          title: { type: 'string', description: 'What the task does, in about 12 words' },
          route: { type: 'string', enum: ['worker', 'main'] },
          model: { type: 'string', enum: [...models], description: 'Worker tasks only' },
          effort: { type: 'string', enum: [...EFFORTS] },
          reason: { type: 'string', description: 'Why this route, in about 15 words' },
          after: { type: 'array', items: { type: 'integer' }, description: 'Ids of tasks this one waits for' },
        },
        required: ['id', 'title', 'route', 'effort', 'reason'],
      },
    },
  },
  required: ['tasks'],
})

const routeOf = (t: Task) => (t.route === 'worker' ? `T${t.id} worker ${t.model}/${t.effort}` : `T${t.id} main chat/${t.effort}`)

// `done`: ids of the worker tasks whose worker already answered.
export function resumedContext(plan: Plan, done: readonly number[]): string {
  const finished = done.length > 0 ? ` Workers already finished: ${done.map(id => `T${id}`).join(', ')}; use their earlier results and never launch them again.` : ''
  const open = plan.tasks.filter(t => !done.includes(t.id)).map(routeOf).join('; ')
  return `The user resumed the paused plan; its routes are approved as before.${finished} Still open: ${open || 'nothing to launch'}. Launch each open worker with the Agent tool, its description starting "[T<n>]". Do the main-chat tasks you have not finished yourself. Launch nothing else; to change a route or add a task, call mcp__efficient-model-orchestrator__plan again. When done, sum up each worker's result in a few lines.`
}

// `id`: the task whose retry the user approved; `done`: ids of the other worker tasks that already answered.
export function retryApprovedContext(plan: Plan, id: number, done: readonly number[]): string {
  const task = plan.tasks.find(t => t.id === id) as Task
  const how = task.route === 'worker'
    ? `Launch it now with the Agent tool, its description starting "[T${id}]", and tell the worker what the first attempt got wrong.`
    : 'Do it yourself now.'
  const rest = plan.tasks.filter(t => t.id !== id && !done.includes(t.id)).map(routeOf).join('; ')
  return `Retry approved: ${routeOf(task)}. ${how}${rest ? ` The rest of the plan stands: ${rest}.` : ''} Launch nothing else; to change another route or add a task, call mcp__efficient-model-orchestrator__plan again. When done, sum up each worker's result in a few lines.`
}

export function approvedContext(plan: Plan): string {
  const routes = plan.tasks.map(routeOf).join('; ')
  return `Plan approved. Routes: ${routes}. Launch each worker with the Agent tool, its description starting "[T<n>]". Do main-chat tasks yourself. Launch nothing else; to change a route or add a task, call mcp__efficient-model-orchestrator__plan again. If a worker fails or its result is too weak to use, call mcp__efficient-model-orchestrator__escalate to offer a retry on a stronger route. When done, sum up each worker's result in a few lines.`
}

export function onText(mainModelId: string): string {
  const base = 'Orchestrator on for this session: every request gets a plan you approve first.'
  const label = modelLabel(mainModelId)
  if (label === 'Opus' || label === 'Fable') return base
  return base + ' The main chat does the planning; Opus · medium is recommended for it (model menu).'
}
