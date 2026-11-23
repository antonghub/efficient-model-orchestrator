import { expect, test } from 'claude-code/testing'
import { logLine, logPath } from '../lib/log.js'

test('log line is one JSON object per line', async () => {
  const line = logLine({ ts: 1, sessionId: 's', agentId: 'a1', taskId: 1, title: 'a', recommended: { route: 'worker', model: 'haiku', effort: 'medium' }, approved: { route: 'worker', model: 'sonnet', effort: 'high' }, edited: true, inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 5, durationMs: 9, outcome: 'answer' })
  expect(line.endsWith('\n')).toBe(true)
  expect(line.trim().includes('\n')).toBe(false)
  expect(JSON.parse(line).approved).toEqual({ route: 'worker', model: 'sonnet', effort: 'high' })
})
test('log path', async () => {
  expect(logPath('/Users/a', 'abc')).toBe('/Users/a/.claude/efficient-model-orchestrator/logs/abc.jsonl')
})
