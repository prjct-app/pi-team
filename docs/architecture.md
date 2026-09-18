# Architecture

## Active integration

`src/index.ts` registers only `/team`. Fresh session startup creates no records, timers, tool, or prompt changes. An explicit objective lazily binds the canonical project, persists a Run, claims a fenced owner, and calls `sendUserMessage` once when that Run becomes active. Normal input is not intercepted. `team_orchestrate` is lazily registered and active only during owned Runs; its prompt suffix is absent outside Runs. Deactivation removes only that tool, preserving unrelated active tools.

`src/dynamic/domain.ts`, `store.ts`, and `service.ts` define strict bounded Team, Run, Expert, and Assignment records. A locked atomic project record enforces one active Run, one active assignment per Expert, unique roles, and a maximum of three busy/blocked Experts. Suitable Experts are reused, busy Experts queue, and capability/tool-policy escalation is rejected. Generation plus owner epoch fences results. Terminal cancellation never becomes success after a late reply.

## Storage

The new namespace is `${PRJCT_HOME:-~/.prjct}/pi-team/orchestration-v2/`:

```text
projects/<project-id>/state.json
projects/<project-id>/sessions/<stable-session-ref>.jsonl
transport/teams/<project-id>/...
transport/control/...
```

Project IDs hash canonical Git root or cwd. A project move deliberately produces a different identity. Metadata bounds are 64 Runs, 128 Assignments, 16 Experts, and 32 assignment references per Expert; old terminal records may be pruned. Private directories, strict schemas, byte bounds, storage locks, and atomic publication reuse the existing storage primitives. Pi session files retain conversation history separately from bounded Expert memory.

## Production execution

`runner.ts` adapts the existing `TeamSupervisor`, `TeamRuntime`, membership leases, durable request/reply spool, and receipts. Transport records live in the isolated namespace; no old Team bytes are reused. The adapter creates a private stable Pi session header once and launches Pi with `--session` referencing the same file across assignments and Runs. It disables ambient extension/skill/template/context-file discovery and passes an explicit tool allowlist.

`worker.ts` is selected only for supervised worker environments. It authenticates using the existing private control socket bootstrap, validates durable Expert identity/session and active assignment generation/owner epoch, loads role instructions and bounded memory, and enforces the allowlist at `tool_call`. Its only extension tool is `team_reply`. Requests are durably claimed/read before `sendUserMessage`; replies are explicitly correlated. Membership and delivery leases renew during work. Neither launch nor a model turn is treated as successful execution. The adapter requires a valid reply receipt and a proven stop before reporting completion.

The existing supervisor revalidates owner identity, PID start identity, process group, and marked tmux metadata before bounded graceful/TERM/KILL escalation. Tokens are never projected into Team UI/history. Unproven stops block capacity and require manual investigation. Worker startup failures and deadlines produce failure, not fabricated results.

## Interruption

Reload, new, resume, fork, and shutdown cancel active assignments and terminally cancel the active Run with an interruption reason. They stop only owned workers, release/fence the owner, retain Team/Experts/sessions/history/queued Runs, and never automatically restore execution. A new explicit objective may claim an unowned/dead-owned Team. Dead-owner recovery interrupts abandoned active work and blocks unresolved Experts rather than adopting or replaying them.

## Views and compatibility

`view.ts` projects bounded plain status/history/doctor summaries without owner/process/control/lease tokens. Free text is control-sanitized and best-effort secret-redacted. No color is required. The previous interactive dashboard remains inactive library code. Legacy inspection/migration and v1 mailbox sources are removed; old command forms are rejected and old stores are untouched.

Only documented Pi 0.85.1 extension APIs and CLI flags are used. Deterministic tests cover scheduling, storage, lifecycle, supervisor safety, and the production adapter with fake supervision plus real durable transport. Live authenticated model/tmux/PTY behavior remains manually unchecked. There is no OS sandbox, exactly-once side-effect guarantee, automatic recovery/adoption, Git/worktree automation, deployment, cross-machine transport, or network-filesystem support.
