# Architecture

This document describes the active Team v2 extension. For commands and usage, see the [README](../README.md).

## Controller and session boundaries

`src/index.ts` composes the domain, storage, runtime, supervisor, command, migration, and UI layers. Loading the extension registers handlers but starts no background work. Membership activates the compact model tool, presence heartbeat, and delivery polling; leaving or shutdown removes them.

Normal prompts are not intercepted. A system-prompt suffix is added only while membership is active. Model actions remain non-destructive; lifecycle, process control, migration, and purge remain slash commands with interactive confirmation where destructive.

Membership restoration is session-specific:

- Reload can retain the exact membership. A supervised owner handoff additionally requires the same process nonce, same session, a new instance ID, and a higher owner epoch.
- A failed reload expires into membership cleanup and supervised-runtime shutdown or worker self-shutdown.
- `/new` and `/fork` do not inherit membership or workers.
- A resumed historical session can restore its own membership but cannot adopt the outgoing session's worker ownership.
- Normal shutdown closes this owner's supervisor and leaves membership. External peer processes are never terminated.

## Domain and storage

State lives under `${PRJCT_HOME:-~/.prjct}/pi-team/`:

```text
teams/<team>/
  team.json
  members/<member>.json
  runtimes/<runtime>.json
  inbox/<recipient>/{pending,claimed}/<message>.json
  receipts/<recipient>/<message>.json
  leases/<lease>.json
control/
```

Records have strict schema versions and semantic validation. Dynamic path segments are validated IDs. Directories and files use private permissions; symlinked components, unsafe ownership, malformed data, and future schemas fail closed. Corrupt records remain in place.

Publication uses private same-directory temporary files, file `fsync`, atomic linking or rename, and directory `fsync`. Mutable team/member metadata keeps one previous copy. Immutable spool records do not create journals or snapshots. Durable locks contain an owner PID and process-start identity; stale reclamation revalidates identity and remains mutually exclusive.

Quotas and byte limits bound all collections and records. Inbox reads, receipts, peer pages, the dashboard, and control frames are explicitly bounded.

## Membership and presence

A membership binds team ID, member ID, alias, session ID, cwd, kind, member generation, and a presence lease token/generation. Rejoining an offline alias advances generation and fences its previous owner. A live alias cannot be taken.

Presence is a renewable token-fenced lease. UI status derives from live presence rather than a stale membership flag. Leaving cancels outgoing requests, releases presence, marks the member left, and prevents the former credentials from publishing further work.

Members are either:

- `external`: a Pi session opened and controlled outside pi-team; durable messaging only, never automatic wake or process termination.
- `supervised`: created by the explicit human `/team start` command and eligible for automatic request delivery through its owner-controlled runtime.

## Messaging and requests

Each recipient has independent pending and claimed message records. Messages carry bounded UTF-8 bodies, TTL, recipient generation, and explicit request/thread correlation. Offline durable addresses can accumulate work for their next valid owner; messages to a replaced live generation are rejected.

Request delivery proceeds as follows:

1. The supervised recipient must be idle and explicitly marked for automatic requests.
2. Storage moves the envelope from pending to claimed under the inbox lock.
3. A receipt and delivery marker are durable before the body reaches the model.
4. The controller injects one untrusted-data message and starts the turn.
5. The active token/generation-fenced claim is renewed during a long turn.
6. The peer publishes an explicit correlated reply, or cancellation/failure reaches a terminal receipt.

A delivered request is never automatically replayed after model exposure. This favors prevention of duplicate filesystem or external side effects over guaranteed execution. Sender cancellation is durable and wins over a late reply. Reconciliation repairs bounded crash windows from receipts and envelopes, expires stale records, and marks lost claims failed.

The `team` model tool exposes metadata/status, bounded inbox reads, send/reply, and advisory resource claim/release. It cannot perform lifecycle, migration, or process operations.

## Advisory resource claims

Resource claims are leases protected by acquisition token and generation. Claimed paths are normalized to absolute paths against the claimant's cwd before storage, so peers with different working directories compare the same filesystem target. Another member's active overlapping claim blocks Pi's structured `edit` and `write` tools. Bash is intentionally not parsed as a shell language; when a command visibly names a claimed resource, the controller warns but cannot reliably block every possible mutation. Claims coordinate cooperative agents and do not change OS permissions.

## Supervised control plane

Every supervised peer has a durable runtime record fenced by team, runtime/member identity, owner session, process nonce, owner instance, and owner epoch. The tmux adapter creates a new session with random ownership metadata and records PID, process start token, process group, cwd, runtime identity, and hashes of ownership tokens.

Workers authenticate over a private `0600` Unix socket using bounded, versioned NDJSON. The server tracks all accepted sockets, including unauthenticated ones, so shutdown cannot be held open. Monotonic frame sequences reject replay while allowing a newly loaded worker extension to authenticate with a fresh sequence. Heartbeats and reconnect contact count only after authentication.

The worker watchdog aborts its correlated active request and calls Pi's documented `ctx.shutdown()` when owner contact is lost. Closing the owning session shuts down all owned runtimes in parallel. Reload handoff transfers only same-process, same-session ownership and excludes terminated runtimes.

## Bounded shutdown

Shutdown is idempotent and follows:

1. Send authenticated `prepare_shutdown`; the worker aborts only its correlated request and requests graceful Pi shutdown.
2. Wait a bounded grace period.
3. Revalidate PID, start token, process group, runtime owner, and token-marked tmux metadata before `SIGTERM`.
4. Revalidate again before `SIGKILL`.
5. Remove only a tmux session whose ownership metadata still matches.

PID alone is never sufficient. Reuse, changed metadata, corruption, or missing evidence produces `blocked`/`lost` state and diagnostics rather than a speculative signal. `/team kill` uses this same path with stronger human confirmation; there is no unsafe expedited API.

## Dashboard

`src/ui/team-dashboard.ts` loads one bounded metadata-only snapshot on demand and renders through Pi 0.85.1's documented `ctx.ui.custom` API. It contains team/member status, inbox metadata, a whitelisted runtime projection, request receipts, leases, and shutdown/recovery warnings. Message bodies and process/ownership tokens are excluded.

Rendering sanitizes terminal controls, truncates by visible width, pairs status icons with text, and caps each section. Selection stores a stable row/member ID rather than a mutable array index. Escape closes only the view and explicitly does not claim to cancel operations. Non-TUI modes use the same plain formatter.

## Legacy preservation and migration

Startup calls `lstat` only to detect the legacy teams and managed-factory roots. It does not traverse them. Importing the legacy modules itself performs no I/O.

Explicit inspection is shallow and bounded by team, entry, file, per-file-byte, and total-byte budgets. It rejects symlinks and unsafe ownership/permissions, opens regular files with `O_NOFOLLOW`, verifies files and directories did not change, and reports metadata without exposing message bodies or tokens. Nested journals, snapshots, worktrees, and arbitrary directories are never traversed.

Explicit migration re-inspects the selected legacy mailbox and compares its hash before atomic publication. It rejects destination collisions and overlapping roots. The destination is a closed v2 team metadata archive. Members, messages, receipts, leases, presence, process ownership, journals, snapshots, worktrees, and managed plans are omitted with reasons. Legacy source bytes are never written, moved, or deleted. Legacy stop sends no process signals because old PID fields do not establish the complete v2 ownership proof. A separate human `/team purge` can remove only a closed v2 team after every member has left and every supervised runtime is terminated; it never touches legacy roots.

The inactive `src/mailbox.ts`, `src/store.ts`, and `src/schema.ts` modules remain only to validate legacy mailbox format during explicit inspection. They are not registered by the extension.

## Pi APIs

The active integration uses documented Pi 0.85.1 APIs: `registerCommand`, `registerTool`, `registerMessageRenderer`, `sendMessage`, `appendEntry`, `getActiveTools`, `setActiveTools`, `before_agent_start`, `tool_call`, `input`, `agent_settled`, session lifecycle events, `ctx.ui.custom`, notifications/confirmation, `ctx.abort()`, and `ctx.shutdown()`. It imports no host internals and patches no prototypes.

## Guarantees and non-goals

pi-team provides local durable coordination, bounded recovery, and conservative process ownership checks. It does not provide exactly-once side effects, a sandbox, an authorization boundary, Git integration, automatic planning, worktree allocation, publication, deployment, cross-machine transport, network-filesystem support, or native Windows support.
