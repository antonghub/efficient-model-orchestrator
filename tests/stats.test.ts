// The savings report: what the logs add up to, and how the command reads them.
import { expect, test } from 'claude-code/testing'
import { register } from '../hooks/register.js'
import { renderStats, summarize } from '../lib/stats.js'
import { NO_STATS, NO_STATS_SESSION, formatTokens } from '../lib/text.js'
import { fakeApi, hooksWith } from './helpers.js'

const HAIKU = { route: 'worker', model: 'haiku', effort: 'medium' }
const SONNET = { route: 'worker', model: 'sonnet', effort: 'high' }
const OPUS = { route: 'worker', model: 'opus', effort: 'high' }
const FABLE = { route: 'worker', model: 'fable', effort: 'high' }
const entry = (over: object = {}) => JSON.stringify({
  ts: 1, sessionId: 's1', agentId: 'a', taskId: 1, title: 't', recommended: HAIKU, approved: HAIKU, edited: false,
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, durationMs: 1, outcome: 'answer', ...over })
const M = 1_000_000
// Dollars to four decimals: sums of prices are not exact in floating point.
const rounded = (dollars: number) => Math.round(dollars * 10_000) / 10_000

test('counts runs and sessions, and skips lines that are not log entries', async () => {
  const stats = summarize([entry(), entry({ sessionId: 's2' }), '', 'not json', '{"x":1}', 'null', entry({ approved: { route: 'worker', model: 'gpt' } })])
  expect(stats.runs).toBe(2)
  expect(stats.sessions).toBe(2)
})
test('tokens and cost per approved model at list prices, cheapest model first', async () => {
  const stats = summarize([
    entry({ approved: SONNET, inputTokens: M / 2, outputTokens: M / 10 }),
    entry({ inputTokens: M, outputTokens: M }),
    entry({ inputTokens: M }),
  ])
  expect(stats.byModel.map(m => [m.model, m.runs, m.inputTokens, m.outputTokens])).toEqual([['haiku', 2, 2 * M, M], ['sonnet', 1, M / 2, M / 10]])
  expect(rounded(stats.byModel[0]!.cost)).toBe(0.7)
  expect(rounded(stats.byModel[1]!.cost)).toBe(2)
  expect(rounded(stats.cost)).toBe(2.7)
  // The same tokens at Opus prices: 2.5M in at $4 and 1.1M out at $20.
  expect(rounded(stats.normalCost)).toBe(32)
})
test('normal cost puts each worker on the main chat\'s model of its session; Opus where the log does not say', async () => {
  const stats = summarize([
    entry({ inputTokens: M, outputTokens: M, mainModel: 'sonnet' }),
    entry({ inputTokens: M, outputTokens: M, mainModel: 'fable' }),
    entry({ inputTokens: M, outputTokens: M }),
    entry({ inputTokens: M, outputTokens: M, mainModel: 'gpt' }),
  ])
  // Sonnet $12, Fable $60, then Opus $24 twice.
  expect(rounded(stats.normalCost)).toBe(120)
  expect(rounded(stats.cost)).toBe(2.4)
})
test('the note says what normal cost assumes', async () => {
  expect(renderStats(summarize([entry()]))).toContain("Normal cost puts the same tokens on the main chat's model, Opus where the log doesn't name it.")
})
test('cache reads cost a tenth of the input price and cache writes a quarter more; both count as tokens in', async () => {
  const stats = summarize([entry({ approved: OPUS, cacheReadTokens: M, cacheWriteTokens: M })])
  expect(stats.byModel[0]!.inputTokens).toBe(2 * M)
  expect(rounded(stats.cost)).toBe(5.4)
})
test('changed routes are counted per recommended route, with where they mostly went', async () => {
  const stats = summarize([
    entry({ approved: SONNET, edited: true }), entry({ approved: SONNET, edited: true }), entry({ approved: OPUS, edited: true }), entry(),
    entry({ recommended: OPUS, approved: OPUS }),
  ])
  expect(stats.edited).toBe(3)
  expect(stats.routes).toEqual([
    { route: 'Haiku · medium', runs: 4, edited: 3, mostly: 'Sonnet · high' },
    { route: 'Opus · high', runs: 1, edited: 0, mostly: undefined },
  ])
})
test('workers that did not answer are counted', async () => {
  expect(summarize([entry(), entry({ outcome: 'error' }), entry({ outcome: 'aborted' })]).failed).toBe(2)
})

test('the report states runs, cost per model, the saving against Opus and the changed routes', async () => {
  const text = renderStats(summarize([
    entry({ inputTokens: M, outputTokens: M }),
    entry({ sessionId: 's2', approved: SONNET, edited: true, inputTokens: M / 2, outputTokens: 41_300 }),
    entry({ sessionId: 's2', recommended: OPUS, approved: OPUS, inputTokens: 900, outputTokens: 0, outcome: 'error' }),
  ]))
  // The app already puts the plugin's name before a command's output, so the report doesn't repeat it.
  expect(text.split('\n')[0]).toBe('3 worker runs in 2 sessions')
  expect(text).toContain('Haiku: 1 run · 1.0M tokens in · 1.0M out · $0.60')
  expect(text).toContain('Sonnet: 1 run · 500K tokens in · 41K out · $1.41')
  expect(text).toContain('Opus: 1 run · 900 tokens in · 0 out · <$0.01')
  expect(text).toContain([
    '- Normal cost: $26.83 (every worker on the main chat\'s model)',
    '- Efficient cost: $2.02 (each worker on its approved route)',
    '- Saved: $24.81 (92%)',
  ].join('\n'))
  expect(text).toContain('Routes you changed: 1 of 3 (33%)')
  expect(text).toContain('Haiku · medium: 1 of 2, mostly to Sonnet · high')
  expect(text).not.toContain('Opus · high: 0 of 1')
  expect(text).toContain('Workers that did not answer: 1 of 3')
  expect(text).toContain('main chat')
})
test('routes that cost more than Opus would have are reported as over, not saved', async () => {
  const text = renderStats(summarize([entry({ approved: FABLE, inputTokens: M, outputTokens: M })]))
  expect(text).toContain('- Normal cost: $24.00')
  expect(text).toContain('- Efficient cost: $60.00')
  expect(text).toContain('- Over by: $36.00 (150%)')
  expect(text).toContain('Routes you changed: 0 of 1 (0%)')
  expect(text).not.toContain('did not answer')
})
test('with nothing logged, the report says so', async () => {
  expect(renderStats(summarize([]))).toBe(NO_STATS)
  expect(renderStats(summarize(['junk']))).toBe(NO_STATS)
})
test('for one session, the report says so on its first line and points to the report for every session', async () => {
  const text = renderStats(summarize([entry({ inputTokens: M }), entry({ approved: SONNET, edited: true })]), 'session')
  expect(text.split('\n')[0]).toBe('2 worker runs in this session')
  expect(text).toContain('Every session: /efficient-model-orchestrator-stats all')
  expect(renderStats(summarize([entry()]), 'session').split('\n')[0]).toBe('1 worker run in this session')
  expect(renderStats(summarize([entry()]))).not.toContain('Every session:')
})
test('with nothing logged in this session, the report says so', async () => {
  expect(renderStats(summarize([]), 'session')).toBe(NO_STATS_SESSION)
  expect(NO_STATS_SESSION).toContain('/efficient-model-orchestrator-stats all')
})
test('formatTokens: plain below a thousand, then K, then M with one decimal', async () => {
  expect([0, 999, 1000, 41_300, 999_499, 999_500, 1_240_000, 12_000_000].map(formatTokens)).toEqual(['0', '999', '1K', '41K', '999K', '1.0M', '1.2M', '12.0M'])
})

// --- The command ---

const STATS = { command: 'efficient-model-orchestrator-stats' }
const ALL = { args: 'all' }
const THIS = { args: '' }
const DIR = '/Users/a/.claude/efficient-model-orchestrator/logs'
const file = (name: string, mtimeMs: number) => ({ name, kind: 'file', size: 1, mtimeMs, isLink: false })

function statsApi(entries: unknown[], contents: Record<string, string>) {
  const $: any = fakeApi()
  const read: string[] = []
  $.env.get = async (name: string) => (name === 'HOME' ? '/Users/a' : undefined)
  $.session.id = async () => 's1'
  $.fs = {
    list: async (path: string) => { if (path !== DIR) throw new Error('no such folder'); return entries },
    read: async (path: string) => {
      read.push(path)
      const text = contents[path.slice(DIR.length + 1)]
      if (text === undefined) throw new Error('cannot read')
      return text
    },
  }
  return { $, read }
}

test('the stats command reports from every session log and ignores other entries', async () => {
  const a = entry({ inputTokens: M }); const b = entry({ sessionId: 's2', approved: SONNET, edited: true }); const c = entry({ sessionId: 's2', outcome: 'error' })
  const { $, read } = statsApi(
    [file('s1.jsonl', 1), file('s2.jsonl', 2), file('notes.txt', 3), { name: 'old.jsonl', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }],
    { 's1.jsonl': a + '\n', 's2.jsonl': b + '\n' + c + '\n', 'notes.txt': 'x' })
  const result = await hooksWith(register, {})('command.run', STATS)($, ALL)
  expect(result.text).toBe(renderStats(summarize([a, b, c])))
  expect(read.sort()).toEqual([`${DIR}/s1.jsonl`, `${DIR}/s2.jsonl`])
})
test('the stats command works with the orchestrator off and skips a log it cannot read', async () => {
  const a = entry({ inputTokens: M })
  const { $ } = statsApi([file('s1.jsonl', 1), file('broken.jsonl', 2)], { 's1.jsonl': a })
  expect((await hooksWith(register, {})('command.run', STATS)($, ALL)).text).toBe(renderStats(summarize([a])))
})
test('with no log folder, or no home folder, the stats command says nothing is logged', async () => {
  const { $ } = statsApi([], {})
  $.fs.list = async () => { throw new Error('no such folder') }
  expect((await hooksWith(register, {})('command.run', STATS)($, ALL)).text).toBe(NO_STATS)
  expect((await hooksWith(register, {})('command.run', STATS)(fakeApi(), ALL)).text).toBe(NO_STATS)
})
test('the stats command reads the 200 newest logs at most', async () => {
  const entries = Array.from({ length: 205 }, (_, i) => file(`s${i}.jsonl`, i + 1))
  const contents = Object.fromEntries(entries.map(e => [e.name, entry({ sessionId: e.name })]))
  const { $, read } = statsApi(entries, contents)
  const result = await hooksWith(register, {})('command.run', STATS)($, ALL)
  expect(read.length).toBe(200)
  expect(read).not.toContain(`${DIR}/s4.jsonl`)
  expect(read).toContain(`${DIR}/s5.jsonl`)
  expect(result.text).toContain('200 worker runs in 200 sessions')
})

// --- This session only, by default ---

test('the stats command reports this session alone, reading only its log', async () => {
  const mine = entry({ sessionId: 's1', inputTokens: M }); const other = entry({ sessionId: 's2', approved: SONNET })
  const { $, read } = statsApi([file('s1.jsonl', 1), file('s2.jsonl', 2)], { 's1.jsonl': mine + '\n', 's2.jsonl': other + '\n' })
  const result = await hooksWith(register, {})('command.run', STATS)($, THIS)
  expect(result.text).toBe(renderStats(summarize([mine]), 'session'))
  expect(read).toEqual([`${DIR}/s1.jsonl`])
})
test('with no workers logged in this session, the stats command says so', async () => {
  const { $ } = statsApi([file('s2.jsonl', 2)], { 's2.jsonl': entry({ sessionId: 's2' }) })
  expect((await hooksWith(register, {})('command.run', STATS)($, THIS)).text).toBe(NO_STATS_SESSION)
  expect((await hooksWith(register, {})('command.run', STATS)(fakeApi(), THIS)).text).toBe(NO_STATS_SESSION)
})
test('"all" asks for every session, in any case and spacing', async () => {
  const mine = entry({ sessionId: 's1' }); const other = entry({ sessionId: 's2' })
  const { $ } = statsApi([file('s1.jsonl', 1), file('s2.jsonl', 2)], { 's1.jsonl': mine, 's2.jsonl': other })
  expect((await hooksWith(register, {})('command.run', STATS)($, { args: ' All ' })).text).toBe(renderStats(summarize([mine, other])))
})
