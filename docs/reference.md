# Reference and deliberate differences

Verified against the live official Markdown documentation during implementation:

- https://code.claude.com/docs/en/cross-session-messaging.md
- https://code.claude.com/docs/en/agent-teams.md

The closest reference is **cross-session messaging**: independently started sessions,
discovery with `ListAgents`, communication with `SendMessage`, compact expandable
previews, and per-session permission boundaries. Current documentation says local
Claude Code sessions use per-session sockets/named pipes. The team feature adds a
lead that spawns teammates, optional shared task coordination, and JSON mailboxes.
These are distinct features; historical `TeamCreate` examples are not current.

Our user-selected scope differs deliberately:

| Concern | pi-team |
| --- | --- |
| Session creation | User opens all terminals |
| Discovery | Explicit named team and aliases |
| Transport | Local filesystem records with optimistic concurrency, no broker or socket server |
| Presence | Per-member files outside the shared record; heartbeats never lock |
| Concurrent writes | Compare-and-swap revisions with retry; no team-wide lock |
| Follow-up | Periodic review turns delegated to the agent, not programmatic retries |
| Active recipient | Wait until fully idle; no between-tool steering |
| Offline recipient | Persist to a known alias until rejoin |
| Results | Automatic last-text reply to requests, quoted against the original request |
| Approval | Never supplied by peers; preserve local policies |
| Coordination | Direct messages, `/team wake [message]` bulk check-ins, and task-boundary context compaction; no task board or worktree manager |
| Limits | Bounded conversations, inboxes and automatic turns |
| UI | Existing Pi loader plus a minimal session widget, on-demand requester → assignee flow through `/team status`, and expandable messages |

Pi APIs used: `registerCommand`, `registerTool`, `sendMessage`, custom entry/message
renderers, `setWidget`, `getEditorText`, `isIdle`, `hasPendingMessages`, `compact`,
session lifecycle, UI prompt events, `tool_result`, `message_end`, and `agent_settled`.
No monkey-patching of Pi internals, shell evaluation of peer messages, forwarding
of thinking, or modifications to existing local extensions are required.

Integration tests exercise the extension through a simulated Pi API, backed by real
filesystem operations. The three-process scenario hosts PM/backend/frontend in
separate Node processes, checks queued delivery and correlated responses, kills the
backend, and checks recovery. This is not a live three-model behavioral evaluation.
