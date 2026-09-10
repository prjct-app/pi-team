# Changelog

## Unreleased

- Replace the team-wide `proper-lockfile` transaction with optimistic-concurrency records: lock-free reads, compare-and-swap revisions with bounded history, and transparent migration of pre-envelope mailboxes. Concurrent writers no longer block or fail each other.
- Move presence heartbeats to per-member files outside the shared record, removing the main source of write contention; teammates sweep claims held by disconnected peers.
- Report transient storage errors without pausing reception; only membership loss detaches.
- Add automatic review turns: emitted requests unresolved past five minutes ask the emitting agent every minute to chase the teammate in-thread or surface the blockage to the user. Reviews quiet down without mailbox progress and share the automatic turn budget.
- Deliver results together with the original request, and instruct agents to verify deliverables and reply in-thread with exactly what is missing.
- Add the `team_status` tool so agents can inspect unresolved emitted requests, queued work, pending results, and teammate presence.
- Drop the `proper-lockfile` runtime dependency; the package now ships with zero runtime dependencies.

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
