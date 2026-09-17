# pi-team

[![pi-team — extension for PI Agent](https://raw.githubusercontent.com/prjct-app/pi-clipboard/main/docs/covers/pi-team.png)](https://pi.dev)

Coordinate explicit, local teams of Pi sessions. Join sessions under stable member identities, exchange durable requests and replies, optionally start supervised peers in `tmux`, and inspect the team from an on-demand terminal dashboard.

pi-team does **not** intercept normal prompts, create plans from them, allocate Git branches or worktrees, or publish repository changes.

## Install

Requires Pi, Node.js **22.19 or later**, and `tmux` only when starting supervised peers. Tested with Pi **0.85.1** on macOS and Linux.

```sh
pi install npm:@prjct.app/pi-team
```

Add `-l` for project-only installation and restart Pi. Do not install the same extension from both npm and GitHub.

## Quickstart

Create and join a team in one session:

```text
/team create shop lead
```

Join it from another Pi session:

```text
/team join shop reviewer
```

Ask the model to use the compact `team` tool to inspect peers, send a note or request, explicitly reply, or claim an advisory resource. The tool is available only while that session owns a membership.

Start a supervised peer from the human-controlled session:

```text
/team start backend /absolute/path/to/repository
```

Only peers started by this explicit command receive requests automatically. Externally opened sessions never do. `/team status` opens a bounded dashboard that adapts from a compact single-column view to a wide list-and-detail layout. It preserves selection by stable record ID while resizing; arrow keys navigate, Enter toggles inline details, and Escape closes only the view—running operations continue.

## Commands

Lifecycle and process operations are human-only commands:

| Command | Meaning |
| --- | --- |
| `/team create <team> <alias>` | Create and join a Team v2 team |
| `/team join <team> <alias>` | Join an existing open team |
| `/team start <alias> <existing-cwd>` | Start a supervised Pi peer in owned `tmux` runtime |
| `/team status` | Open the on-demand dashboard (plain output in print mode; notification in RPC mode) |
| `/team inbox` | List bounded inbox metadata, never message bodies |
| `/team receive <message-id>` | Read a correlated result explicitly |
| `/team stop <alias>` | Gracefully stop an owned supervised peer after confirmation |
| `/team kill <alias>` | Stronger confirmation for the same identity-fenced shutdown path |
| `/team leave` | Leave and stop this session's supervised peers |
| `/team close` | Close the team after bounded owned-runtime shutdown |
| `/team doctor` | Show bounded diagnostics without ownership tokens |
| `/team legacy inspect` | Explicitly inventory preserved legacy roots, shallowly and read-only |
| `/team legacy stop` | Report legacy runtime evidence and safe manual guidance; sends no signals |
| `/team migrate <team>` | Import only safe legacy team metadata as a closed v2 archive |
| `/team purge <team>` | Permanently remove a closed, inactive v2 team after confirmation |

Names are lowercase identifiers beginning with a letter and containing letters, digits, or hyphens. Unknown teams are rejected rather than created implicitly.

## Model tool

The dynamically activated `team` tool exposes only:

- `status`, `peers`, `inbox`, and `read`
- `send` and explicitly correlated `reply`
- advisory resource `claim` and `release`

It cannot create, join, start, stop, kill, leave, close, migrate, or purge. Peer text is untrusted data and never grants authorization. Requests that reached a model are never automatically replayed after interruption, favoring duplicate-effect prevention over guaranteed execution.

## Membership and delivery

Membership is fenced by identity, generation, and lease token. The exact same Pi session survives `/reload`; `/new` and `/fork` do not inherit membership or owned peers. Resuming a historical session may restore its own membership but cannot adopt another session's supervised runtimes.

External peers receive durable inbox messages but are never woken or terminated by pi-team. Supervised peers authenticate to their owner over a private Unix control socket and can receive requests when idle. Replies and cancellation are request-correlated. Long turns renew their delivery claim; late replies to terminal requests are discarded.

Advisory resource claims are normalized against the claimant's cwd and block Pi `edit` and `write` calls that overlap another member's live claim. Shell commands cannot be parsed safely, so Bash receives only a warning when it visibly mentions a claimed resource. Claims are coordination aids, not filesystem permissions.

## Storage and safety

Team v2 state is under `${PRJCT_HOME:-~/.prjct}/pi-team/`. Team metadata, members, inbox entries, receipts, leases, and owned runtimes are independent bounded records. Private permissions, symlink rejection, strict schemas, atomic publication, one previous metadata copy, quotas, TTLs, and generation fencing are enforced. Corrupt or future records are preserved for manual recovery.

Supervised shutdown is bounded and idempotent. Before signaling, pi-team revalidates runtime ownership, PID start token, process group, and token-marked `tmux` metadata. If identity cannot be proven, shutdown is blocked rather than guessed. External peers are never signaled. `/team kill` does not bypass these checks.

This is not a sandbox or authorization boundary. Peers run with the current OS user's permissions, and messages sent to a peer's model go to that peer's configured model provider. Do not send secrets.

## Legacy data

Startup performs only existence checks for the old `~/.pi/agent/teams` and `${PI_CODING_AGENT_DIR:-~/.pi/agent}/managed-teams` roots. It never traverses, migrates, deletes, or signals legacy state automatically.

`/team legacy inspect` is explicit, bounded, shallow, symlink-safe, and read-only. `/team migrate <team>` requires confirmation and creates a collision-free **closed metadata archive** only. It does not copy members, messages, receipts, leases, process ownership, journals, snapshots, worktrees, or managed plans. Source bytes remain untouched. Legacy managed-factory state is inspection-only and cannot be migrated.

## Limits

Defaults include 100 members, 100 pending/claimed inbox entries per recipient, 1,000 per team, 8 KiB message bodies, 24-hour maximum message TTL, bounded dashboard pages, and bounded control frames. Storage is for local disks only; network filesystems, cross-machine messaging, and native Windows are unsupported.

## Development

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run check:package
```

Pi loads `index.ts` directly; there is no build step. `npm run check` also enforces strict TypeScript and no `let` bindings under `src/`.

- [Architecture](docs/architecture.md)
- [Package structure](docs/package.md)
- [Contributing](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)

[MIT](LICENSE)
