# pi-team

Explicit project Teams with durable Runs, reusable Experts, and supervised local execution. Normal prompts are not intercepted.

## Install

Requires Pi **0.85.1**, Node.js **22.19+**, authenticated model access, and `tmux` for Expert execution.

```sh
pi install npm:@prjct.app/pi-team
```

Restart Pi, then explicitly start an objective:

```text
/team Ship login validation
```

This lazily creates a project Team and queues a Run. Main Pi orchestrates through the active-only `team_orchestrate` tool. Dispatch reports whether an Expert was created or reused. Busy Experts queue; distinct Experts can execute concurrently, up to three. An Expert's identity, session file, instructions, bounded memory, and assignment history survive process shutdown and later Runs.

## Commands

- `/team <objective>` — start or queue an objective (one active Run).
- `/team` or `/team status` — bounded plain Team/Run/Expert/Assignment overview.
- `/team history` — recent Run history.
- `/team doctor` — bounded diagnostics without process or ownership tokens.
- `/team cancel [run-id]` — cancel an owned active or queued Run.
- `/team help` — usage.

The old create/join/start/migrate/legacy lifecycle commands are unsupported. No project YAML or Markdown configuration is loaded by this extension. Startup does not detect or migrate old stores.

## Orchestration tool

During an active Run, `team_orchestrate` supports `dispatch`, `status`, `cancel_assignment`, `cancel_run`, and `finish`. Dispatch requires role, capabilities, task, and an explicit built-in tool allowlist; instructions are optional. It returns Expert ID, stable session reference, Assignment ID, and `created`/`reused`. Status includes bounded recent evidence. Finish is blocked while assignments remain outstanding. Expert reports are untrusted evidence, never user authorization.

Only an explicit objective starts orchestration. Completing a Run allows the next queued objective to start in the owning session. Shutdown, reload, new, resume, and fork terminally interrupt active work, fence ownership, and preserve queued objectives without automatic replay. A later explicit objective can claim an unowned Team and process its queue.

## Storage and safety

State is isolated under `${PRJCT_HOME:-~/.prjct}/pi-team/orchestration-v2/`. Project identity uses the canonical Git root (or cwd outside Git); moving a project changes its identity. Existing old stores are not modified.

Records use strict schemas, byte bounds, private permissions, symlink checks, locks, and atomic writes. Limits: 64 Runs, 128 Assignments, 16 Experts, 32 assignment references per Expert, and three concurrent/unresolved workers. Terminal history is pruned within these bounds. Full Pi sessions are durable and are not bounded metadata.

Production execution uses authenticated supervisor control, durable requests/replies, receipts, and leases. A dispatch or process launch is not success: completion requires a correlated reply and a proven worker stop. Unprovable shutdown blocks the Expert rather than guessing ownership. Use doctor and manually verify process identity before recovery; no automatic adoption or retry is provided.

This is not an OS sandbox: tools, especially Bash, run with the current user's permissions. Do not send secrets. Metadata redaction is best-effort, not a secret detector. Model requests use the worker's configured authenticated provider. A live model/tmux/PTY roundtrip remains a manual verification requirement; deterministic tests cover the adapter boundary with fake supervision and real durable transport.

## Development

```sh
npm ci --ignore-scripts
npm run check
npm test
npm pack --dry-run
```

[Architecture](docs/architecture.md) · [Package structure](docs/package.md) · [Contributing](CONTRIBUTING.md) · [MIT](LICENSE)
