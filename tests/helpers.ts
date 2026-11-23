// Shared setup for the kit tests of hooks/register.ts.

export const PLAN_TOOL = 'mcp__efficient-model-orchestrator__plan'

// An event input holding only the fields a test cares about: the test kit fills in the rest.
export const partial = (input: object): any => input

export const W1 = { id: 1, title: 'Find callers', route: 'worker', model: 'haiku', effort: 'medium', reason: 'read-only search' }
export const W2 = { id: 2, title: 'Fix refresh bug', route: 'worker', model: 'opus', effort: 'high', reason: 'subtle, no tests' }
export const M_HIGH = { id: 1, title: 'Explain CI', route: 'main', effort: 'high', reason: 'needs this chat' }
export const M_LOW = { id: 2, title: 'Tidy notes', route: 'main', effort: 'low', reason: 'tiny' }
export const FABLE = { id: 1, title: 'Solve the novel bug', route: 'worker', model: 'fable', effort: 'high', reason: 'hardest problem' }

// Registers the stubs every kit test needs (plus any `extra` ones), then fires session.start.
// Stubs must all be registered before the first call on $, so extra stubs go through `extra`.
export async function setup($: any, on: any, extra?: (on: any) => void) {
  const commands: string[] = []
  const tools: string[] = []
  const statuses: (string | undefined)[] = []
  const logs: string[] = []
  const store = new Map<string, unknown>()
  on('store.get', ($: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', ($: any, e: any) => { store.set(e.key, e.value); return { value: undefined } })
  on('store.delete', ($: any, e: any) => { store.delete(e.key); return { value: undefined } })
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', ($: any, e: any) => { commands.push(e.name); return { value: undefined } })
  on('tool.register', ($: any, e: any) => { tools.push(e.name); return { value: undefined } })
  on('ui.status', ($: any, e: any) => { statuses.push(e.text); return { value: undefined } })
  on('ui.log', ($: any, e: any) => { logs.push(e.text); return { value: undefined } })
  on('session.model', () => ({ value: 'claude-sonnet-5-5' }))
  on('prompt.submit', ($: any, e: any) => ({ text: e.text, context: e.context }))
  extra?.(on)
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  return { commands, tools, statuses, logs, store }
}

export const turnOn = ($: any) => $.command.run({ command: 'efficient-model-orchestrator-on', args: '' })
export const propose = ($: any, tasks: unknown[]) => $.tool.call({ tool: PLAN_TOOL, tasks })

// register() with chosen plugin options, for settings the test kit can't set. Each call builds a fresh
// session. hook(event, matcher) returns the handler registered for that event and matcher, and
// hook.catcher(event, matcher) the handler of its .catch.
export function hooksWith(register: any, options: unknown) {
  const handlers = new Map<string, any>()
  const catchers = new Map<string, any>()
  const on = (event: string, a: any, b?: any) => {
    const [matcher, fn] = b ? [a, b] : [undefined, a]
    const key = event + JSON.stringify(matcher ?? {})
    handlers.set(key, fn)
    return { catch(handler: any) { catchers.set(key, handler) } }
  }
  register(on, options)
  const hook = (event: string, matcher?: object) => handlers.get(event + JSON.stringify(matcher ?? {}))
  return Object.assign(hook, { catcher: (event: string, matcher?: object) => catchers.get(event + JSON.stringify(matcher ?? {})) })
}

// A hand-rolled mods API for hooksWith: recorders for what the mod shows and registers, and a store backed
// by `saved`.
export function fakeApi() {
  const logs: string[] = []
  const statuses: (string | undefined)[] = []
  const drawn: string[] = []
  const registered: { name: string; inputSchema: any }[] = []
  const saved = new Map<string, unknown>()
  const element = (props: any) => { if (typeof props.children === 'string') drawn.push(props.children); return props }
  return {
    logs, statuses, drawn, saved, registered,
    tool: { register: async (spec: any) => { registered.push(spec) } },
    command: { register: async () => {} },
    session: { model: async () => 'claude-opus-5-5', id: async () => 'sess' },
    ui: { status: async (text: string | undefined) => { statuses.push(text) }, log: async (text: string) => { logs.push(text) }, resolve: () => ({ Box: element, Text: element }) },
    store: {
      get: async (key: string) => saved.get(key),
      set: async (key: string, value: unknown) => { saved.set(key, value) },
      delete: async (key: string) => { saved.delete(key) },
    },
    env: { get: async () => undefined },
  }
}
