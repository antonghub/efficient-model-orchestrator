# efficient-model-orchestrator

A Claude Code mod that picks the right model and effort for each piece of work, so usage limits last longer
and you get the best output for the fewest tokens. While it's on, the main chat acts as a project manager: it
breaks each request into tasks and routes each one to a worker (a subagent on a chosen model and effort) or
keeps it in the main chat. Before anything runs, it always stops and shows the plan with a reason for each
route. Nothing runs until you approve it, and workers run only on the routes you approved.

## Install

In a terminal session of Claude Code:

```
/plugin install efficient-model-orchestrator --marketplace antonghub/efficient-model-orchestrator
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session). From a shell:

```bash
claude plugin install efficient-model-orchestrator --marketplace antonghub/efficient-model-orchestrator
```

In the Desktop app, where `/plugin` doesn't run: click **+** next to the prompt box, then **Plugins**, **Add
marketplace** with `antonghub/efficient-model-orchestrator`, then **Add plugin**. A plugin installed from a terminal at the user scope also
loads in the Desktop app's sessions.

Then, in any session, run `/efficient-model-orchestrator-on`.

## Commands

- `/efficient-model-orchestrator-on` turns it on for the current session.
- `/efficient-model-orchestrator-off` turns it off.
- `/efficient-model-orchestrator-stats` shows what this session's workers used and saved; add `all` for every session (see
  [Savings report](#savings-report)).
  It works whether the orchestrator is on or off.

It is off in every new session until you turn it on.

## What a plan looks like

```
Plan: 2 tasks

1. Find every caller of the auth middleware
   Haiku · medium: read-only search, no judgment needed.

2. Fix the token refresh race condition
   Opus · high: subtle concurrency bug, no tests, a wrong fix is costly.

Reply "OK", or change a route: "1. sonnet high"
```

## Replying to a plan

- `OK` approves the plan as shown. So do `okay`, `yes`, `y`, `k`, `yep`, `yeah`, `sure`, `go`, `go ahead`, `do it`,
  `proceed`, `approve`, `approved`, `lgtm`, `looks good`, `sounds good` and `all good`, in any case, alone or
  together (`ok go ahead`), with `please` or `thanks` beside them.
- Change a route by task number, then a model, an effort, or both: `1. sonnet high`, `2. sonnet` (keeps the
  effort), `2. high` (keeps the model). Several edits can go in one reply, separated by commas, semicolons or
  new lines, and an approval word may sit beside them (`ok, 1. sonnet high`). The number can be written `1.`, `1:`,
  `1)`, `1`, `t1`, `#1` or `task 1`.
- Change several tasks at once: `all sonnet`, `2-4 haiku`. A task's own edit wins over a range or `all`
  (`all sonnet, 2. opus high`).
- `stronger` and `cheaper` move a task one step along the recommended routes (Haiku medium, Haiku high, Sonnet high,
  Opus medium, Opus high, Opus xhigh, then Fable high where Fable is on offer): `2 stronger`, `all cheaper`. Past
  either end, and for a main-chat task, only the effort moves.
- `main` moves a task to the main chat (`2. main`, or `2. main high` to set its effort). A model name moves a
  main-chat task to a worker (`4. haiku medium`). When an edit gives a model but the task had no worker effort
  before, the effort defaults to Haiku medium, Sonnet high, Opus medium, Fable high.
- After edits it starts at once and logs one line, such as `Starting: 1 → Sonnet · high`.
- Names: models `haiku`, `sonnet`, `opus`, `fable`, `main`; efforts `low`, `medium` (`med`), `high`, `xhigh`, `max`.
- Anything else ("skip 2", "why Opus for 2?") goes to Claude as normal instructions: it answers, or proposes a
  revised plan, which pauses again.

Before planning, the main chat may make up to 3 read-only tool calls to scope the plan; bigger reading becomes a
task. Loading a tool or a skill, task lists and questions to you don't count as looks. The main chat's model is
never switched; for best plans run it on Opus · medium.

## While a plan runs

- **Order.** A task that waits for other tasks (`after 1–2`) can't be launched until the workers it waits for have
  finished. A plan whose tasks wait for each other in a circle is refused.
- **Progress.** The status line shows how far the plan is, such as `orchestrator on · 3/5 workers done · 41K tokens`.
  The tokens are what the plan's workers have used so far, cache reads left out.
- **A plan that is cut short is kept.** If the turn is interrupted (Esc), fails (a usage limit, an error), or ends
  while workers have not all answered, the plan is paused and a line says so. Reply `continue` (or `resume`,
  `keep going`, `carry on`, `go on`) and it picks up where it stopped, with no new approval: workers that answered
  are not run again, the rest may launch. Any other message drops the paused plan and is handled as a new request.
- **A worker that fails gets a retry offer.** When a worker fails, or Claude judges its result too weak to use,
  Claude can offer a retry one step stronger. Nothing is retried until you answer:

  ```
  Retry task 2: Fix the token refresh race condition
     Sonnet · high → Opus · medium: the worker stopped before finishing the fix.

  Reply "OK" to retry, "no" to keep the result, or pick a route: "2. opus high"
  ```

  `OK` retries on the offered route, a route (`2. opus high`, or just `opus high`) retries on that one, and `no`
  (`nope`, `skip`, `cancel`, `keep it`, `never mind`) keeps the result and carries on. The rest of the plan keeps
  its progress either way.

## Fable

A mod can't see your subscription plan or which models it includes, so a setting decides how Fable is treated. Set
**Fable access** in `/config`, then run `/reload-plugins`:

- `off` (default): Fable is never proposed, and editing a task to `fable` is refused with a reason.
- `included`: Fable is part of your plan and is proposed for the hardest work.
- `credits`: the same, but Fable spends paid usage credits, so plans label it `Fable · high (paid credits)`.

If a Fable worker fails because it needs usage credits, the orchestrator remembers that and stops proposing Fable for
7 days, across sessions. Changing the setting ends this early, and so does a Fable worker that answers. You can still
edit a task to `fable` yourself in the meantime.

## Savings report

`/efficient-model-orchestrator-stats` adds up the usage log of the current session.
`/efficient-model-orchestrator-stats all` adds up every session's (the 200 most recent):

```
42 worker runs in 7 sessions

- Haiku: 20 runs · 1.2M tokens in · 80K out · $0.16
- Sonnet: 12 runs · 600K tokens in · 90K out · $2.10
- Opus: 10 runs · 900K tokens in · 120K out · $6.00

- Normal cost: $16.60 (every worker on the main chat's model)
- Efficient cost: $8.26 (each worker on its approved route)
- Saved: $8.34 (50%)

Routes you changed: 6 of 42 (14%)
- Haiku · medium: 4 of 20, mostly to Sonnet · high
- Opus · high: 2 of 10, mostly to Opus · medium

Workers that did not answer: 3 of 42
```

**Normal cost** is what the same work would have cost without the orchestrator: the same tokens on the main chat's
model (logged with each worker; Opus for workers logged before that). **Efficient cost** is what the routed workers
cost. The costs are estimates at list prices per million tokens, as of November 2026 (Haiku $0.10 in / $0.50 out, Sonnet $2 / $10, Opus $4 / $20,
Fable $10 / $50), with cache reads at 10% of the input price and cache writes at 125%. A subscription's included usage
is not billed this way, so read the numbers as a comparison, not a bill. Only workers are counted: the main chat's
tokens are not logged. "Routes you changed" shows where the recommendations and your judgment differ.

## What it stores and runs on your machine

Mods run inside Claude Code with your permissions; they are not sandboxed. This one:

- Writes one JSON line per finished worker to `~/.claude/efficient-model-orchestrator/logs/<session-id>.jsonl`: the
  task title, the recommended and approved routes, whether you edited it, token counts, duration, outcome and the main
  chat's model. The savings report is built from these files.
- Appends those lines with `sh -c 'mkdir -p … && cat >> …'`; where `sh` isn't available it rewrites the file instead.
- Saves one value in Claude Code's plugin store: a learned "Fable needs credits" block and when it ends.
- Sends nothing anywhere. It reads no files of yours beyond its own logs.

While it's on, it denies the main chat's tools until a plan is approved (apart from 3 read-only looks), denies
subagent launches that aren't in the approved plan, and sets each worker's model and effort.

## Status

Tested with Claude Code 2.1.330 in the Desktop app: planning, the plan's display, approval with edits, workers on
their approved routes, and the savings report. Covered by the test suite but not yet tried in a live session: a
worker task waiting for another worker, pausing and resuming a plan after Esc or a usage limit, and retry offers.
Not yet tried in the terminal.

The routing rubric Claude is given comes from public benchmarks and list prices, not from measuring real work; the
usage log is there to tune it.

## Requirements

Claude Code 2.1.287 or later in the terminal, or 2.1.286 or later in the Desktop app (mods need these).

## Developing

Run it from a clone without installing:

```bash
claude --plugin-dir /path/to/efficient-model-orchestrator
```

For the Desktop app, add the clone's path to `CLAUDE_CODE_PLUGIN_DIRS` under `env` in `~/.claude/settings.json`,
then start a new session. Run `/reload-plugins` after a change.

The code: `hooks/register.ts` is the only file that talks to Claude Code; everything it decides lives in plain
modules under `lib/` (`session.ts` holds the state machine, `reply.ts` the reply parser, `stats.ts` the report).

## Tests

```bash
claude plugin test
claude plugin validate .
```

## License

MIT, see [LICENSE](LICENSE).
