# Agent instructions

Read `CONTRIBUTING.md` before making changes. Work on a feature branch based on `main` and deliver changes through a pull request using `.github/pull_request_template.md`.

Use English for code, documentation, tests, issues, and pull requests. Follow the installed Pi 0.85.1 documentation in `docs/extensions.md`, `docs/packages.md`, and `docs/tui.md`. Use only documented public Pi extension and TUI interfaces: do not import internal `dist/` modules, patch prototypes, or depend on undocumented host behavior.

Keep tests offline and isolated from the real Pi configuration, sessions, credentials, and model providers. Never push, open or merge a pull request, publish, or deploy without explicit user authorization.
