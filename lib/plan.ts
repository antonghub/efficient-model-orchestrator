import { EFFORTS, MODELS } from './constants.js'
import type { Effort, Model, Plan, Task } from './types.js'

type Validation = { ok: true; plan: Plan } | { ok: false; error: string }

const isText = (v: unknown) => typeof v === 'string' && v.trim() !== ''

export function validatePlan(input: unknown, models: readonly Model[] = MODELS): Validation {
  const tasks = (input as { tasks?: unknown } | null)?.tasks
  if (typeof input !== 'object' || input === null || !Array.isArray(tasks)) {
    return { ok: false, error: 'the plan must be an object with a tasks list' }
  }
  if (tasks.length === 0) return { ok: false, error: 'the plan has no tasks' }

  const ids = new Set<number>()
  for (const raw of tasks) {
    const id = (raw as { id?: unknown })?.id
    if (typeof id !== 'number' || !Number.isInteger(id) || id < 1) {
      return { ok: false, error: 'every task needs an id that is a positive whole number' }
    }
    if (ids.has(id)) return { ok: false, error: `task ${id}: id is used twice` }
    ids.add(id)
  }

  const out: Task[] = []
  for (const raw of tasks as Record<string, unknown>[]) {
    const id = raw.id as number
    const fail = (why: string): Validation => ({ ok: false, error: `task ${id}: ${why}` })
    if (!isText(raw.title)) return fail('title is missing')
    if (!isText(raw.reason)) return fail('reason is missing')
    if (raw.route !== 'worker' && raw.route !== 'main') return fail('route must be worker or main')
    if (raw.route === 'worker') {
      if (raw.model === undefined) return fail('a worker task needs a model')
      if (!models.includes(raw.model as Model)) return fail(`model must be one of ${models.join(', ')}`)
    } else if (raw.model !== undefined) {
      return fail('a main-chat task takes no model')
    }
    if (!EFFORTS.includes(raw.effort as Effort)) return fail(`effort must be one of ${EFFORTS.join(', ')}`)

    const after = raw.after
    if (after !== undefined) {
      if (!Array.isArray(after)) return fail('after must be a list of task ids')
      for (const other of after) {
        if (other === id) return fail('a task cannot wait for itself')
        if (!ids.has(other as number)) return fail(`after names task ${other}, which is not in the plan`)
      }
    }

    const task: Task = { id, title: raw.title as string, route: raw.route, effort: raw.effort as Effort, reason: raw.reason as string }
    if (raw.route === 'worker') task.model = raw.model as Model
    if (after !== undefined && after.length > 0) task.after = [...(after as number[])]
    out.push(task)
  }
  const loop = findLoop(out)
  if (loop) return { ok: false, error: `the after lists form a loop: ${loop.join(' → ')}` }
  return { ok: true, plan: { tasks: out } }
}

// The first chain of tasks that wait for each other in a circle, as [2, 3, 4, 2]; undefined when there is none.
function findLoop(tasks: Task[]): number[] | undefined {
  const after = new Map(tasks.map(t => [t.id, t.after ?? []]))
  const clear = new Set<number>()
  const path: number[] = []
  const visit = (id: number): number[] | undefined => {
    const at = path.indexOf(id)
    if (at !== -1) return [...path.slice(at), id]
    if (clear.has(id)) return undefined
    path.push(id)
    for (const other of after.get(id) ?? []) {
      const loop = visit(other)
      if (loop) return loop
    }
    path.pop()
    clear.add(id)
    return undefined
  }
  for (const task of tasks) {
    const loop = visit(task.id)
    if (loop) return loop
  }
  return undefined
}

// "claude-opus-5-5" → "opus"; undefined for a model that isn't one of ours.
export function modelAlias(modelIdOrAlias: string): Model | undefined {
  return MODELS.find(m => modelIdOrAlias.toLowerCase().includes(m))
}

export function modelLabel(modelIdOrAlias: string): string {
  const found = modelAlias(modelIdOrAlias)
  return found ? found.charAt(0).toUpperCase() + found.slice(1) : modelIdOrAlias
}

export function routeLabel(task: Task, mainModelLabel: string, fableCredits = false): string {
  if (task.route === 'main') return `Main chat (${mainModelLabel} · ${task.effort})`
  const paid = fableCredits && task.model === 'fable' ? ' (paid credits)' : ''
  return `${modelLabel(task.model ?? '')} · ${task.effort}${paid}`
}

// [1, 2, 3, 5] → "1–3, 5"
function formatAfter(ids: number[]): string {
  const sorted = [...ids].sort((a, b) => a - b)
  const parts: string[] = []
  for (let i = 0; i < sorted.length; i++) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1] === (sorted[j] as number) + 1) j++
    parts.push(j > i ? `${sorted[i]}–${sorted[j]}` : String(sorted[i]))
    i = j
  }
  return parts.join(', ')
}

// A retry on offer: the task as it ran (`from`) and as it would run again (`to`).
export type Offer = { id: number; title: string; from: Task; to: Task; reason: string }

export function renderOffer(offer: Offer, mainModelLabel: string, fableCredits = false): string {
  const reason = /[.!?]$/.test(offer.reason) ? offer.reason : offer.reason + '.'
  const label = (task: Task) => routeLabel(task, mainModelLabel, fableCredits)
  return [
    `Retry task ${offer.id}: ${offer.title}`,
    `   ${label(offer.from)} → ${label(offer.to)}: ${reason}`,
    '',
    `Reply "OK" to retry, "no" to keep the result, or pick a route: "${offer.id}. opus high"`,
  ].join('\n')
}

export function renderPlan(plan: Plan, mainModelLabel: string, fableCredits = false): string {
  const n = plan.tasks.length
  const blocks = plan.tasks.map(task => {
    const after = task.after?.length ? ` (after ${formatAfter(task.after)})` : ''
    const reason = /[.!?]$/.test(task.reason) ? task.reason : task.reason + '.'
    return `${task.id}. ${task.title}${after}\n   ${routeLabel(task, mainModelLabel, fableCredits)}: ${reason}`
  })
  return [`Plan: ${n} task${n === 1 ? '' : 's'}`, ...blocks, 'Reply "OK", or change a route: "1. sonnet high"'].join('\n\n')
}
