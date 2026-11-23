# Changelog

## 0.1.0 (2026-11-23)

First public release.

- Plans every request as tasks, each routed to a worker (a subagent on a chosen model and effort) or to the main
  chat, and waits for your approval before anything runs.
- Reply `OK` to approve, or edit routes: `1. sonnet high`, `all sonnet`, `2-4 haiku`, `2 stronger`, `all cheaper`.
- Workers run only on approved routes; a task that waits for others starts once they have finished.
- A plan cut short (Esc, an error, a usage limit) is paused; `continue` resumes it without a new approval.
- A failed or weak worker task can be offered again one step stronger; you answer `OK`, a route, or `no`.
- The status line shows progress while a plan runs, such as `3/5 workers done · 41K tokens`.
- `/efficient-model-orchestrator-stats` reports what this session's workers used, with a normal cost (the main
  chat's model) against the efficient routed cost; `all` covers every session.
- A `fable` setting (off, included, credits) decides whether Fable is proposed; a credits failure blocks it for
  7 days.
