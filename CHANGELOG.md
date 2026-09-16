## Unreleased

- Create every managed peer as a persistent, user-attachable tmux Pi terminal with durable mailbox communication.
- Discover existing teams for the current repository before creation, queue cross-session objectives, and provide repository-wide plan monitoring.
- Add `/team terminal` plus audited pause, resume, cancel, retry, reassign, and unblock controls.
- Show the live managed Team Plan automatically below the editor with native Pi UI, and use a non-floating detailed view.
- Allow an active factory plan to accept additional dependency-aware work batches while the lead keeps conversing; persistent peers process repeated tasks and idle peers run concurrently.
- Keep the lead orchestration-only by blocking repository research and mutation tools outside explicitly approved publication gates.
- Reduce top-level `/team` completion to the primary `plan` and `approve` operations while retaining manual-mailbox compatibility.

### Features

- add the staged Team v2 domain and independent atomic stores for teams, members, inboxes, receipts, and token-fenced leases
- add staged Team v2 membership, offline messaging, correlated requests, durable cancellation, presence, reconciliation, and a dynamically activated compact model tool
- start autonomous managed teams from normal implementation prompts
- isolate persistent peer sessions in dedicated branches and worktrees
- add dependency scheduling, recovery, reassignment, local integration, verification, and corrective jobs
- add the live clickable Team Plan TUI and bounded structured activity journals
- add separate user-only publication and ship approval gates

### Security

- reject unsafe Team v2 paths and records, enforce bounded TTL/quotas, and preserve legacy data without traversing or migrating it
- fence replaced Team v2 member and delivery owners, discard late replies, and never automatically replay a delivered request after failure
- validate worktree repository ownership and full integration commit ids
- sanitize persisted activity and keep push, PR, merge, release, and deploy behind explicit human gates
- await owner-fenced managed runtime shutdown and terminate only token-verified tmux sessions with revalidated process identity

## [0.5.7](https://github.com/prjct-app/pi-team/compare/v0.5.6...v0.5.7) (2026-09-10)

### Bug Fixes

* remove automatic team compaction ([#27](https://github.com/prjct-app/pi-team/issues/27)) ([862d64e](https://github.com/prjct-app/pi-team/commit/862d64ec2492764222f6136640498e9437ed9de4))

## [0.5.6](https://github.com/prjct-app/pi-team/compare/v0.5.5...v0.5.6) (2026-09-10)

## [0.5.5](https://github.com/prjct-app/pi-team/compare/v0.5.4...v0.5.5) (2026-09-10)

### Performance Improvements

* carry the canonical payload serialization instead of recomputing it ([#24](https://github.com/prjct-app/pi-team/issues/24)) ([340c495](https://github.com/prjct-app/pi-team/commit/340c4954358e715c6aed5e37e9f0a78f33100877))

## [0.5.4](https://github.com/prjct-app/pi-team/compare/v0.5.3...v0.5.4) (2026-09-10)

### Performance Improvements

* drop the presence fsync, the quadratic file cap and a repeated mkdir ([#23](https://github.com/prjct-app/pi-team/issues/23)) ([75e5849](https://github.com/prjct-app/pi-team/commit/75e584965bd861cea96942497618f8c261c64d8d))

## [0.5.3](https://github.com/prjct-app/pi-team/compare/v0.5.2...v0.5.3) (2026-09-10)

### Performance Improvements

* stop opening a mailbox transaction on every idle tick ([#22](https://github.com/prjct-app/pi-team/issues/22)) ([561001f](https://github.com/prjct-app/pi-team/commit/561001f1fe8bb3048c005d74ef45d97e75b7ec09))

## [0.5.2](https://github.com/prjct-app/pi-team/compare/v0.5.1...v0.5.2) (2026-09-10)

### Performance Improvements

* stop injecting duplicate and unbounded state into the model context ([#26](https://github.com/prjct-app/pi-team/issues/26)) ([be7c2ca](https://github.com/prjct-app/pi-team/commit/be7c2cab7b3e6bc4c28a32aa305d9d491cde2b9a))

## [0.5.1](https://github.com/prjct-app/pi-team/compare/v0.5.0...v0.5.1) (2026-09-10)

## [0.5.0](https://github.com/prjct-app/pi-team/compare/v0.4.4...v0.5.0) (2026-09-10)

### Features

* add team-wide wake command ([aced8df](https://github.com/prjct-app/pi-team/commit/aced8dfa19632349f70afe32c918744a58cb5a0e))

## [0.4.4](https://github.com/prjct-app/pi-team/compare/v0.4.3...v0.4.4) (2026-09-10)

### Bug Fixes

* **tui:** keep team status widget minimal ([82fa70f](https://github.com/prjct-app/pi-team/commit/82fa70f4e16a82cf2d52b82f50cfe556fd653b8c))

## [0.4.3](https://github.com/prjct-app/pi-team/compare/v0.4.2...v0.4.3) (2026-09-10)

## [0.4.2](https://github.com/prjct-app/pi-team/compare/v0.4.1...v0.4.2) (2026-09-10)

## [0.4.1](https://github.com/prjct-app/pi-team/compare/v0.4.0...v0.4.1) (2026-09-10)

## [0.4.0](https://github.com/prjct-app/pi-team/compare/v0.3.0...v0.4.0) (2026-09-10)

### Features

* compact context after team tasks ([a6c44e1](https://github.com/prjct-app/pi-team/commit/a6c44e185a8a8657096d55422268ef925157be1a))

## [0.3.0](https://github.com/prjct-app/pi-team/compare/v0.2.0...v0.3.0) (2026-09-10)

### Features

* **tui:** show unresolved request flow ([d07be93](https://github.com/prjct-app/pi-team/commit/d07be93c869dfc01caeae597ae82390024552855))

## [0.2.0](https://github.com/prjct-app/pi-team/compare/v0.1.3...v0.2.0) (2026-09-10)

### Features

* concurrent optimistic storage and agentic task follow-up ([5c247e1](https://github.com/prjct-app/pi-team/commit/5c247e1566f138a04b722d0671a1760e6276dd02)), closes [#8](https://github.com/prjct-app/pi-team/issues/8)

### Bug Fixes

* **release:** align conventionalcommits preset with the bundled writer ([c6ede1f](https://github.com/prjct-app/pi-team/commit/c6ede1f43a3dc8a87ff648dbefaeff7dcdb80741))

# Changelog

## 0.1.3

- Clarify the package description and add focused discovery keywords.
- Declare the cover image for the official Pi package gallery.

- Align repository, documentation, and cover URLs with the npm package name.

## 0.1.2

- Use a publicly accessible cover URL so npm renders the image for every visitor.

## 0.1.1

- Add a dedicated cover to the GitHub and npm README.
- Keep the existing extension behavior unchanged.

## 0.1.0

- Set the npm package identity to `@prjct.app/pi-team`.
- Clarify installation, project scope, updates, removal, usage, and limitations.
- Document resource discovery and dependencies against the official Pi 0.85.1 guides.
- Include contribution and package documentation in the release file list.

Initial npm release. The documentation and naming changes preserve the existing extension runtime behavior.
