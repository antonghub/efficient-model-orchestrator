import type { Effort, FableAccess, Model } from './types.js'

export const PLUGIN_NAME = 'efficient-model-orchestrator'
export const PLAN_TOOL_NAME = 'plan'
export const PLAN_TOOL = 'mcp__efficient-model-orchestrator__plan'
export const ESCALATE_TOOL_NAME = 'escalate'
export const ESCALATE_TOOL = 'mcp__efficient-model-orchestrator__escalate'
export const CMD_ON = 'efficient-model-orchestrator-on'
export const CMD_OFF = 'efficient-model-orchestrator-off'
export const CMD_STATS = 'efficient-model-orchestrator-stats'

export const MODELS: readonly Model[] = ['haiku', 'sonnet', 'opus', 'fable']
// Lowest first: the order decides which of several main-chat efforts wins.
export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

// Effort a task gets when an edit moves it from the main chat to a worker without naming one.
export const DEFAULT_EFFORT: Record<Model, Effort> = { haiku: 'medium', sonnet: 'high', opus: 'medium', fable: 'high' }

// The recommended routes, cheapest first. "cheaper" and "stronger" move a worker task one rung along it.
export const ROUTE_LADDER: readonly { model: Model; effort: Effort }[] = [
  { model: 'haiku', effort: 'medium' },
  { model: 'haiku', effort: 'high' },
  { model: 'sonnet', effort: 'high' },
  { model: 'opus', effort: 'medium' },
  { model: 'opus', effort: 'high' },
  { model: 'opus', effort: 'xhigh' },
  { model: 'fable', effort: 'high' },
]

export const FABLE_ACCESS: readonly FableAccess[] = ['off', 'included', 'credits']
// Where a learned "Fable needs credits" block is saved, and how long it lasts: Fable allowances are weekly.
export const FABLE_BLOCK_KEY = 'fable-block'
export const FABLE_BLOCK_MS = 7 * 24 * 60 * 60 * 1000

// Read-only tool calls allowed per request before a plan exists.
export const MAX_LOOKS = 3
export const LOOK_EXCLUDED: readonly string[] = ['Agent', 'WebFetch', 'WebSearch']
// Bookkeeping, not work on the request: allowed in every state and never counted as a look. Covers loading
// a tool or skill, task lists, questions to the user, and the orchestrator's own tools.
export const FREE_TOOLS: readonly string[] = [
  'ToolSearch', 'Skill', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'AskUserQuestion', 'ReadNotifications',
  PLAN_TOOL, ESCALATE_TOOL,
]
// The Desktop app's own task list and wrap-up tools.
export const FREE_TOOL_PREFIXES: readonly string[] = ['mcp__ccd_turn__']

// The savings report reads this many log files at most, newest first: one per session.
export const MAX_LOG_FILES = 200

// Workers name their task at the start of the Agent description, as in "[T2] Fix token refresh".
export const TASK_TAG = /^\[T(\d+)\]/
