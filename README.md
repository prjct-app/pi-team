# pi-team

[![pi-team — for PI Agent](https://raw.githubusercontent.com/prjct-app/pi-team/main/docs/cover.png)](https://pi.dev)

Connect independent Pi terminals into a named team so they can talk to each other.

You open the terminals and give each a role. Each one keeps its own session, model, cwd and tools, and does its own work, with its own subagents. `pi-team` lets them see each other and exchange messages. Online teammates receive messages automatically; offline recipients are refused.

## Install

Requires Pi **0.85.1** and Node.js **22.19+**.

```sh
pi install npm:@prjct.app/pi-team
```

## Quickstart

In one terminal:

```text
/team join shop backend
```

In another (any folder, repo or worktree: the team is the name, not the path):

```text
/team join shop reviewer
/team send backend Please check the login error codes
```

`join` creates the team the first time. The mode line right above the editor shows `team shop · reviewer` while this terminal is in a team.

## Commands

| Command | Meaning |
| --- | --- |
| `/team join <team> <role>` | Join `team` as `role` after a confirmation; creates the team if it does not exist. A role another Pi session holds while it is offline is taken over (the confirmation says so); a role online in another terminal is refused. Leaves any team joined before. |
| `/team` or `/team status` | Opens the team panel: every team with its members under it (● working 3m, ○ idle, offline). Detail shows what each member is on and the team's full timeline. `n` creates a team, `a` or Enter joins the selected one, `a` on an offline role joins as that role (taking it over), `m` or Enter on a member messages it (or says why it cannot: not in that team, offline, yourself), `l` leaves. `r` renames the selected team (admin) or member (yourself, or anyone as admin). `x` removes the selected role: anyone can clear an offline role (the admin's too), the admin also an online one. `d` deletes the selected team: its admin from inside, or anyone once nobody in it is online. Every join, takeover, removal, deletion, departure and rename asks for confirmation. |
| `/team send <role> <message>` | Send your own message to a teammate now. |
| `/team rename <new-name>` | Admin only: rename the team, after a confirmation. |
| `/team rename-role <role> <new-role>` | Rename your own role, or any role as admin, after a confirmation. |
| `/team leave` | Leave the team, after a confirmation. |
| `/team remove <role>` | Remove a role from the team, after a confirmation: any offline role, or an online one as admin. |
| `/team delete` | Admin only: delete the team for everyone, after a confirmation. |
| `/team help` | Usage. |

Team and role names are 1–48 lowercase letters, digits or hyphens, starting with a letter. A role belongs to the Pi session that took it. Another session gets it only by taking it over, with a confirmation, while its owner is offline. Completion suggests existing teams after `join` and online roles after `send`.

## Agent tools

While joined, the agent gets two tools and one context message that says who it is. The message is written once per change (join, rename, leave), so it survives automated turns and never edits the system prompt:

- `team_peers` lists the other terminals with their live activity.
- `team_message { to, kind: info | question | handoff, body }` sends a message.

The tool describes submission separately from reading or completing work. It encourages useful messages in the team's working language, with the result, blocker or action first. The model decides when to coordinate; independent work can continue while replies arrive. When you leave, both tools become inactive and a last message says the team context no longer applies.

The transcript shows one compact row such as `✓ TEAM → lead    info · sent`. Expanding it shows the original message as wrapped text, without a JSON wrapper or repeated receipt instructions. Renderers are registered at startup, so historical calls stay readable before joining a team or after leaving it.

## Delivery and autonomous continuation

The transport uses durable inboxes. Submission does not wait for the teammate to answer:

- **Submitted or refused.** A successful send returns the message ID and `submitted` status after writing the online teammate's inbox. It does not confirm reading or completed work. The receiver normally picks it up on its next one-second poll. A question or handoff is steered into the running turn, or opens a turn when the receiver is idle. Information (answers, findings) never wakes anyone: it is appended to the receiver's conversation and reaches the model with its next run, whatever starts that run. If it is offline at submission, the send fails and nothing is kept for later.
- **No request/result.** A question may get an answer later, as another message. Nothing tracks it or blocks on it.
- **Visible activity and full traceability.** Each terminal publishes whether it is working or idle, since when, and on what (its latest prompt). Every team keeps a timeline with exact times: joins and leaves, who started working on what, who went idle, every message (from → to, kind, text) and every send refused because the recipient was offline. The `/team` panel shows all of it, so a stalled terminal is obvious.
- **Autonomous continuation.** Questions and handoffs wake an idle terminal; busy terminals receive them as steering through the Pi SDK. A batch reaches the same automatic turn in full. A sender that needs the receiver to act sends a handoff, not info. There is no six-turn limit and no requirement for a person to type before work continues.
- **Useful communication.** The model decides whether a finding, answer, question, update or handoff helps the work. Aliases such as `answer`, `reply`, and `request` retain their meaning without changing delivery. The harness adds no repetitive instruction footer to each message and preserves evidence hashes.

## Identity

Everything is stored by ID, never by name. A team is `t-<uuid>`, and its name lives in the team's profile. A member is a UUID, and its role is a label. The timeline, the admin and the membership saved in each session all refer to IDs. So renaming a team or a role keeps its members, messages and history. A renamed terminal stays connected and is told its new name, and a session that reloads rejoins the same member, even if it was renamed while away. Team names are unique, so they can be typed; after a team is renamed, its old name is free again.

## Admin

The role that creates a team is its admin, marked by shape rather than a label: a diamond where members have a dot (◆ working, ◇ idle or offline; members show ● and ○). Teams are squares: ■ with someone online, □ empty. While you are in the team as that member, you can rename the team, rename members, remove online members, and delete the team. Offline roles can be removed by anyone, and a team nobody is online in can be deleted by anyone from the panel. The admin role moves with a takeover; once it leaves or is removed, the longest-standing member becomes admin. A removed terminal leaves the team within seconds and sees "You were removed from shop by backend". When a team is deleted, every terminal in it sees "Team shop was deleted". Removals appear in the timeline. This is team housekeeping, not security: every terminal runs as the same OS user.

## Lifecycle

Membership is saved in the session, and the role stays bound to that session until it runs `/team leave`, is removed, or is taken over while offline. Closing Pi, `/reload`, `/new` and a sleeping machine only take the terminal offline: after `/reload` or a resume, the same session takes its role back, and a sleeping terminal picks it up again when it wakes. `/fork` carries the role over to the new session; `/new` starts outside any team. An explicit `/team leave` is remembered and frees the role for another session. A session whose role was removed or taken over is told once and stops trying, so no session lingers holding a role. A role that left or was removed disappears from the team.

## Storage and safety

State lives under `${PRJCT_HOME:-~/.prjct}/pi-team/teams/<team>/`, with private permissions, strict schemas, byte limits, locks and atomic writes. Messages are at most 32 KiB. Oversized messages are rejected instead of silently truncated. A message that nobody picks up within 10 minutes (for example, because the recipient crashed) expires.

This is not a sandbox. Every terminal runs as your OS user. Teammate messages are marked as teammate data, not user instructions, and credentials in them are redacted on a best-effort basis. Message text goes to the recipient's model provider like any prompt, so do not send secrets. Local disk only: no network filesystems and no messaging across machines.

## Development

```sh
npm ci --ignore-scripts
npm run check
npm test
npm pack --dry-run
```

[Architecture](docs/architecture.md) · [Package structure](docs/package.md) · [Contributing](CONTRIBUTING.md) · [MIT](LICENSE)
