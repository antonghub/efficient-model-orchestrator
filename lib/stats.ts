// The savings report: what the usage logs add up to, against running every worker on Opus.

import { MODELS } from './constants.js'
import type { LogEntry } from './log.js'
import { modelLabel } from './plan.js'
import { NO_STATS, NO_STATS_SESSION, formatTokens } from './text.js'
import type { Model } from './types.js'

// List prices in dollars per million tokens (input, output). Estimates only: a subscription's included
// usage is not billed this way, and Haiku's higher price above 100K prompt tokens is left out.
export const PRICES: Record<Model, { input: number; output: number }> = {
  haiku: { input: 0.1, output: 0.5 },
  sonnet: { input: 2, output: 10 },
  opus: { input: 4, output: 20 },
  fable: { input: 10, output: 50 },
}
// What a cached token costs, as a share of the input price.
const CACHE_READ = 0.1
const CACHE_WRITE = 1.25

export type Stats = {
  runs: number
  sessions: number
  // Per approved model, cheapest first. inputTokens counts every prompt token, cached or not.
  byModel: { model: Model; runs: number; inputTokens: number; outputTokens: number; cost: number }[]
  cost: number
  // The same tokens on the main chat's model of each worker's session (Opus where the log doesn't say): what
  // the work would have cost without the orchestrator.
  normalCost: number
  edited: number
  // Per recommended route, most changed first. mostly: the route its changed runs went to most often.
  routes: { route: string; runs: number; edited: number; mostly: string | undefined }[]
  // Workers whose turn did not end in an answer.
  failed: number
}

type Usage = Pick<LogEntry, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>
const TOKEN_FIELDS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const

function parseEntry(line: string): (LogEntry & { approved: { model: Model } }) | undefined {
  try {
    const entry = JSON.parse(line)
    if (entry === null || typeof entry !== 'object') return undefined
    if (!MODELS.includes(entry.approved?.model) || entry.recommended === null || typeof entry.recommended !== 'object') return undefined
    if (TOKEN_FIELDS.some(field => typeof entry[field] !== 'number')) return undefined
    return entry
  } catch {
    return undefined
  }
}

function costAt(model: Model, usage: Usage): number {
  const price = PRICES[model]
  const input = usage.inputTokens + usage.cacheReadTokens * CACHE_READ + usage.cacheWriteTokens * CACHE_WRITE
  return (input * price.input + usage.outputTokens * price.output) / 1_000_000
}

const labelOf = (route: { route: string; model?: string; effort: string }): string =>
  `${route.route === 'main' ? 'Main chat' : modelLabel(route.model ?? '')} · ${route.effort}`

// `lines`: the lines of the log files, in any order; anything that is not a log entry is skipped.
export function summarize(lines: readonly string[]): Stats {
  const sessions = new Set<string>()
  const models = new Map<Model, Stats['byModel'][number]>()
  const routes = new Map<string, { runs: number; edited: number; went: Map<string, number> }>()
  let runs = 0, cost = 0, normalCost = 0, edited = 0, failed = 0
  for (const line of lines) {
    const entry = parseEntry(line)
    if (!entry) continue
    runs++
    sessions.add(entry.sessionId)
    if (entry.outcome !== 'answer') failed++
    const model = entry.approved.model
    const spent = costAt(model, entry)
    cost += spent
    normalCost += costAt(MODELS.includes(entry.mainModel as Model) ? (entry.mainModel as Model) : 'opus', entry)
    const sum = models.get(model) ?? { model, runs: 0, inputTokens: 0, outputTokens: 0, cost: 0 }
    sum.runs++
    sum.inputTokens += entry.inputTokens + entry.cacheReadTokens + entry.cacheWriteTokens
    sum.outputTokens += entry.outputTokens
    sum.cost += spent
    models.set(model, sum)
    const recommended = labelOf(entry.recommended)
    const route = routes.get(recommended) ?? { runs: 0, edited: 0, went: new Map<string, number>() }
    route.runs++
    if (entry.edited === true) {
      edited++
      route.edited++
      const to = labelOf(entry.approved)
      route.went.set(to, (route.went.get(to) ?? 0) + 1)
    }
    routes.set(recommended, route)
  }
  return {
    runs,
    sessions: sessions.size,
    byModel: MODELS.flatMap(model => models.get(model) ?? []),
    cost,
    normalCost,
    edited,
    routes: [...routes]
      .map(([route, r]) => ({ route, runs: r.runs, edited: r.edited, mostly: [...r.went].sort((a, b) => b[1] - a[1])[0]?.[0] }))
      .sort((a, b) => b.edited - a.edited || b.runs - a.runs),
    failed,
  }
}

const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`
const money = (dollars: number): string => (dollars > 0 && dollars < 0.005 ? '<$0.01' : `$${dollars.toFixed(2)}`)
const percent = (part: number, whole: number): number => (whole > 0 ? Math.round((part / whole) * 100) : 0)
const price = (dollars: number): string => `$${dollars < 1 ? dollars.toFixed(2) : dollars}`
const PRICE_LIST = MODELS.map(m => `${modelLabel(m)} ${price(PRICES[m].input)}/${price(PRICES[m].output)}`).join(', ')
const STATS_NOTE = `Estimates at list prices per million tokens in and out (${PRICE_LIST}); cache reads count at 10% of the input price, cache writes at 125%. Normal cost puts the same tokens on the main chat's model, Opus where the log doesn't name it. Workers only: the main chat's tokens are not logged.`

// Which logs the report covers: the current session's, or every session's.
export type StatsScope = 'session' | 'all'

// Blank lines and "- " items, so the report reads the same as plain text and as Markdown.
export function renderStats(stats: Stats, scope: StatsScope = 'all'): string {
  if (stats.runs === 0) return scope === 'session' ? NO_STATS_SESSION : NO_STATS
  const saved = stats.normalCost - stats.cost
  const lines = [
    // No "Orchestrator:" label: the app already puts the plugin's name before a command's output.
    `${count(stats.runs, 'worker run')} in ${scope === 'session' ? 'this session' : count(stats.sessions, 'session')}`,
    '',
    ...stats.byModel.map(m => `- ${modelLabel(m.model)}: ${count(m.runs, 'run')} · ${formatTokens(m.inputTokens)} tokens in · ${formatTokens(m.outputTokens)} out · ${money(m.cost)}`),
    '',
    `- Normal cost: ${money(stats.normalCost)} (every worker on the main chat's model)`,
    `- Efficient cost: ${money(stats.cost)} (each worker on its approved route)`,
    `- ${saved >= 0 ? 'Saved' : 'Over by'}: ${money(Math.abs(saved))} (${percent(Math.abs(saved), stats.normalCost)}%)`,
    '',
    `Routes you changed: ${stats.edited} of ${stats.runs} (${percent(stats.edited, stats.runs)}%)`,
    ...stats.routes.filter(r => r.edited > 0).map(r => `- ${r.route}: ${r.edited} of ${r.runs}, mostly to ${r.mostly}`),
  ]
  if (stats.failed > 0) lines.push('', `Workers that did not answer: ${stats.failed} of ${stats.runs}`)
  lines.push('', STATS_NOTE)
  if (scope === 'session') lines.push('', 'Every session: /efficient-model-orchestrator-stats all')
  return lines.join('\n')
}
