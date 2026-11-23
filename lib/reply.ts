import { DEFAULT_EFFORT, EFFORTS, MODELS } from './constants.js'
import { type Step, stepRoute } from './ladder.js'
import { routeLabel } from './plan.js'
import type { Effort, Model, Plan, Task } from './types.js'

// A task whose route the reply changed, with the route it ends up on.
export type Edit = { id: number; model?: Model | 'main'; effort?: Effort }

type Reply = { kind: 'approve'; plan: Plan; edits: Edit[] } | { kind: 'other' }
type Change = { model?: Model | 'main'; effort?: Effort; step?: Step }
type Target = { id: number } | { from: number; to: number } | 'all'

const OTHER: Reply = { kind: 'other' }

// Longer phrases first, so "go ahead" is not read as "go" plus a stray word.
const APPROVALS = ['looks good', 'sounds good', 'all good', 'go ahead', 'do it', 'approved', 'approve', 'proceed',
  'okay', 'ok', 'yeah', 'yes', 'yep', 'sure', 'lgtm', 'go', 'k', 'y']
const RESUMES = ['keep going', 'carry on', 'continue', 'resume', 'go on']
const DECLINES = ['never mind', 'nevermind', 'keep it', 'cancel', 'nope', 'skip', 'stop', 'nah', 'no', 'n']
// Politeness that may sit beside any of the above and means nothing by itself.
const FILLERS = ['thank you', 'please', 'thanks', 'pls']

// The phrases from the list that the text is made of, as in "ok go ahead" or "Yes. Do it!", filler left
// out; undefined when the text holds anything else.
function phrasesIn(text: string, phrases: readonly string[]): string[] | undefined {
  let rest = text.toLowerCase().replace(/[.!,]+/g, ' ').replace(/\s+/g, ' ').trim()
  const found: string[] = []
  while (rest !== '') {
    const phrase = [...phrases, ...FILLERS].find(p => rest === p || rest.startsWith(`${p} `))
    if (!phrase) return undefined
    if (!FILLERS.includes(phrase)) found.push(phrase)
    rest = rest.slice(phrase.length).trim()
  }
  return found
}

const isFiller = (text: string): boolean => phrasesIn(text, [])?.length === 0
export const isApproval = (text: string): boolean => (phrasesIn(text, APPROVALS)?.length ?? 0) > 0
// "continue", "ok keep going": a resume word must be there, since a bare "yes" may answer something else.
export const isResume = (text: string): boolean => phrasesIn(text, [...RESUMES, ...APPROVALS])?.some(p => RESUMES.includes(p)) ?? false
export const isDecline = (text: string): boolean => (phrasesIn(text, DECLINES)?.length ?? 0) > 0

// "sonnet high" → { model: 'sonnet', effort: 'high' }; "stronger" → { step: 'stronger' }.
function parseChange(text: string): Change | undefined {
  const words = text.split(/\s+/)
  if (words.length > 2) return undefined
  const change: Change = {}
  for (const word of words) {
    const effort = word === 'med' ? 'medium' : word
    if (word === 'stronger' || word === 'cheaper' || word === 'weaker') {
      if (words.length > 1) return undefined
      change.step = word === 'stronger' ? 'stronger' : 'cheaper'
    } else if (word === 'main' || MODELS.includes(word as Model)) {
      if (change.model !== undefined) return undefined
      change.model = word as Model | 'main'
    } else if (EFFORTS.includes(effort as Effort)) {
      if (change.effort !== undefined) return undefined
      change.effort = effort as Effort
    } else {
      return undefined
    }
  }
  return change
}

// "1. sonnet high", "t2 stronger", "2-4 haiku", "all cheaper"; undefined when the part doesn't parse.
function parseEdit(part: string): { target: Target; change: Change } | undefined {
  const all = /^(?:all|every|everything)(?:\s*:\s*|\s+)(.+)$/.exec(part)
  const numbered = all ? null : /^(?:tasks?\s*|t|#)?(\d+)(?:\s*[-–]\s*(\d+))?(?:\s*[.:)]\s*|\s+)(.+)$/.exec(part)
  if (!all && !numbered) return undefined
  const change = parseChange((all ? all[1] : (numbered as RegExpExecArray)[3]) ?? '')
  if (!change) return undefined
  if (all) return { target: 'all', change }
  const [, first, last] = numbered as RegExpExecArray
  return { target: last === undefined ? { id: Number(first) } : { from: Number(first), to: Number(last) }, change }
}

function applyChange(task: Task, change: Change, models: readonly Model[]): Task {
  if (change.step) return stepRoute(task, change.step, models)
  const { model: _model, ...rest } = task
  if (change.model === 'main') return { ...rest, route: 'main', effort: change.effort ?? task.effort }
  if (change.model !== undefined) {
    const effort = change.effort ?? (task.route === 'worker' ? task.effort : DEFAULT_EFFORT[change.model])
    return { ...rest, route: 'worker', model: change.model, effort }
  }
  return { ...task, effort: change.effort ?? task.effort }
}

const sameRoute = (a: Task, b: Task): boolean => a.route === b.route && a.model === b.model && a.effort === b.effort

// `models` are the models "stronger" and "cheaper" may step to; a model named outright is always taken.
export function parseReply(text: string, plan: Plan, models: readonly Model[] = MODELS): Reply {
  const parts = text.trim().toLowerCase().split(/[,;\n]+/).map(p => p.trim()).filter(p => p !== '')
  if (parts.length === 0) return OTHER

  // A task's own edit wins over an edit for a range or for all; those apply in the order written.
  const own = new Map<number, Change>()
  const bulk: { ids: number[]; change: Change }[] = []
  // A reply of nothing but "please" or "thanks" approves nothing.
  if (parts.every(isFiller)) return OTHER
  for (const part of parts) {
    if (isApproval(part) || isFiller(part)) continue
    const edit = parseEdit(part.replace(/[.!]+$/, ''))
    if (!edit) return OTHER
    const { target, change } = edit
    if (target === 'all') {
      bulk.push({ ids: plan.tasks.map(t => t.id), change })
    } else if ('id' in target) {
      if (!plan.tasks.some(t => t.id === target.id) || own.has(target.id)) return OTHER
      own.set(target.id, change)
    } else {
      const ids = plan.tasks.map(t => t.id).filter(id => id >= target.from && id <= target.to)
      if (ids.length === 0) return OTHER
      bulk.push({ ids, change })
    }
  }

  const edits: Edit[] = []
  const tasks = plan.tasks.map(task => {
    const mine = own.get(task.id)
    const changes = mine ? [mine] : bulk.filter(b => b.ids.includes(task.id)).map(b => b.change)
    const edited = changes.reduce((t, change) => applyChange(t, change, models), task)
    if (sameRoute(task, edited)) return task
    edits.push({ id: task.id, model: edited.route === 'main' ? 'main' : edited.model, effort: edited.effort })
    return edited
  })
  return { kind: 'approve', plan: { tasks }, edits }
}

export function startingLine(plan: Plan, edits: Edit[], mainModelLabel: string, fableCredits = false): string {
  if (edits.length === 0) {
    const n = plan.tasks.length
    return `Starting: plan as shown (${n} task${n === 1 ? '' : 's'})`
  }
  const changed = edits.map(edit => {
    const task = plan.tasks.find(t => t.id === edit.id) as Task
    return `${edit.id} → ${routeLabel(task, mainModelLabel, fableCredits)}`
  })
  return `Starting: ${changed.join('; ')}`
}
