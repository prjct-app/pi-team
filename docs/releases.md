# Grouped releases

The repository separates integration from publication:

- `develop` is the integration branch. Feature, fix, performance, refactor, and documentation pull requests normally target it.
- `main` is the stable release branch. Only a grouped promotion pull request from the repository's `develop` branch may target it.

The **Check** workflow validates pull requests and pushes to both branches. The **Release** workflow publishes only after a push to `main`, so merging individual changes into `develop` never publishes a package.

## Build a release batch

1. Start each change from the latest `develop` branch.
2. Open its pull request against `develop` and complete the required checks and review.
3. Merge approved changes into `develop`. Keep using conventional commit messages so release notes and version selection remain accurate.
4. Leave the batch on `develop` until the user explicitly authorizes a grouped release.

Do not target `main` with an individual change. The release policy rejects a `main` pull request unless its head is the `develop` branch from this repository.

## Promote the batch

When the accumulated changes are ready:

1. Confirm `develop` is green and contains only changes intended for the release.
2. Open one pull request from `develop` to `main` summarizing the complete batch.
3. Use a **merge commit**, not squash or rebase merge. Preserving the commits lets semantic-release analyze every change since the previous tag.
4. Merge only with explicit user authorization. The resulting push to `main` starts one release workflow and therefore one grouped npm/GitHub release.

After publication, semantic-release writes the version and changelog commit to `main`. Before starting the next batch, bring that release commit back to `develop` through a `main` → `develop` synchronization pull request. This keeps package metadata and branch history aligned without publishing again.

## Version calculation

Semantic-release selects the highest required bump across the complete promoted batch:

- `fix:` and `perf:` request a patch version.
- `feat:` requests a minor version.
- A `BREAKING CHANGE:` footer or conventional `!` marker requests a major version.
- `docs:`, `refactor:`, `build:`, `ci(release):`, and `chore(deps):` request a patch version.
- Other changes, such as tests alone, do not request a version.

For example, a batch containing `fix:`, `docs:`, and `feat:` commits produces one minor release rather than three separate releases. Let the workflow manage versions instead of editing them by hand.

## Publication

After the grouped promotion reaches `main`, the workflow checks TypeScript, runs tests, and inspects the package contents. It then updates `package.json`, `package-lock.json`, and `CHANGELOG.md`, creates a `vX.Y.Z` tag, publishes to npm, and creates a GitHub release.

npm trusts `.github/workflows/release.yml` through GitHub Actions OIDC. The workflow uses short-lived credentials and is restricted to `main`. Release-tool dependencies are locked separately under `.github/release/` and are not installed with the extension.

Runs are serialized and a superseded checkout is skipped. Never cancel a run during publication. If publication fails, inspect the logs, npm version, and GitHub tag before retrying: publication is not a transaction across both services. Do not delete a published version or move an existing release tag to recover.

References: [semantic-release](https://semantic-release.gitbook.io/semantic-release/), [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).
