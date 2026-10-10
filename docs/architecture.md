# Architecture

## Integration

`src/index.ts` registers `/team` and the inactive `team_peers` and `team_message` definitions at startup. The public `registerToolRenderer` hook supplies a compact renderer even for historical calls before joining. At startup it creates no team records and leaves the prompt unchanged. While the terminal is joined:

- the two tools are active, and they are removed again on leave;
- one persisted message records the role on membership changes; `before_agent_start` records the prompt as the terminal's focus;
- a poll loop (1 s) receives messages, and every 5 s it renews presence.

Membership is persisted with `pi.appendEntry('team-membership', …)`, which is free and never enters model context. It is restored on `session_start`. On `session_shutdown` the role is released, so a reload can take it back right away.

## Messaging model

`TeamSession` (from `@prjct.app/team-core`) holds one terminal's membership and does no queuing of work:

- `send` resolves the role and **refuses offline recipients**. It returns `submitted` with the message ID only after the durable inbox write; this does not confirm reading or completed work. Messages use kinds `info | question | handoff` and a 10-minute TTL. There is no request/reply correlation.
- `receive` claims, reads and finishes each pending message exactly once, in creation order.
- `setActivity` / `teammates` publish and read `teams/<team>/activity/<member>.json` (`working | idle`, since, focus) next to the presence lease, so `/team` and `team_peers` show where each terminal is.

`index.ts` delivers every message kind with the public Pi `sendMessage` API. A busy terminal receives steering with `triggerTurn: true`. For an idle batch, earlier messages are appended with `followUp` and no trigger, then the last opens one turn. `nextTurn` is reserved for passive status text because it waits for interactive input. The role is part of the `team_message` description, registered again on join and rename, so it survives compaction and automated turns without a context message. Gating wakes by kind was tried in 0.10.0 and reverted: agents report results as info, and teams stalled. No wake counter, rate window, or held-message queue blocks continuation.

## Panel and timeline

`src/team/panel.ts` builds the `/team` panel on the shared pi-tui-kit docked panel. It lists every team on disk, each with its members, and reloads every second. Team detail shows the members and the whole timeline; member detail shows that member's activity and its part of the timeline. Actions that need typed input (`n` create, `a`/Enter join, `m` message) close the panel, ask with `ctx.ui.input`, act, and reopen it on the affected row. The panel never holds the command queue.

`TeamSession.record` appends to `teams/<team>/events.json` (the last 300 events, under a storage lock): `joined` (with cwd), `left`, `working` (with focus, only when state or focus changes), `idle`, `message` (full text), and `refused` (offline or unknown recipient). Tracing is best-effort and never blocks the work it traces.

## Identity

Teams are created as `t-<uuid>` directories with `profile.json` (`name`, `adminId`, `createdAt`). Names are unique under a `team-names` lock, which covers creation and rename. Members are UUIDs. Membership ownership is checked by member ID, generation, presence lease and session, not by alias, so an alias can be renamed while the member is online. `heartbeat` picks up new names. Events store member IDs (`by`, `to`) and are resolved to current aliases when read. The session entry stores `{ teamId, memberId, team, role }`. On restore, `memberships.join` rejoins that exact member by ID, under whatever alias it has now. Legacy teams without a profile are named by their directory, and their first member is admin.

## Admin, removal and deletion

The admin is the creator's member ID, stored in the profile. Only the admin may rename the team, rename other members, remove members, or delete the team; a member may rename itself. Every one of these, and leave, is confirmed in the UI before it runs. `removeMember` records a `removed` event first and then marks the member `left`, which fences its presence. `deleteTeam` removes `teams/<team>/` under the team lock. `setActivity` and `record` check that the team still exists, so a late write cannot bring back a half directory. On a failed heartbeat (every 5 s), `fate` tells the terminal whether the team was deleted, the role was removed (and by whom), or another terminal took it. Removed and deleted are remembered in the session, so a reload does not rejoin.

## Transport

The durable transport lives in [`@prjct.app/team-core`](https://github.com/prjct-app/team-core), a plain npm dependency shared with the Claude Code team mod, so every client writes the same format with the same locks: team and member records, presence leases, per-member inboxes, delivery leases and receipts, with strict schemas, byte bounds, private permissions, symlink checks, locks and atomic writes. Members join as `external`. Rejoining a role keeps its member ID and bumps its generation. A live role cannot be taken by a second terminal. The request/reply and resource-lease services remain in the transport, but the extension does not use them.

## Removed

The autonomous orchestrator (Runs, Experts, tmux supervision, `team_orchestrate`) was removed. Parallel work inside one terminal belongs to pi-subagents. Its old `orchestration-v2` store is left untouched.
