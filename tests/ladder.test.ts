import { expect, test } from 'claude-code/testing'
import { stepRoute } from '../lib/ladder.js'

const NO_FABLE = ['haiku', 'sonnet', 'opus'] as any
const worker = (model: string, effort: string) => ({ id: 1, title: 'a', route: 'worker', model, effort, reason: 'r' }) as any
const main = (effort: string) => ({ id: 1, title: 'a', route: 'main', effort, reason: 'r' }) as any
const route = (t: any) => (t.route === 'main' ? `main ${t.effort}` : `${t.model} ${t.effort}`)

test('stronger climbs the recommended routes one at a time', async () => {
  const seen: string[] = []
  let t = worker('haiku', 'medium')
  for (let i = 0; i < 6; i++) { t = stepRoute(t, 'stronger'); seen.push(route(t)) }
  expect(seen).toEqual(['haiku high', 'sonnet high', 'opus medium', 'opus high', 'opus xhigh', 'fable high'])
})
test('cheaper walks the same routes back down', async () => {
  const seen: string[] = []
  let t = worker('fable', 'high')
  for (let i = 0; i < 6; i++) { t = stepRoute(t, 'cheaper'); seen.push(route(t)) }
  expect(seen).toEqual(['opus xhigh', 'opus high', 'opus medium', 'sonnet high', 'haiku high', 'haiku medium'])
})
test('a route off the ladder moves to the nearest rung in that direction', async () => {
  expect(route(stepRoute(worker('sonnet', 'medium'), 'stronger'))).toBe('sonnet high')
  expect(route(stepRoute(worker('opus', 'low'), 'cheaper'))).toBe('sonnet high')
  expect(route(stepRoute(worker('sonnet', 'max'), 'stronger'))).toBe('opus medium')
})
test('without Fable the top step is more effort, and then nothing', async () => {
  expect(route(stepRoute(worker('opus', 'xhigh'), 'stronger', NO_FABLE))).toBe('opus max')
  const top = worker('opus', 'max')
  expect(stepRoute(top, 'stronger', NO_FABLE)).toBe(top)
})
test('below the lowest rung only the effort is left to lower', async () => {
  expect(route(stepRoute(worker('haiku', 'medium'), 'cheaper'))).toBe('haiku low')
  const bottom = worker('haiku', 'low')
  expect(stepRoute(bottom, 'cheaper')).toBe(bottom)
})
test('a main-chat task moves its effort one step and stays in the main chat', async () => {
  expect(route(stepRoute(main('medium'), 'stronger'))).toBe('main high')
  expect(route(stepRoute(main('medium'), 'cheaper'))).toBe('main low')
  const top = main('max')
  expect(stepRoute(top, 'stronger')).toBe(top)
})
test('the task given is never changed', async () => {
  const t = worker('haiku', 'medium'); const before = JSON.stringify(t)
  stepRoute(t, 'stronger')
  expect(JSON.stringify(t)).toBe(before)
})
