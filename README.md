# pi-team

[![pi-team — extension for PI Agent](https://raw.githubusercontent.com/prjct-app/pi-clipboard/main/docs/covers/pi-team.png)](https://pi.dev)

Coordinate independent PI Agent sessions with local team messaging, queued tasks, and shared results.

`@prjct.app/pi-team` · Team commands, messaging tools, and local mailbox storage; one extension.

## Install

Requires Pi installed separately and Node.js **22.19 or later**. Compatibility is tested with **Pi 0.85.1**; newer versions are not yet verified. This is an independent community package.

Install with Pi's package manager:

```sh
pi install npm:@prjct.app/pi-team
```

For project-only installation, add `-l`: `pi install -l npm:@prjct.app/pi-team`. Restart Pi after installation. Do not install the same extension from both GitHub and npm: Pi treats those as different package identities.

## Usage

Open two interactive Pi terminals. In the first:

```text
/team create demo
/team join demo coordinator
```

In the second:

```text
/team join demo reviewer
```

Back in the first terminal:

```text
/team note reviewer Please review the current README.
```

A note appears in the transcript without starting model work. Use `/team send reviewer <task>` when you intend to queue work. Installation alone never joins a team. See the command reference below before enabling automatic reception.

Supported on Linux/macOS with local disk storage. Native Windows, shared network filesystems, and cross-machine messaging are not supported. Tests cover simulated Pi/model boundaries and real local processes; live model coordination still requires manual acceptance.

## Three terminals

In the planning terminal:

```text
/team create shop
/team join shop pm
```

In a backend worktree or repository:

```text
/team join shop backend
```

In a frontend worktree or repository:

```text
/team join shop frontend
```

Then tell PM: "Coordinate the login feature with backend and frontend. Agree on the
API contract before implementation. Ask me before any push or deployment."

`pm` is an address, not a privileged role or an automatic persona. Give each agent
its responsibilities in its own session. Each retains its own model, cwd,
instructions, permissions and conversation. Team names connect separate worktrees;
they are not inferred from directory names. Two agents using the same files can
still overwrite each other's edits: this package does not manage file ownership.

### Commands

| Command | Meaning |
| --- | --- |
| `/team create shop` | Create explicitly; does not join automatically |
| `/team join shop backend` | Register this session and enable automatic reception |
| `/team list` | List teams; refresh team-name completion |
| `/team members` | Show aliases, cwd, and idle/busy/paused/offline status |
| `/team send backend Implement login` | Queue a request that can start work |
| `/team note frontend API contract changed` | Display an FYI; never starts a model turn |
| `/team inbox` | Show the most recent 20 sent/received records and their states |
| `/team pause` | Pause new work, without cancelling current work |
| `/team resume` | Resume reception and reset the five-turn automatic budget |
| `/team leave` | Leave; if processing a peer request, report its result first |

Team names and aliases accept 1–48 lowercase letters, digits or hyphens, beginning
with a letter. Unknown teams are rejected, never implicitly created. Duplicate
live aliases are rejected. Tab completion supports subcommands, discovered team
names and current teammate aliases. `/team list` refreshes teams created elsewhere.

Sending to an offline **known** alias queues work until someone explicitly rejoins
that alias. Sending to an unknown alias fails. An alias is a shared team address,
not a private address for a particular human; anyone using this OS account can
rejoin an offline alias and see its history. Use a new alias for a different role.

### Agent tools

- `team_members`: discover the current team, without leaking lease tokens.
- `team_send`: send `{ to, kind: "request" | "note", subject, body }`.
- `team_status`: read-only view of outstanding work: requests you emitted still
  unresolved, work queued for you, results awaiting your review, and presence.

Tools cannot create teams, join, resume reception, change permissions, or launch
terminals. They require membership established by you. Requests return **queued**,
not "task completed". Tools and manual commands use the same mailbox validation.

## Delivery and results

Requests and correlated results start a new turn only when the recipient is idle,
has a selected model, no pending user messages or open extension prompt, and an empty editor.
A second readiness check handles a user starting work during a filesystem read.
No running tool is interrupted. Notes are transcript-only; view them with
`/team inbox`. They are not injected into the model's context.

Incoming/outgoing messages show a folded preview. Use Pi's tool-output expansion
shortcut (Ctrl+O by default) to read the full content. `/team inbox` refreshes the
persisted state; an old transcript preview is an event snapshot, not a live receipt.

For each processed request, the extension automatically sends **one** correlated
result after `agent_settled`, not merely after an individual model/tool turn:

- Last assistant **text**, capped at 3,000 characters. No thinking blocks.
- Up to 50 absolute file paths observed in successful `edit`/`write` results.
- An execution outcome: completed, failed, or interrupted.

The assistant is instructed to include actual test results and blockers in its final
text. The extension does **not** infer test success from a shell command or model
claim. It does not automatically enumerate files changed through bash, custom tools,
or other processes. The observed file list is not a Git diff or a complete change
inventory. A completed run is not proof of task success; review the reported outcome
and changes in the recipient worktree.

Results may wake the requester so it can continue coordinating, but processing a
result never produces another automatic reply. Delivered results quote the
original request, and agents are instructed to verify the deliverable against it
and reply in-thread with exactly what is missing when a result is incomplete or
failed. Notes/acknowledgements never wake a model.

While you have emitted requests that stay unresolved past five minutes, an
automatic review turn asks your agent every minute to chase the responsible
teammate in-thread or report the blockage to you. Reviews quiet down after three
turns without mailbox progress and re-arm on any change; they share the
five-turn automatic budget, never start new work, and never retry interrupted
work on their own.

User takeover during a peer task pauses reception and sends an interrupted
notice instead of forwarding the unrelated final answer. Files observed after the
takeover are not included. `/team leave` does not cancel the current run; quitting
Pi or reloading while working produces an interrupted record, not a success report.

## Limits and safety

- At most five automatic peer turns per session before reception pauses. Use
  `/team resume` to continue. No daily token or monetary budget is enforced.
- At most eight non-result messages in an automatically linked conversation.
- Duplicate sender/recipient/subject/body messages within one minute are refused.
- Maximum 16 KB per outgoing body, 20 KB per serialized outgoing message, and
  50 inbox slots per recipient. Pending/claimed deliveries occupy a slot until
  settled, and each outgoing request reserves another slot for its automatic reply.
  A send is rejected if the recipient is full, or if a request's sender cannot
  reserve its reply. Notes need no reply reservation. Automatic replies are capped
  at 32 KB; their observed file list is shortened with a notice when necessary.
  Older teams may already be overcommitted; allow them to drain before sending
  more work. Results for previously accepted requests are never discarded.
- Maximum 100 aliases and 500 message records per team, reserving result capacity
  for outstanding requests. History is not silently deleted. Create a fresh team
  when full. Inbox display is limited to the latest 20; persisted records remain.
- Peer messages explicitly identify their origin and are not user consent. Rules
  instruct agents not to relay denied work, alter configuration, or evade plan mode.
- Text is delivered as a custom message, never executed as a slash command or used
  for automatic `@file` expansion. The session's normal tool policy still applies.
- This is **not a sandbox or an authorization system**. Agents and processes under
  the same OS user already have filesystem access. Prompt-level rules are not a
  hard guarantee against a model that ignores instructions. Do not place untrusted
  agents in a team or rely on team boundaries to protect secrets from that OS user.
- Messages stay in local mailbox files but, when processed, their text is sent to
  the recipient's configured model provider like normal prompt content. Results
  are also shared with the requester. Do not send credentials or unrelated secrets.

## Persistence and recovery

Storage: `~/.pi/agent/teams/<team>/state.json` (respects `PI_CODING_AGENT_DIR`).
Each team is one small JSON record stored with optimistic concurrency: readers
never wait on a lock, and writers compare-and-swap a monotonically increasing
revision, retrying against a fresh read on conflict. Many agents can therefore
write at the same time instead of queueing for a team-wide lock. Every
publication is written to a private temporary file, synced, hard-linked into a
bounded `revisions/` history, and atomically renamed into place; the history
doubles as recovery evidence for interrupted writes. Files are 0600 and team
folders 0700; envelopes carry a content hash. Unsafe/symlinked roots or mailbox
files and invalid schemas fail closed; corrupt files are preserved for manual
recovery, not erased. Mailboxes written before envelope records migrate
transparently on their first write.

Presence lives outside the shared record: each member renews its own
`presence/<alias>.json` every two seconds, so heartbeats add no write
contention. Presence expires after 30 seconds, or sooner when the recorded
process has exited. A lock abandoned by a crashed writer is reclaimed after ten
seconds. Transient storage errors are reported but never pause reception; the
next tick retries.

Directory watchers provide prompt delivery; periodic polling recovers missed
notifications. Watchers and timers only run for joined interactive sessions and are
closed on shutdown. Teammates observing a disconnected peer holding a claim
sweep it so its requester receives an interrupted result instead of waiting
forever.

Ownership tokens fence out replaced sessions. Pending messages survive disconnection.
Claimed work is marked interrupted on disconnect/rejoin; it is **not automatically
replayed**, since edits may already have happened. This favors avoiding duplicate
side effects over guaranteed execution: a crash after claiming but before starting
can also leave an interrupted task. There is no exactly-once guarantee for filesystem
changes or model actions. If storage cannot record a result, reception pauses and
reports an error; review before retrying.

Membership and pause state are recorded in Pi session entries. Resuming the same
session can rejoin; `/new` and `/fork` do not inherit membership. Explicit leave
clears restoration. Before attempting to claim work, the extension records that
restoration must pause, without pausing the live session. Successful result
persistence clears this recovery-only pause; failures and interruptions retain it.
Thus even an abrupt process death restores paused and requires `/team resume`
before pending work starts. A crash just before a claim can conservatively require
resume too. History and pending work remain in the team until explicitly managed
outside this prototype.

Local disks only: shared network filesystems, containers with separate home
directories, cross-machine transport, and native Windows are not supported here.


## Manage the package

For an npm installation:

```sh
pi list
pi update npm:@prjct.app/pi-team
pi remove npm:@prjct.app/pi-team
```

Use `pi config` to enable or disable individual resources. Use `pi config -l` for project settings and add `-l` to removal when you installed locally.

To pin version 0.1.3, use `pi install npm:@prjct.app/pi-team@0.1.3`. Pi skips pinned npm versions during package updates. For a Git installation, update or remove using the same `git:github.com/prjct-app/pi-team` source instead of the npm source.

When switching from GitHub to npm, remove the Git installation first, then install the npm package and restart Pi.

## Troubleshooting

If a request stays queued, check `/team members`, the recipient model, pause state, and whether its editor or agent is busy. Emitted requests that age past five minutes trigger automatic review turns that chase the teammate or surface the blockage to you. Use `/team resume` when reception pauses after its automatic turn budget.

## Package and API documentation

Uses public commands, tools, lifecycle events, custom messages, and persisted session entries. Storage is self-contained (no runtime dependencies); Pi libraries remain peer dependencies.

See [Package structure and compatibility](docs/package.md) for the manifest, dependency policy, shipped resources, and official references. This package follows the [official Pi package guide](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/packages.md) and [extension API guide](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/extensions.md) for the tested version.

## Development

From a repository checkout:

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run check:package
```

Pi loads the TypeScript entry point directly; no build step is required. To try this checkout for one run, use `pi -e .`. Tests use isolated temporary state and do not call model APIs. See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution rules and [CHANGELOG.md](CHANGELOG.md) for release notes.

## License

[MIT](LICENSE).
