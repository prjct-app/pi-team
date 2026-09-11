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

Writers compare-and-swap on the revision under a short-lived per-team lock in
`~/.pi/agent/teams/.locks/`. Keeping the lock outside the team directory lets
rename and deletion fence stale publishers without allowing them to recreate a
moved directory. Normal publications also acquire the pre-0.6 compatibility
lock beside `state.json`, after the stable lock. This overlap is required while
sessions from both sides of the lock migration remain alive during a rolling
reload; without it, two versions could publish the same next revision and lose
a claim. The compatibility lock is opened without creating its parent, so a
stale writer still cannot resurrect a deleted team. A conflict fails fast and
the caller retries against a fresh read. A lock abandoned by a crashed writer
is reclaimed after ten seconds.

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
A member is also considered gone as soon as its recorded process has exited. A
heartbeat never creates a missing parent directory, so one already in flight
cannot resurrect a team after rename or deletion.

## Request lifecycle

A request is queued, claimed when the recipient is idle, worked on, and settled
with a result delivered back to the emitter. Once settlement is durable, the
recipient can accept another team turn; the emitter verifies the result against
its original request and replies in-thread only if something is missing.

States are `pending`, `processing`, `completed`, `interrupted`, and `seen`
(notes already displayed).

## Sweeping orphaned claims

A session that dies holding a claim would otherwise leave its requester waiting
forever, so peers interrupt the claim on its behalf and the requester receives an
`interrupted` result.

Leaving marks a member offline but retains its address and history so the same
alias can rejoin. Therefore "someone is offline" is not enough to decide when to
sweep. A snapshot instead reports `sweepable`, true only when a member the record
still counts as connected is actually dead **and** still holds a claim, which is
the only case where sweeping changes anything. Everything else degrades correctly
without it: rejoining re-admits a stale alias on its own, and displayed status
comes from presence rather than the record.

## Team and member lifecycle

Lifecycle changes are user-only commands; agents receive no tool that can delete
or rename identities. Removing a member is allowed only while it is offline. The
operation removes the roster entry, cancels unresolved work emitted by that alias,
and turns requests addressed to it into interrupted results for their requesters.
Renaming rewrites every message endpoint so pending work and history follow the new
alias. A live session may rename itself; only offline peers can be renamed by
another member. Ownership tokens fence the old alias after either operation.

Team rename and deletion require every recorded member to be offline. They acquire
stable locks for both names in lexical order, preventing deadlock and fencing
concurrent joins or publishers. Rename moves the directory first and then writes a
new revision with the new team name. If the process stops between those steps,
repeating the same rename recognizes and completes that partial state. Deletion
first moves the directory to a hidden tombstone and then recursively removes it,
so readers never observe a partially deleted public team directory.

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
- Teammate discovery, status rosters, `/team members`, and recipient completion
  omit the current alias. The mailbox independently rejects self-addressed
  messages, so a stale UI or direct tool call cannot create a self-reply loop.

## Recovery and guarantees

Ownership tokens fence out replaced, renamed, or removed sessions. Pending
messages survive disconnection and alias/team rename. Claimed work is marked
interrupted on disconnect or rejoin and is **not automatically replayed**, since
edits may already have happened.

This favours avoiding duplicate side effects over guaranteed execution. **There is
no exactly-once guarantee** for filesystem changes or model actions: a crash after
claiming but before starting also leaves an interrupted task. If storage cannot
record a result, reception pauses and reports an error.

Reception pauses for one of three reasons, and only one of them is transient.
The auto-turn cap (`PI_TEAM_AUTO_TURNS`, default 5, `0` to remove) pauses to
demand a person; typing in the session, `/team resume`, or restarting it all
supply that and lift the pause, so the cap is never recorded for restoration. An
explicit `/team pause` and a recovery pause after a takeover, a failed turn, or a
crash during a task are recorded and do survive a reload.

Membership and pause state are recorded in Pi session entries. Resuming the same
session rejoins; `/new` and `/fork` do not inherit membership. Before claiming
work the extension records that restoration must pause, without pausing the live
session, so an abrupt process death during a task restores paused and requires
`/team resume`. A crash just before a claim can conservatively require resume too.
Legacy pending-compaction fields from earlier releases are ignored on restore.

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
| Coordination | Direct messages and bulk check-ins; no task board, automatic compaction, or worktree manager |
| Scope | Local disks only: no network filesystems, cross-machine transport, or native Windows |

Not provided: file ownership between agents, a sandbox, an authorization system,
or protection of secrets from other processes under the same OS user.

## Pi interfaces used

`registerCommand`, `registerTool`, `sendMessage`, `appendEntry`, custom entry and
message renderers, `setWidget`, `getEditorText`, `confirm`, `isIdle`,
`hasPendingMessages`, session lifecycle events, UI prompt events, `tool_result`,
`message_end`, and `agent_settled`. All public and documented; no host internals
are imported, no prototypes patched, and peer text is never shell-evaluated or
expanded as file mentions.
