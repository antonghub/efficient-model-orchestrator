import { expect, test } from 'claude-code/testing'
import { validatePlan, renderPlan, modelLabel, routeLabel } from '../lib/plan.js'

const t = (o: object) => ({ id: 1, title: 'Find callers', route: 'worker', model: 'haiku', effort: 'medium', reason: 'read-only search', ...o })

test('accepts a worker and a main task', async () => {
  const r = validatePlan({ tasks: [t({}), t({ id: 2, route: 'main', model: undefined, effort: 'high' })] })
  expect(r.ok).toBe(true)
})
test('rejects an empty plan', async () => { expect(validatePlan({ tasks: [] })).toEqual({ ok: false, error: 'the plan has no tasks' }) })
test('rejects a worker without a model', async () => {
  expect(validatePlan({ tasks: [t({ model: undefined })] })).toEqual({ ok: false, error: 'task 1: a worker task needs a model' })
})
test('rejects a main task with a model', async () => {
  expect(validatePlan({ tasks: [t({ route: 'main' })] })).toEqual({ ok: false, error: 'task 1: a main-chat task takes no model' })
})
test('rejects duplicate ids, bad effort, unknown model, and after pointing nowhere', async () => {
  expect(validatePlan({ tasks: [t({}), t({})] })).toEqual({ ok: false, error: 'task 1: id is used twice' })
  expect(validatePlan({ tasks: [t({ effort: 'med' })] })).toEqual({ ok: false, error: 'task 1: effort must be one of low, medium, high, xhigh, max' })
  expect(validatePlan({ tasks: [t({ model: 'gpt' })] })).toEqual({ ok: false, error: 'task 1: model must be one of haiku, sonnet, opus, fable' })
  expect(validatePlan({ tasks: [t({ after: [9] })] })).toEqual({ ok: false, error: 'task 1: after names task 9, which is not in the plan' })
})
test('rejects after lists that form a loop', async () => {
  expect(validatePlan({ tasks: [t({ after: [2] }), t({ id: 2, after: [1] })] })).toEqual({ ok: false, error: 'the after lists form a loop: 1 → 2 → 1' })
  const long = [t({}), t({ id: 2, after: [1, 3] }), t({ id: 3, after: [4] }), t({ id: 4, route: 'main', model: undefined, after: [2] })]
  expect(validatePlan({ tasks: long })).toEqual({ ok: false, error: 'the after lists form a loop: 2 → 3 → 4 → 2' })
})
test('accepts after lists that share a task without looping', async () => {
  expect(validatePlan({ tasks: [t({}), t({ id: 2, after: [1] }), t({ id: 3, after: [1, 2] }), t({ id: 4, after: [2, 3] })] }).ok).toBe(true)
})
test('labels', async () => {
  expect(modelLabel('claude-opus-5-5')).toBe('Opus')
  expect(modelLabel('sonnet')).toBe('Sonnet')
  expect(modelLabel('mystery-1')).toBe('mystery-1')
  expect(routeLabel(t({}) as any, 'Opus')).toBe('Haiku · medium')
  expect(routeLabel(t({ route: 'main', model: undefined }) as any, 'Opus')).toBe('Main chat (Opus · medium)')
})
test('renders the agreed format', async () => {
  const plan = { tasks: [
    t({}) as any,
    t({ id: 2, title: 'Update the README', model: 'sonnet', effort: 'high', reason: 'clear spec, plain prose', after: [1] }) as any,
  ] }
  expect(renderPlan(plan, 'Opus')).toBe(
    'Plan: 2 tasks\n\n' +
    '1. Find callers\n   Haiku · medium: read-only search.\n\n' +
    '2. Update the README (after 1)\n   Sonnet · high: clear spec, plain prose.\n\n' +
    'Reply "OK", or change a route: "1. sonnet high"')
  expect(renderPlan({ tasks: [t({}) as any] }, 'Opus').startsWith('Plan: 1 task\n')).toBe(true)
})
test('after ranges', async () => {
  const p = (after: number[]) => renderPlan({ tasks: [1, 2, 3, 4].map(id => t({ id })).concat([t({ id: 5, after })]) as any }, 'Opus')
  expect(p([1, 2, 3])).toContain('5. Find callers (after 1–3)')
  expect(p([1, 3])).toContain('5. Find callers (after 1, 3)')
  expect(p([1, 2])).toContain('5. Find callers (after 1–2)')
})
