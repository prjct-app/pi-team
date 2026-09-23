# Architecture

## Integration

`src/index.ts` registers `/team` and, lazily on the first join, the `team_peers` and `team_message` tools. At startup it creates no records, adds no tools and leaves the prompt unchanged. While the terminal is joined:

- the two tools are active, and they are removed again on leave;
- `before_agent_start` appends one stable line naming the role and the team, and records the prompt as the terminal's focus;
- a poll loop (1 s) receives messages, and every 10 s it renews presence.

Membership is persisted with `pi.appendEntry('team-membership', …)`, which is free and never enters model context. It is restored on `session_start`. On `session_shutdown` the role is released, so a reload can take it back right away.

## Messaging model

`src/team/session.ts` (`TeamSession`) holds one terminal's membership and does no queuing of work:

- `send` resolves the role and **refuses offline recipients**. Messages use kinds `info | question | handoff` and a 10-minute TTL. There is no request/reply correlation.
- `receive` claims, reads and finishes each pending message exactly once, in creation order.
- `setActivity` / `teammates` publish and read `teams/<team>/activity/<member>.json` (`working | idle`, since, focus) next to the presence lease, so `/team` and `team_peers` show where each terminal is.

`index.ts` delivers a received message with `sendMessage`. A busy terminal gets it steered into its running turn. An idle one gets a new turn, up to `AUTO_TURN_LIMIT` (6) consecutive teammate-opened turns. After that, messages are shown without triggering a turn until interactive input resets the counter. Delivered content is one header line plus the body; nothing else is added to context.

## Panel

`src/team/panel.ts` builds the `/team` panel on the shared pi-tui-kit docked panel. It reloads a snapshot every second: teammates, their activity, and the team's message trace (`teams/<team>/messages.json`, the last 100 messages, written on send). The panel does not hold the command queue.

## Transport

`src/runtime` and `src/storage` provide the durable transport: team and member records, presence leases, per-member inboxes, delivery leases and receipts, with strict schemas, byte bounds, private permissions, symlink checks, locks and atomic writes. Members join as `external`. Rejoining a role keeps its member ID and bumps its generation. A live role cannot be taken by a second terminal. The request/reply and resource-lease services remain in the transport, but the extension does not use them.

## Removed

The autonomous orchestrator (Runs, Experts, tmux supervision, `team_orchestrate`) was removed. Parallel work inside one terminal belongs to pi-subagents. Its old `orchestration-v2` store is left untouched.
