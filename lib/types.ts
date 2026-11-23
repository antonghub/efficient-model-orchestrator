export type Model = 'haiku' | 'sonnet' | 'opus' | 'fable'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type Task = {
  id: number
  title: string
  route: 'worker' | 'main'
  model?: Model
  effort: Effort
  reason: string
  after?: number[]
}

export type Plan = { tasks: Task[] }

// off: never proposed. included: part of the plan. credits: spends paid usage credits, and the plan says so.
export type FableAccess = 'off' | 'included' | 'credits'

export type Mode = 'off' | 'idle' | 'pending' | 'executing' | 'paused'
