import { expect, test } from 'claude-code/testing'
import { isDecline, isResume, parseReply, startingLine } from '../lib/reply.js'

const plan = { tasks: [
  { id: 1, title: 'a', route: 'worker', model: 'haiku', effort: 'medium', reason: 'r' },
  { id: 2, title: 'b', route: 'worker', model: 'opus', effort: 'high', reason: 'r' },
  { id: 4, title: 'd', route: 'main', effort: 'medium', reason: 'r' },
] } as any
const task = (r: any, id: number) => r.plan.tasks.find((x: any) => x.id === id)

test('OK approves unchanged, any case, okay too', async () => {
  for (const s of ['OK', 'ok', ' Okay ', 'ok.']) {
    const r = parseReply(s, plan)
    expect(r.kind).toBe('approve')
    expect((r as any).plan).toEqual(plan)
    expect((r as any).edits).toEqual([])
  }
})
test('model and effort edit', async () => {
  const r: any = parseReply('1. sonnet high', plan)
  expect(task(r, 1)).toMatchObject({ route: 'worker', model: 'sonnet', effort: 'high' })
  expect(r.edits).toEqual([{ id: 1, model: 'sonnet', effort: 'high' }])
})
test('model only keeps effort; effort only keeps model', async () => {
  expect(task(parseReply('2. sonnet', plan), 2)).toMatchObject({ model: 'sonnet', effort: 'high' })
  expect(task(parseReply('2. med', plan), 2)).toMatchObject({ model: 'opus', effort: 'medium' })
})
test('main and back', async () => {
  expect(task(parseReply('2. main', plan), 2)).toEqual({ id: 2, title: 'b', route: 'main', effort: 'high', reason: 'r' })
  expect(task(parseReply('2. main xhigh', plan), 2)).toMatchObject({ route: 'main', effort: 'xhigh' })
  expect(task(parseReply('4. haiku', plan), 4)).toMatchObject({ route: 'worker', model: 'haiku', effort: 'medium' })
  expect(task(parseReply('4. sonnet', plan), 4)).toMatchObject({ route: 'worker', model: 'sonnet', effort: 'high' })
  expect(task(parseReply('4. fable low', plan), 4)).toMatchObject({ route: 'worker', model: 'fable', effort: 'low' })
})
test('several edits, separators, number styles, either word order', async () => {
  const r: any = parseReply('1. sonnet high, 2) haiku; 4: high opus\n', plan)
  expect(r.kind).toBe('approve')
  expect(task(r, 1)).toMatchObject({ model: 'sonnet', effort: 'high' })
  expect(task(r, 2)).toMatchObject({ model: 'haiku', effort: 'high' })
  expect(task(r, 4)).toMatchObject({ route: 'worker', model: 'opus', effort: 'high' })
})
test('anything not fully parsable is other', async () => {
  for (const s of ['7. haiku', '1. sonnet high, skip 3', 'skip 2', '1. sonnet opus', '1. high low',
                   '1.', '1. sonnet, 1. haiku', '']) {
    expect(parseReply(s, plan)).toEqual({ kind: 'other' })
  }
})
test('the input plan is never changed', async () => {
  const before = JSON.stringify(plan)
  parseReply('1. sonnet high, 2. main, 4. haiku', plan)
  expect(JSON.stringify(plan)).toBe(before)
})
test('starting line', async () => {
  expect(startingLine(plan, [], 'Opus')).toBe('Starting: plan as shown (3 tasks)')
  const r: any = parseReply('1. sonnet high, 2. main', plan)
  expect(startingLine(r.plan, r.edits, 'Opus')).toBe('Starting: 1 → Sonnet · high; 2 → Main chat (Opus · high)')
})

// --- Wider approvals ---

test('approval words approve, alone or together, with any case and end punctuation', async () => {
  for (const s of ['yes', 'Y', 'k', 'yep', 'yeah', 'sure', 'go', 'Go ahead!', 'do it', 'LGTM', 'approve', 'approved', 'proceed',
                   'looks good', 'sounds good.', 'all good', 'ok go ahead', 'ok do it', 'yes, go', 'ok. go ahead']) {
    const r: any = parseReply(s, plan)
    expect(r.kind).toBe('approve')
    expect(r.plan).toEqual(plan)
    expect(r.edits).toEqual([])
  }
})
test('an approval word next to edits approves with the edits', async () => {
  for (const s of ['ok, 1. sonnet high', '1. sonnet high, go ahead']) {
    const r: any = parseReply(s, plan)
    expect(task(r, 1)).toMatchObject({ model: 'sonnet', effort: 'high' })
    expect(r.edits).toEqual([{ id: 1, model: 'sonnet', effort: 'high' }])
  }
})
test('an approval word followed by anything else is other', async () => {
  for (const s of ['ok but skip 2', 'yes please explain', 'go away', 'okay?', 'okok', 'ok 1. sonnet'])
    expect(parseReply(s, plan)).toEqual({ kind: 'other' })
})

// --- Number styles ---

test('task numbers: no space after the dot, t, # and task prefixes, a closing period', async () => {
  for (const s of ['1.sonnet high', '1:sonnet high', 't1 sonnet high', 'T1. sonnet high', '#1 sonnet high', 'task 1: sonnet high', '1. sonnet high.'])
    expect(task(parseReply(s, plan), 1)).toMatchObject({ model: 'sonnet', effort: 'high' })
  for (const s of ['1sonnet', '1.5 sonnet', 'x1 sonnet']) expect(parseReply(s, plan)).toEqual({ kind: 'other' })
})

// --- Bulk edits ---

test('all changes every task', async () => {
  const r: any = parseReply('all sonnet', plan)
  expect(task(r, 1)).toMatchObject({ model: 'sonnet', effort: 'medium' })
  expect(task(r, 2)).toMatchObject({ model: 'sonnet', effort: 'high' })
  expect(task(r, 4)).toMatchObject({ route: 'worker', model: 'sonnet', effort: 'high' })
  expect(task(parseReply('every high', plan), 1)).toMatchObject({ model: 'haiku', effort: 'high' })
  expect(task(parseReply('everything main', plan), 2)).toMatchObject({ route: 'main', effort: 'high' })
})
test('a range changes the tasks whose numbers fall in it', async () => {
  const r: any = parseReply('1-2 sonnet', plan)
  expect(task(r, 1)).toMatchObject({ model: 'sonnet', effort: 'medium' })
  expect(task(r, 2)).toMatchObject({ model: 'sonnet', effort: 'high' })
  expect(task(r, 4)).toEqual(plan.tasks[2])
  expect(task(parseReply('2–4 low', plan), 4)).toMatchObject({ route: 'main', effort: 'low' })
  expect(task(parseReply('tasks 2 - 9: haiku', plan), 4)).toMatchObject({ route: 'worker', model: 'haiku' })
})
test('a range that is backwards or holds no task is other', async () => {
  for (const s of ['4-2 haiku', '5-9 haiku', '3-3 haiku', '1-2', 'all', 'all of them haiku'])
    expect(parseReply(s, plan)).toEqual({ kind: 'other' })
})
test("a task's own edit wins over a bulk edit; bulk edits apply in the order written", async () => {
  const a: any = parseReply('2. xhigh, all sonnet', plan)
  expect(task(a, 1)).toMatchObject({ model: 'sonnet', effort: 'medium' })
  expect(task(a, 2)).toMatchObject({ model: 'opus', effort: 'xhigh' })
  const b: any = parseReply('all sonnet, 1-2 haiku', plan)
  expect(task(b, 1)).toMatchObject({ model: 'haiku' })
  expect(task(b, 2)).toMatchObject({ model: 'haiku' })
  expect(task(b, 4)).toMatchObject({ model: 'sonnet' })
})

// --- One step cheaper or stronger ---

const NO_FABLE = ['haiku', 'sonnet', 'opus'] as any
test('stronger and cheaper move one step along the routes', async () => {
  expect(task(parseReply('1 stronger', plan, NO_FABLE), 1)).toMatchObject({ model: 'haiku', effort: 'high' })
  expect(task(parseReply('2 stronger', plan, NO_FABLE), 2)).toMatchObject({ model: 'opus', effort: 'xhigh' })
  expect(task(parseReply('2. cheaper', plan, NO_FABLE), 2)).toMatchObject({ model: 'opus', effort: 'medium' })
  expect(task(parseReply('2 weaker', plan, NO_FABLE), 2)).toMatchObject({ model: 'opus', effort: 'medium' })
  expect(task(parseReply('4 stronger', plan, NO_FABLE), 4)).toMatchObject({ route: 'main', effort: 'high' })
})
test('all cheaper steps every task down; a task with its own edit is left to that edit', async () => {
  const r: any = parseReply('all cheaper, 2 stronger', plan, NO_FABLE)
  expect(task(r, 1)).toMatchObject({ model: 'haiku', effort: 'low' })
  expect(task(r, 2)).toMatchObject({ model: 'opus', effort: 'xhigh' })
  expect(task(r, 4)).toMatchObject({ route: 'main', effort: 'low' })
})
test('a step word takes no model or effort beside it', async () => {
  for (const s of ['2 stronger high', '2 cheaper sonnet', '2 stronger cheaper']) expect(parseReply(s, plan)).toEqual({ kind: 'other' })
})

// --- What the Starting line lists ---

test('edits list every task whose route changed, and only those', async () => {
  const r: any = parseReply('all sonnet', plan)
  expect(r.edits).toEqual([{ id: 1, model: 'sonnet', effort: 'medium' }, { id: 2, model: 'sonnet', effort: 'high' }, { id: 4, model: 'sonnet', effort: 'high' }])
  expect(startingLine(r.plan, r.edits, 'Opus')).toBe('Starting: 1 → Sonnet · medium; 2 → Sonnet · high; 4 → Sonnet · high')
  const same: any = parseReply('1. haiku medium, 2-4 high', plan)
  expect(same.edits).toEqual([{ id: 4, model: 'main', effort: 'high' }])
  const none: any = parseReply('1. haiku medium', plan)
  expect(startingLine(none.plan, none.edits, 'Opus')).toBe('Starting: plan as shown (3 tasks)')
})

// --- Resume and decline words, polite filler ---

test('a resume word resumes, alone or beside an approval word; an approval word alone does not', async () => {
  for (const s of ['continue', 'Continue.', 'resume', 'keep going', 'carry on', 'go on', 'ok continue', 'yes, keep going!', 'continue please'])
    expect(isResume(s)).toBe(true)
  for (const s of ['ok', 'yes', 'go', 'continue with the docs', 'please', '', 'no']) expect(isResume(s)).toBe(false)
})
test('decline words decline', async () => {
  for (const s of ['no', 'No.', 'n', 'nope', 'nah', 'cancel', 'skip', 'stop', 'keep it', 'never mind', 'nevermind', 'no thanks', 'no, keep it'])
    expect(isDecline(s)).toBe(true)
  for (const s of ['no idea', 'not now', 'thanks', '', 'ok']) expect(isDecline(s)).toBe(false)
})
test('polite filler beside an approval still approves; filler alone does not', async () => {
  for (const s of ['yes please', 'ok thanks', 'Go ahead, thank you!', 'please, 1. sonnet high']) expect(parseReply(s, plan).kind).toBe('approve')
  for (const s of ['please', 'thanks', 'thank you, please']) expect(parseReply(s, plan)).toEqual({ kind: 'other' })
})
