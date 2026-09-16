# pi-team

[![pi-team — extension for PI Agent](https://raw.githubusercontent.com/prjct-app/pi-clipboard/main/docs/covers/pi-team.png)](https://pi.dev)

Turn a normal implementation prompt into an autonomous local team of persistent
Pi sessions. Every managed peer works on its own branch and Git worktree; pi-team
advances a dependency plan, retries or reassigns failed work, integrates locally,
runs verification, and returns one consolidated result through the lead session.

The original explicit mailbox workflow remains available when you prefer to open
and connect terminals yourself. Both modes keep coordination state on this machine.

[![Watch the pi-team demo](media/pi-team-demo/poster.png)](https://github.com/prjct-app/pi-team/raw/refs/heads/main/media/pi-team-demo/pi-team-demo.mp4)

## Install

Requires Pi and `tmux` installed separately, plus Node.js **22.19 or later**. Managed peers run in persistent, user-attachable `tmux` terminals. Tested against
Pi **0.85.1**; newer versions are not yet verified. Independent community package.

```sh
pi install npm:@prjct.app/pi-team
```

Add `-l` for project-only installation, and restart Pi afterwards. Manage it with
the usual `pi list` / `pi update` / `pi remove` and `pi config`. Do not install the
same extension from both GitHub and npm: Pi treats those as different packages.

## Quickstart

Start Pi in a Git checkout and describe an implementation objective normally:

```text
Implement account settings with API validation, UI states, tests, and documentation.
```

No `/team create`, `join`, `wake`, `up`, or `resume` is needed. You can also force
managed mode explicitly when the request is exploratory or does not use an action verb:

```text
/team revisa qué mejoras podemos hacer considerando performance, eficiencia y seguridad
```

Unknown text after `/team` is treated as the objective; reserved command names such as
`plan`, `status`, and `join` keep their documented behavior. For an action-oriented
implementation prompt, pi-team creates a durable planning goal. The lead submits a
bounded DAG through `team_plan`; up to eight persistent Pi terminal sessions are created automatically and run in
dedicated `pi-team/<team>/<alias>` branches and private worktrees. Integration and
standard `check`, `test`, and `check:package` scripts run locally and automatically.

The live Team Plan appears automatically below the editor using Pi's native
`setWidget(..., { placement: "belowEditor" })` API. It lists the current work items,
progress, blockers, and approvals. `/team plan` temporarily replaces the editor with the
detailed keyboard/mouse activity view; it is never rendered as a floating overlay.
Arrow keys select peers, Page Up/Page Down browse activity, and `f` returns to follow mode.
Use `/team terminal` to open the selected peer's real Pi terminal in Ghostty on macOS
(or the system terminal launcher on Linux), and `/team control` to pause, cancel, retry,
reassign, or unblock work.

Before creating another managed team, pi-team scans durable plans for the current
repository and asks which existing team should receive the objective. The chooser shows
the human-readable plan name, objective, status, and every peer. Work sent to a team owned
by another lead session is queued durably for that lead instead of silently creating a
new opaque team. `/team plan` can monitor every plan in the repository without transferring
ownership.

Push and pull-request creation remain blocked at the `publish-pr` gate. Explicitly run
`/team approve publish-pr` when the proposed local result is ready to publish. After
publication is reported, `ship` appears as a separate gate; `/team approve ship` is a
second authorization for merge, release, or deployment. Peer output never grants either.

### Manual mailbox mode

To coordinate terminals you opened yourself, create and join a mailbox explicitly:

```text
# terminal one
/team create demo
/team join demo coordinator

# terminal two
/team join demo reviewer

# terminal one again
/team send reviewer Add a limits table to the README.
```

A note is display-only; a request wakes the joined reviewer once idle and returns a
correlated result. Installing alone never joins a manual mailbox.

Supported on Linux and macOS with `tmux` and local disk storage. Network filesystems,
cross-machine messaging, and native Windows are not supported.

## Concepts

A **managed team** belongs to one lead session, one repository, and one evolving factory plan. Its plan,
agent states, blockers, approvals, and structured activity live under
`~/.pi/agent/managed-teams/`. Each peer is an independent persistent Pi session running in its own attachable `tmux` terminal, with
a dedicated branch, worktree, role, and current work item. The lead is the only human
interface and never treats peer output as authorization. Repository tools are blocked in
the lead while managed work is active: research, auditing, implementation, and review are
delegated to peers. The lead remains available for normal conversation and status questions.
Managed terminals persist across assigned work but remain owned by the lead session: quitting
or replacing that session performs a bounded, identity-verified shutdown of the terminals it created.

Each lead session has one active **factory plan**, not a stack of unrelated plan widgets.
That plan accepts multiple work batches over time. Send another action-oriented prompt—or
explicitly `/team <more work>`—to append a batch. Existing peers keep their persistent
sessions and process multiple queued tasks; different idle peers run ready tasks concurrently.
The below-editor widget lists the current plan's work items, prioritizing active and blocked
work, while `/team plan` exposes the full DAG and activity.

A **manual team** is a named local mailbox. A session joins under an **alias**: an
address, not a privileged role or automatic persona, and shared rather than private —
anyone using this OS account can rejoin an offline alias and see its history. Manual
mailbox sessions retain their own cwd and do not receive managed worktree allocation.

| Kind | Meaning |
| --- | --- |
| `request` | Work for a teammate. Starts a model turn when the recipient is idle, and always produces one correlated result back to the emitter. |
| `note` | Display-only FYI. Appears in the transcript; never starts a model turn. |
| `result` | The automatic reply to a request: outcome, final text, and observed files. Delivered to the emitter for verification. |

While joined, a minimal widget above the editor shows `team · alias · state`,
where state is `connected`, `working`, `paused`, or `select a model`, plus a
pending count when work is queued for you.

Membership is restored automatically when the same Pi session is resumed or
reloaded. `/new` and `/fork` start unaffiliated sessions on purpose.

### Optional subagents

When [`@prjct.app/pi-subagents`](https://github.com/prjct-app/pi-subagents) is
installed beside pi-team, a subagent launched while a team request is active is
associated with that request's root id. The packages share only this small,
process-local bridge through `Symbol.for("prjct.agents")`; neither package imports
or requires the other, and pi-team behaves the same when pi-subagents is absent.

## Commands

The normal managed workflow has one free-form entrypoint and four operational commands:

| Command | Meaning |
| --- | --- |
| `/team <objective>` | Start the factory or append another work batch |
| `/team plan` | Choose and monitor any managed plan for this repository |
| `/team terminal` | Choose a plan and open a real peer terminal |
| `/team control` | Pause/resume a plan or cancel, retry, reassign, and unblock work |
| `/team approve publish-pr` | Confirm the first human gate for push and pull-request creation |
| `/team approve ship` | Confirm the separate post-publication merge/release/deploy gate |

Legacy manual-mailbox commands remain accepted for compatibility but are intentionally
omitted from top-level completion to keep the primary surface small:

| Advanced manual command | Meaning |
| --- | --- |
| `/team create shop` | Create explicitly; does not join automatically |
| `/team delete shop` | Permanently delete an inactive team after confirmation |
| `/team rename-team shop store` | Rename a team after every member is offline |
| `/team join shop backend` | Register this session and enable automatic reception |
| `/team list` | List teams; refresh team-name completion |
| `/team members` | Show other aliases, cwd, and idle/busy/paused/offline status; excludes this session |
| `/team remove backend` | Remove an offline alias and interrupt its unresolved work after confirmation |
| `/team rename-member backend api` | Rename your own alias, or an offline teammate, while preserving its history and queued work |
| `/team status` | Show every unresolved requester → assignee relationship |
| `/team wake [message]` | Queue an actionable check-in for every other teammate |
| `/team send backend Implement login` | Queue a request that can start work |
| `/team note frontend API contract changed` | Display an FYI; never starts a model turn |
| `/team inbox` | Show the most recent 20 records and their states |
| `/team pause` | Pause new work, without cancelling current work |
| `/team resume` | Resume reception and reset the automatic turn budget |
| `/team leave` | Leave; if processing a request, report its result first |

Names and aliases are 1–48 lowercase letters, digits, or hyphens, starting with a
letter. Unknown teams are rejected, never implicitly created; duplicate live
aliases are rejected. Sending to an offline **known** alias queues until someone
rejoins it. Removing that alias instead settles every unresolved request involving
it; incoming requests produce an interrupted result so their requesters stop waiting.
Renaming an alias rewrites its message addresses so queued work follows the new
name. Team deletion and rename require every member to be offline, and destructive
operations require confirmation. Top-level completion shows only `plan`, `terminal`, `control`, and `approve`;
a typed legacy verb can still complete discovered teams and teammates.

## Agent tools

Managed lead tools:

- `team_plan` — submit up to eight persistent roles and a validated acyclic work plan.
- `team_plan_add` — append another dependency-aware work batch to the persistent peer fleet.
- `team_plan_status` — fresh progress, dependencies, blockers, approvals, agents, and
  bounded structured activity; never wakes a model.
- `team_gate_report` — record factual publication/ship evidence after the matching
  user approval; cannot grant approval itself.

Manual mailbox tools:

- `team_members` — discover other teammates and their status; excludes this session.
- `team_send` — send `{ to, kind: "request" | "note", subject, body }`.
- `team_status` — outstanding work: what you emitted and is unresolved, what is
  queued for you, results awaiting your review, and third-party team activity.

Manual mailbox tools cannot create teams, join, resume reception, change permissions, or launch
terminals; they require membership you established. Managed orchestration creates its peer terminals itself. Discovery results and recipient
autocomplete exclude the current session, and sending to yourself is rejected at
the mailbox boundary. A request returns **queued**, never "task completed".

## How delivery works

A request or result starts a turn only when the recipient is idle, has a selected
model, no pending user message or open prompt, and an empty editor. No running
tool is interrupted.

For each processed request the extension sends **one** result after the agent
settles: the last assistant text capped at 3,000 characters (no thinking), up to
50 absolute paths observed in successful `edit`/`write` calls, and an outcome of
completed, failed, or interrupted.

That file list is **not** a Git diff. Files changed through bash, custom tools, or
other processes are not enumerated, and the extension never infers test success
from a shell command or a model claim. **A completed run is not proof of success**:
review the reported outcome and the recipient worktree.

Once a task result is persisted, the session can accept the next queued request.
While a request you emitted stays unresolved past five minutes, a review turn
asks your agent to chase the teammate or tell you what is blocked. See
[Architecture](docs/architecture.md) for implementation details.

## Safety

- Managed peers get full coding tools, including unrestricted Bash, inside their
  dedicated worktree. Their resource loader disables all ambient extensions, preventing
  recursive pi-team startup and unrelated extension side effects. A worktree is collision
  isolation, **not an OS sandbox**.
- Managed integration uses full hexadecimal commit ids and never pushes. Existing
  user-checkout changes remain untouched and are excluded from the peers' exact-HEAD base.
- Activity journals contain bounded, sanitized events—not chain-of-thought or raw
  conversation logs—and rotate at 512 KB.
- `publish-pr` and `ship` are durable, separate gates. Only an interactive user
  confirmation can grant them; a model tool can only report evidence after a grant.
- **This is not a sandbox or an authorization system.** Agents and processes under
  the same OS user already have filesystem access. Prompt-level rules are not a
  hard guarantee against a model that ignores them. Do not place untrusted agents
  in a team or rely on team boundaries to protect secrets from that OS user.
- Peer messages are identified as untrusted data and **are not user consent**.
  Agents are instructed not to relay denied work, change configuration, or evade
  plan mode. Peer text is never executed as a slash command or expanded as a file
  mention.
- Messages stay in local files, but when processed their text goes to the
  recipient's configured **model provider** like any prompt, and results go to the
  requester. Do not send credentials or unrelated secrets.
- User takeover during a peer task pauses reception and reports an interrupted
  result instead of forwarding your unrelated work.

## Limits

| Limit | Value |
| --- | --- |
| Managed peers | 8 per objective |
| Managed peer turn | 30 minutes, then abort/retry/reassign |
| Corrective verification cycles | 2 before surfacing a blocker |
| Structured activity journal | 512 KB current + one rotation; 200 events maximum per read |
| Automatic peer turns before reception pauses | 5 by default, then `/team resume`; set `PI_TEAM_AUTO_TURNS` to change it (`0` removes the cap) |
| Messages in one automatically linked conversation | 8 non-result |
| Unsettled deliveries per member | 50 slots, one reserved per outstanding request |
| Records per team | 500, including reserved result capacity |
| Members per team | 100 |
| Outgoing body / serialized message | 16 KB / 20 KB |
| Automatic result | 32 KB, file list shortened with a notice |
| Presence lease | 30 s, renewed every 2 s |
| Review threshold / cadence | 5 min unresolved, checked every 1 min |
| Duplicate suppression | identical message within 1 min is refused |

No daily token or monetary budget is enforced. History is never silently deleted:
create a fresh team when one is full. Review cadence is a fixed default.

The turn budget counts turns that ran with nobody at the keyboard of that session,
which is what it exists to bound. It is reset by typing in the session, by
`/team resume`, and by restarting the session. A pause the cap imposed is not
restored on reload; a pause from `/team pause`, a user takeover, or a crash during
a task is.

### `PI_TEAM_AUTO_TURNS`

Set it in the environment of each Pi session to change how many unattended
automatic turns run before reception pauses. `0` removes the cap, so an
unsupervised session keeps accepting peer work indefinitely — the spend and the
blast radius are then yours to bound. Invalid values fall back to `5`.

```sh
PI_TEAM_AUTO_TURNS=50 pi
```

## Troubleshooting

| Symptom | Cause and action |
| --- | --- |
| A request stays queued | Run `/team status`. The recipient may be busy, paused, offline, missing a model, or typing. After five minutes, review turns chase it or surface the blockage. |
| Every teammate heartbeats but nothing is consumed | Reception is paused on each of them, most often by the auto-turn cap; `/team members` shows `paused`. A paused member never claims work, so check-ins pile up. Resume them, or raise `PI_TEAM_AUTO_TURNS` for unattended teams. |
| `Team auto-turn limit reached` | That many automatic turns ran without user input. Review the transcript, then `/team resume`, or type anything in the session — both lift it. Raise `PI_TEAM_AUTO_TURNS` if the sessions are meant to run unattended. |
| `Message not claimed by this session` | The durable claim changed before settlement. Review for partial effects, then `/reload` or leave and rejoin before `/team resume`. After updating pi-team, reload every live teammate so all sessions use the same runtime. |
| `Membership expired or replaced` | Another live session took your alias. Rejoin, choosing a new alias if the old one is in use. |
| `Recipient inbox full` / `Sender inbox full` | Fifty unsettled deliveries per member, one slot reserved per outstanding request. Let the teammate drain; notes need no reservation. |
| `Team history full (500 records)` | At capacity; history is never deleted. Create a fresh team and rejoin. |
| Repeated storage warnings | Conflicts retry automatically and never pause reception. If one persists, check that the teams directory is on a local disk and report it. |
| A teammate went offline mid-task | Its claimed work is interrupted and the emitter receives that result; it is not replayed. Review the worktree, then resend explicitly. |
| Work remains queued for an alias that will not return | Use `/team remove <alias>` to interrupt and settle its unresolved work, or `/team rename-member <alias> <new-alias>` to preserve the queue under a replacement alias. |

## Development

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run check:package
```

Pi loads the TypeScript entry point directly; there is no build step. Use `pi -e .`
to try a checkout. Tests use isolated temporary state and never call model APIs.

The Team v2 domain, storage, membership, messaging, presence, reconciliation, and compact
model-tool layers are staged under `src/domain/`, `src/storage/`, and `src/runtime/`. They
remain disconnected from the active v1 extension until the supervisor and command phases
land, so this checkout does not mix v1 sessions with v2 records.

`npm run check` also enforces that `src/` contains no `let`: session state is a
single immutable record updated functionally, and reads go through its accessor at
the point of use rather than being captured across an `await`.

## More

- [Architecture](docs/architecture.md) — storage, concurrency, recovery, context budget
- [Package structure](docs/package.md) · [Releases](docs/releases.md) · [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md)

[MIT](LICENSE).
