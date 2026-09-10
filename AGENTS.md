# Agent instructions

Read [CONTRIBUTING.md](CONTRIBUTING.md) first; it carries the workflow, review,
and authorization rules. Read [docs/architecture.md](docs/architecture.md) before
changing storage, presence, or the polling loop.

Two constraints that the code alone will not tell you:

- **No `let` in `src/`.** Session state is one immutable record updated through
  `set(session => ...)`. Read it with `get()` at the point of use — never
  destructure it into locals across an `await`, because several paths
  deliberately re-read after I/O to catch a user prompt that landed mid-
  transaction. `npm run check` enforces the absence of `let`; it cannot enforce
  the reading discipline, so reviewers must.
- **Injected context is a budget.** Anything in a `sendMessage` content, a tool
  result, or the `before_agent_start` system prompt is paid on every later turn
  and stays in the branch; `appendEntry` is TUI-only and free. Keep injected
  values bounded, state elisions, and never carry the same text twice.

Use English for code, documentation, tests, issues, and pull requests. Follow the
installed Pi 0.85.1 docs and use only documented public interfaces: do not import
internal `dist/` modules, patch prototypes, or depend on undocumented behavior.

Keep tests offline and isolated from real Pi configuration, sessions, credentials,
and model providers. Never push, open or merge a pull request, publish, or deploy
without explicit user authorization.
