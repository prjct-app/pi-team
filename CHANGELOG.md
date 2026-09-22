## Unreleased

- Add `npm run build:pi`: a compiled local build in `~/.pi/agent/builds/<package>` that Pi loads instead of the TypeScript sources; supervised workers launch the built entry.

### Breaking changes

- replace manual create/join membership with explicit `/team <objective>` orchestration
- remove legacy inspection, migration, and v1 mailbox code from the package
- store persistent project Teams under `${PRJCT_HOME:-~/.prjct}/pi-team/orchestration-v2/`

### Features

- persist bounded Run history and reusable Expert identities, sessions, memory, and assignment history
- dynamically create missing Experts and reuse existing roles across later Runs
- queue busy Experts and later objectives while allowing bounded parallel work across distinct Experts
- add the active-Run-only `team_orchestrate` tool and bounded status, history, doctor, and cancellation commands
- execute Experts through authenticated supervised workers with durable correlated replies and resource leases

### Security

- keep normal prompts inert until an explicit Team objective
- fence owners and late results by process identity, epoch, generation, request, and receipt
- inherit the launching Pi environment explicitly when tmux already has a server
- validate worker request bodies and durable assignment/sender identity before model execution
- stop only proven-owned workers; interruption preserves history without automatic replay
## [0.6.1](https://github.com/prjct-app/pi-team/compare/v0.6.0...v0.6.1) (2026-09-11)

### Bug Fixes

* preserve mailbox locks across rolling upgrades ([3509903](https://github.com/prjct-app/pi-team/commit/3509903026205a0a3d00fcd52eecb3b970ba4d7b))

## [0.6.0](https://github.com/prjct-app/pi-team/compare/v0.5.7...v0.6.0) (2026-09-10)

### Features

* manage team and member lifecycle ([0a60766](https://github.com/prjct-app/pi-team/commit/0a607661f447fa0d78bb0c100da65f68e1cf947b))

### Bug Fixes

* exclude current session from teammate discovery ([a4f340b](https://github.com/prjct-app/pi-team/commit/a4f340bad2a979216f2e8ef579b456355ace7003))

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
