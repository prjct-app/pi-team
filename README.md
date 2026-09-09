# pi-team

Minimal local messaging between independent Pi terminals. Open your own sessions,
assign aliases, and let them exchange requests and results. No server, terminal
manager, shared task board, or dependency on Herdr.

## Status

Standalone package for Pi 0.85.1 on Linux/macOS. Typechecked and tested with a simulated
Pi/model boundary and real filesystem messaging between three OS processes. Tests
make no model API calls. Live model coordination still needs manual acceptance.

Membership and message reception remain explicitly opt-in; installing the package
does not join a team.

## Install

```sh
pi install git:github.com/prjct-app/pi-team
```

Restart Pi after installation. To remove it:

```sh
pi remove git:github.com/prjct-app/pi-team
```

The package has not been published to npm. To try the checkout without installing:

```sh
pi -e ./index.ts
```

Pass that extension flag in **each** terminal. It does not replace your footer or
activity extension. A joined session adds one compact status widget. The built-in
working indicator and activity view continue to show the current phase.

Membership is opt-in and limited to one team per session. Starting Pi alone never
joins a team or starts peer work. Merely loading the extension discovers local team
names; it does not launch a watcher until you join.

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
result never produces another automatic reply. Notes/acknowledgements never wake a
model. User takeover during a peer task pauses reception and sends an interrupted
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

Storage: `~/.pi/agent/teams/<team>/state.json` (respects `PI_CODING_AGENT_DIR`). Each
team holds member leases and per-recipient inbox records in one small transactional
JSON document. It is protected by `proper-lockfile`, written to a private temporary
file, synced, atomically renamed and directory-synced. Files are 0600 and team
folders 0700. Unsafe/symlinked roots or mailbox files and invalid schemas fail
closed; corrupt files are preserved for manual recovery, not erased.

Directory watchers provide prompt delivery; periodic polling recovers missed
notifications. Watchers and timers only run for joined interactive sessions and are
closed on shutdown. Presence renews every two seconds and expires after 30 seconds,
or sooner when the recorded process has exited. A crashed lock holder can require
about ten seconds before its lock is reclaimed.

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

## Development

```sh
npm install
npm run check
npm test
npm pack --dry-run
# Optional: installed Pi CLI + Python 3 + PTY; isolated config, no model calls
python3 scripts/smoke-tui.py
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for branch/PR rules and
[docs/reference.md](docs/reference.md) for the Claude Code comparison.
