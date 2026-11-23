// One JSON line per finished worker turn, for tuning the routes later.

type LoggedRoute = { route: 'worker' | 'main'; model?: string; effort: string }

export type LogEntry = {
  ts: number
  sessionId: string
  agentId: string
  taskId: number
  title: string
  recommended: LoggedRoute
  approved: LoggedRoute
  edited: boolean
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  durationMs: number
  outcome: string
  // The main chat's model when the worker finished ("opus"), if known: the savings report's "normal" baseline.
  mainModel?: string
}

export function logLine(entry: LogEntry): string {
  return JSON.stringify(entry) + '\n'
}

export function logDir(home: string): string {
  return `${home}/.claude/efficient-model-orchestrator/logs`
}

export function logPath(home: string, sessionId: string): string {
  return `${logDir(home)}/${sessionId}.jsonl`
}
