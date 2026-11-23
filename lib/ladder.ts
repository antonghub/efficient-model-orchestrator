import { EFFORTS, MODELS, ROUTE_LADDER } from './constants.js'
import type { Effort, Model, Task } from './types.js'

export type Step = 'cheaper' | 'stronger'

// Orders any route, on the ladder or not: by model first, then by effort.
const rank = (model: Model, effort: Effort): number => MODELS.indexOf(model) * EFFORTS.length + EFFORTS.indexOf(effort)

function stepEffort(task: Task, step: Step): Task {
  const effort = EFFORTS[EFFORTS.indexOf(task.effort) + (step === 'stronger' ? 1 : -1)]
  return effort ? { ...task, effort } : task
}

// One step cheaper or stronger. A worker moves to the next recommended route among the allowed models; past
// either end of those, and for a main-chat task, only the effort moves. Returns the same task when nothing is left.
export function stepRoute(task: Task, step: Step, models: readonly Model[] = MODELS): Task {
  if (task.route !== 'worker' || task.model === undefined) return stepEffort(task, step)
  const at = rank(task.model, task.effort)
  const rungs = ROUTE_LADDER.filter(r => models.includes(r.model))
  const rung = step === 'stronger'
    ? rungs.find(r => rank(r.model, r.effort) > at)
    : [...rungs].reverse().find(r => rank(r.model, r.effort) < at)
  return rung ? { ...task, model: rung.model, effort: rung.effort } : stepEffort(task, step)
}
