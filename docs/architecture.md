# Architecture

How pi-team stores state, coordinates concurrent sessions, and recovers from
failure. For everyday use see the [README](../README.md).

## Storage model

Each team is one JSON record at `~/.pi/agent/teams/<team>/state.json`, honouring
`PI_CODING_AGENT_DIR`. The record holds the member roster and the full message
history. Team folders are `0700` and files `0600`; an unsafe, symlinked, or
foreign-owned directory or record fails closed rather than being repaired.

Records are wrapped in an envelope carrying a schema marker, a monotonically
increasing revision, and a SHA-256 of the payload. A corrupt record is preserved
for manual recovery, never erased. Mailboxes written before envelopes existed
are read as revision 0 and rewritten as envelope records on their first write.

## Concurrency

Readers never take a lock. Every publication writes a private temporary file,
hard-links it into a bounded `revisions/` history, and atomically renames it into
place, so a concurrent read sees either the whole previous record or the whole
next one. The history doubles as recovery evidence for an interrupted write.

Writers compare-and-swap on the revision under a short-lived sibling lock.
A conflict fails fast and the caller retries against a fresh read, so many agents
write concurrently instead of queueing behind a team-wide lock. A lock abandoned
by a crashed writer is reclaimed after ten seconds.

Because every publication renames a **new inode** into place, readers can safely
cache a parsed record keyed on `(inode, size, mtime)`: a write by any process
changes the inode. Cached reads serve the polling loop; mutations always read
uncached, so they never operate on the shared cached object.

## Presence

Presence lives outside the shared record. Each member rewrites only its own
`presence/<alias>.json` every two seconds, so heartbeats add no write contention
and never touch `state.json`.

These files are deliberately non-durable: the atomic rename is kept, both fsyncs
are not. Presence expires after 30 seconds and is rewritten every 2, so a write
lost to a crash only makes a member look offline sooner — never alive longer.
A member is also considered gone as soon as its recorded process has exited.

## Request lifecycle

A request is queued, claimed when the recipient is idle, worked on, and settled
with a result delivered back to the emitter. The recipient compacts before
accepting another team turn; the emitter verifies the result against its original
request and replies in-thread only if something is missing.

States are `pending`, `processing`, `completed`, `interrupted`, and `seen`
(notes already displayed).

## Sweeping orphaned claims

A session that dies holding a claim would otherwise leave its requester waiting
forever, so peers interrupt the claim on its behalf and the requester receives an
`interrupted` result.

Members are never removed from the record — leaving only marks them offline — so
"someone is offline" is permanently true once anyone has ever left and cannot be
used to decide when to sweep. A snapshot instead reports `sweepable`, true only
when a member the record still counts as connected is actually dead **and** still
holds a claim, which is the only case where sweeping changes anything. Everything
else degrades correctly without it: rejoining re-admits a stale alias on its own,
and displayed status comes from presence rather than the record.

## Context budget

What an extension puts in the model context is paid on every later turn and
stays in the session branch, so injected values are bounded and any elision is
stated rather than silent.

| Carrier | In LLM context | Used for |
| --- | --- | --- |
| `before_agent_start` system prompt | yes, every turn | peer rules and team identity, carried exactly once |
| `sendMessage` content | yes, and it persists | peer messages and review turns |
| Tool results | yes, and they persist | `team_members`, `team_send`, `team_status` |
| `appendEntry` | **no**, TUI only | notes, `/team inbox`, sent-message previews |

Consequences worth knowing:

- Peer rules are **not** repeated inside each message; they arrive once per turn
  through the system prompt.
- A delivered result quotes the original request excerpted to 500 characters,
  with the id kept. Verification of a very long request works from an extract.
- `team_status` lists are capped and report an `omitted` count. Its
  `otherTeamWork` list carries only third-party work; anything addressed to or
  emitted by this session is already in the other lists.
- Each `team_status` call is a point-in-time snapshot. Earlier results in the
  same conversation are stale but cannot be retracted, which is why each one is
  kept small.

## Task-boundary compaction

Once a result is safely persisted, the extension calls Pi's `ctx.compact()`. That
session claims no other peer message while compaction runs. The instructions
preserve user-authored goals and constraints, team identity, unresolved
requester → assignee relationships, outcomes, blockers, files, tests, and next
actions, and discard verbose tool output, duplicated payloads, completed traces,
and private reasoning.

Compaction changes model context, not extension registration or mailbox state:
`/team` commands and tools stay available, and each terminal remains an
independent Pi session rather than a spawned subagent. Pi still applies its
configured `keepRecentTokens`. If compaction fails, the TUI warns and reception
continues. User takeover skips it, because the turn is no longer an isolated team
task.

## Recovery and guarantees

Ownership tokens fence out replaced sessions. Pending messages survive
disconnection. Claimed work is marked interrupted on disconnect or rejoin and is
**not automatically replayed**, since edits may already have happened.

This favours avoiding duplicate side effects over guaranteed execution. **There is
no exactly-once guarantee** for filesystem changes or model actions: a crash after
claiming but before starting also leaves an interrupted task. If storage cannot
record a result, reception pauses and reports an error.

Membership, pause state, and pending compaction are recorded in Pi session
entries. Resuming the same session rejoins; `/new` and `/fork` do not inherit
membership. Before claiming work the extension records that restoration must
pause, without pausing the live session, so an abrupt process death during a task
restores paused and requires `/team resume`. A crash just before a claim can
conservatively require resume too.

Directory watchers provide prompt delivery; polling every two seconds recovers
missed notifications. Both run only for joined interactive sessions and close on
shutdown. Transient storage errors are reported but never pause reception.

## Design decisions and non-goals

| Concern | Choice |
| --- | --- |
| Session creation | The user opens every terminal; nothing is spawned |
| Discovery | Explicit named teams and aliases, never inferred from directories |
| Transport | Local filesystem records; no broker, socket server, or daemon |
| Presence | Per-member files outside the record; heartbeats never lock |
| Concurrent writes | Compare-and-swap with retry; no team-wide lock |
| Follow-up | Periodic review turns delegated to the agent, not programmatic retries |
| Active recipient | Wait until fully idle; no steering between tools |
| Offline recipient | Persist to a known alias until it rejoins |
| Approval | Never supplied by peers; local policies always win |
| Coordination | Direct messages and bulk check-ins; no task board or worktree manager |
| Scope | Local disks only: no network filesystems, cross-machine transport, or native Windows |

Not provided: file ownership between agents, a sandbox, an authorization system,
or protection of secrets from other processes under the same OS user.

## Pi interfaces used

`registerCommand`, `registerTool`, `sendMessage`, `appendEntry`, custom entry and
message renderers, `setWidget`, `getEditorText`, `isIdle`, `hasPendingMessages`,
`compact`, session lifecycle events, UI prompt events, `tool_result`,
`message_end`, and `agent_settled`. All public and documented; no host internals
are imported, no prototypes patched, and peer text is never shell-evaluated or
expanded as file mentions.
