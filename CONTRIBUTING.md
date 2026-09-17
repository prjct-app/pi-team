# Contributing

- Stable release branch: `main`. Integration branch: `develop`.
- Create feature branches from `develop` and target `develop` in normal pull requests.
- Only grouped promotion pull requests from `develop` may target `main`; use a merge commit so semantic-release can analyze every included conventional commit.
- Deliver changes through a pull request using `.github/pull_request_template.md`.
- Use English for code, documentation, tests, issues, and pull requests.
- Use strict TypeScript and only APIs documented by Pi 0.85.1.
- Use immutable values: `npm run check` fails on any `let` under `src/`.
- Do not import host internals, monkey-patch prototypes, or access real credentials, sessions, or user configuration in tests.
- Keep runtime dependencies in `dependencies`; list Pi-provided packages in `peerDependencies` with a `*` range.
- Run `npm run check`, `npm test`, and `npm pack --dry-run` before review.
- Build the compiled local copy Pi loads with `npm run build:pi`. It writes `~/.pi/agent/builds/<package>` outside the repository, because compiled code inside it would load the repository's development copy of Pi instead of the host's.
- Never push, open or merge a pull request, publish, or deploy without explicit authorization.

## Package documentation

Follow [docs/package.md](docs/package.md) and its versioned official references. Keep README examples consistent with registered commands, distinguish tested behavior from unverified compatibility, and verify `npm run check:package` before release. Design detail belongs in [docs/architecture.md](docs/architecture.md), not the README.

## Releases

Accumulate reviewed changes on `develop`. When the batch is ready, promote `develop` to `main` through one authorized pull request; that single merge automatically publishes one grouped release to npm. Use conventional commit messages and read [Grouped releases](docs/releases.md) before promotion. The workflow manages versions and authenticates with npm through OIDC.
