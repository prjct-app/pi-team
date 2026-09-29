## [0.9.1](https://github.com/prjct-app/pi-team/compare/v0.9.0...v0.9.1) (2026-09-29)

### Bug Fixes

* info messages no longer wake an idle teammate ([#61](https://github.com/prjct-app/pi-team/issues/61)) ([8e6baa5](https://github.com/prjct-app/pi-team/commit/8e6baa558452c3271f0f9f1b0777871abb763061))

## [0.9.0](https://github.com/prjct-app/pi-team/compare/v0.8.0...v0.9.0) (2026-09-28)

### Features

* roles stay bound to their Pi session; confirmed takeover and cleanup ([#58](https://github.com/prjct-app/pi-team/issues/58)) ([36e7622](https://github.com/prjct-app/pi-team/commit/36e7622e90d1d532d35b17ae51154a4af70cb12b))

## [0.8.0](https://github.com/prjct-app/pi-team/compare/v0.7.0...v0.8.0) (2026-09-26)

### Features

* /team panel lists every team and member, with a full timeline ([a6e3d3b](https://github.com/prjct-app/pi-team/commit/a6e3d3b88331509849f0e43e23e090b25615a009))
* confirm before leaving; the team admin removes members and deletes the team ([e2e5300](https://github.com/prjct-app/pi-team/commit/e2e5300fef4accb7b7b031aee6d49f4395592c76))
* IDs everywhere, renames, and a confirmation for every destructive action ([b53677b](https://github.com/prjct-app/pi-team/commit/b53677b5411a18fbb0680b2c641e2900791ea535))
* manual teams across terminals; messages never queue ([22dddf9](https://github.com/prjct-app/pi-team/commit/22dddf947b1089847bc30f2ecf811ee6c1f8b506))

### Bug Fixes

* mark the admin by shape, not emoji: diamonds for the admin, dots for members, squares for teams ([486ea49](https://github.com/prjct-app/pi-team/commit/486ea4990f32fc2d5236a32902e3489814f2e521))
* messaging a member from the panel is always findable (m or Enter) and says why when blocked ([b82ea90](https://github.com/prjct-app/pi-team/commit/b82ea9082b1744036524a84329b562b29e825627))
* say who the agent is with a persisted message, not the system prompt ([d492434](https://github.com/prjct-app/pi-team/commit/d49243447491acfcab6e7d13dcb6ca057738d2f3))
* the admin crown is the 👑 emoji, visible in any terminal font ([c0edc1f](https://github.com/prjct-app/pi-team/commit/c0edc1fe03a569e9b2d48bd5c5a47a6087720bf8))

## [0.7.0](https://github.com/prjct-app/pi-team/compare/v0.6.1...v0.7.0) (2026-09-22)

### Features

* /team completions with descriptions and the prjct mark ([afa687d](https://github.com/prjct-app/pi-team/commit/afa687d2edeba4776f6e200850b6114738914b88))
* /team is a docked panel of Runs and Experts with traceable assignments ([6f5b025](https://github.com/prjct-app/pi-team/commit/6f5b025a3ad49c8188322e3a98b1d8fca3f0c4df))
* add durable managed team state ([3380be1](https://github.com/prjct-app/pi-team/commit/3380be1cc4b106041a32c24ff1cfc119b7bc5d3d))
* add live team plan panel ([58635e2](https://github.com/prjct-app/pi-team/commit/58635e2db7f12fcee407932561c4a29e8d43b79d))
* add persistent dynamic team orchestration ([0a11bfc](https://github.com/prjct-app/pi-team/commit/0a11bfc25b2a3ca910dcfa01cfedf12dc9819ab5)), closes [#49](https://github.com/prjct-app/pi-team/issues/49)
* add persistent dynamic team orchestration ([57c8d03](https://github.com/prjct-app/pi-team/commit/57c8d0350b53bad0e963debbf79e5b39c28c1c4e))
* add Team v2 messaging runtime ([d0df88f](https://github.com/prjct-app/pi-team/commit/d0df88fbbfa57ffe4a7ad7373bd18d6591db7c54))
* add Team v2 storage core ([b75d230](https://github.com/prjct-app/pi-team/commit/b75d2306efc5670fd51668658bb536d3a19b4e41))
* add Team v2 supervised peer lifecycle ([3415872](https://github.com/prjct-app/pi-team/commit/3415872ab6a6bb6076736f1d2981f174a90551eb))
* Experts message each other directly (team_peers, team_message) ([298188f](https://github.com/prjct-app/pi-team/commit/298188f1037ff492955040088d262af165468638))
* integrate Team v2 extension ([81c64da](https://github.com/prjct-app/pi-team/commit/81c64da3c3b28ddb4c7e34bd811dda6d502a4922))
* isolate managed agents in worktrees ([35a68a3](https://github.com/prjct-app/pi-team/commit/35a68a3751e962ad260c07b54d70a21b45289b1b))
* keep an unattended teammate reachable after the auto-turn cap ([e354af4](https://github.com/prjct-app/pi-team/commit/e354af44dafc49171129ccf76f6213b10d35536e))
* launch autonomous teams from prompts ([6b72638](https://github.com/prjct-app/pi-team/commit/6b7263815dc6a0c4cca5b785211b1b5eb23a5b07))
* link team requests to optional subagents ([c51722f](https://github.com/prjct-app/pi-team/commit/c51722feac67405705ca3ddd69564bf6825a2bbc))
* run managed peers in persistent terminals ([4376b08](https://github.com/prjct-app/pi-team/commit/4376b08c331707263deb49af119c909ae85a75de))
* run persistent managed peer sessions ([6b2e249](https://github.com/prjct-app/pi-team/commit/6b2e249f82499d1a988e11c07a9d3fc54c1ee393))
* schedule managed work from dependencies ([18c5817](https://github.com/prjct-app/pi-team/commit/18c5817c890a08c212856fcf36ef4d87769b6cdb))
* send each Expert the project memory for its stance ([36caefc](https://github.com/prjct-app/pi-team/commit/36caefc442b7dcbfe5a00c26bbe97fb69f13b561))

### Bug Fixes

* a real parallel team — one Expert per role, own worktree each, orchestrator only coordinates ([140091d](https://github.com/prjct-app/pi-team/commit/140091d331ec75195a225f874847df601aa64dac))
* accept objectives through team command ([8f05337](https://github.com/prjct-app/pi-team/commit/8f05337c26a7f6cef7c4cafe7de2581c3c89d2ad))
* Experts launch again: short control socket, tmux 3.6 targets, lease token shape ([22c185b](https://github.com/prjct-app/pi-team/commit/22c185b49c91e0bedeb347795fca94df22477e1e))
* expose the authorized integration target ([f1bf132](https://github.com/prjct-app/pi-team/commit/f1bf13268985f92ff9866b9003a253908620deb0))
* harden managed runtime shutdown ([316cf72](https://github.com/prjct-app/pi-team/commit/316cf7218c7e6f27f11be4ef825a8447921cd97b))
* harden managed team records ([652e8d3](https://github.com/prjct-app/pi-team/commit/652e8d3cc4aef61280c8bbbadb6c1a16b3b65ae7))
* isolate managed peer extensions ([b69e02c](https://github.com/prjct-app/pi-team/commit/b69e02cf64b3c7ff41d039f95d36dc448a8a4a2a))
* keep worktree locks for the duration of git and refuse secret commits ([0d8c427](https://github.com/prjct-app/pi-team/commit/0d8c42783cc231b7464c79ec11c2373e8db74c05))
* only create and check the short socket fallback directory ([990f2a6](https://github.com/prjct-app/pi-team/commit/990f2a67650b5bc12542fd90ac0650675cbb8750))
* preserve lead checkout during managed work ([54e3159](https://github.com/prjct-app/pi-team/commit/54e3159368e36880305481c6fedf18edf9218c76))
* reject conflicting managed objectives ([5102c8b](https://github.com/prjct-app/pi-team/commit/5102c8b40bdc33f40eba4b18fad6d690b29b87b0))
* reject presence symlinks, redact more credentials, and bound the read cache ([c55bd27](https://github.com/prjct-app/pi-team/commit/c55bd27565441a86f711a4b8046cd7bbadeefa86))
* sanitize git and verification subprocess environments ([b4819bf](https://github.com/prjct-app/pi-team/commit/b4819bf37b5615e249cb2ca8b60557dd21dd913c))

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
