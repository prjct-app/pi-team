# Package structure and compatibility

## Identity

- npm name: `@prjct.app/pi-team`.
- Initial version: `0.1.0`.
- Source repository: [prjct-app/pi-team](https://github.com/prjct-app/pi-team).
- Tested host: Pi `0.85.1`; Node.js `22.19+`.

The npm name and repository name may differ. Repository URLs remain unchanged. Existing runtime command names, event names, persisted entry types, and settings keys are unchanged by the package rename.

## Resource manifest

```json
{
  "name": "@prjct.app/pi-team",
  "keywords": [
    "pi-package"
  ],
  "pi": {
    "extensions": [
      "./index.ts"
    ]
  }
}
```

The `pi-package` keyword makes the package discoverable. Manifest paths are relative to the package root. The extension entry point is shipped as TypeScript because Pi loads it directly. There is no CLI binary or JavaScript build artifact to install separately.

## Dependencies

Pi-provided libraries imported by this package are declared in `peerDependencies` with `*`, as required by Pi's package guide. They are not bundled. Exact Pi 0.85.1 development dependencies establish the tested baseline; the peer wildcard is not a claim that every Pi release is supported.

Third-party runtime dependencies belong in `dependencies`. Companion extensions are installed separately only when communication uses Pi's event bus; this package does not import code from a separately installed companion. A package that directly imports another Pi package's resources must instead bundle it following the official guide.

## Public interfaces

Uses public commands, tools, lifecycle events, custom messages, and persisted session entries. `proper-lockfile` is a runtime dependency; Pi libraries remain peer dependencies.

## Published contents

The `files` allowlist includes runtime resources, user documentation, and license files. Development tests, dependency folders, repository settings, and Git history are excluded. npm also includes `package.json` automatically. The npm lockfile remains in the repository for repeatable development installs.

Run `npm run check:package` to inspect the exact prospective tarball before release. Check that each manifest entry and each referenced local document exists in the packed file list. Only claim npm availability after verifying a successful registry publication.

## Official references

These links are pinned to the tested Pi version rather than the moving main branch:

- [Packages: manifest, sources, dependencies, filtering, and deduplication](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/packages.md).
- [Extensions: lifecycle, commands, tools, messages, and UI APIs](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/extensions.md).
- [TUI: components, rendering, terminal widths, and image support](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/tui.md).

The installed `@earendil-works/pi-coding-agent@0.85.1` package ships the same guides under `docs/`. The [current official guide](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md) may describe changes beyond this tested baseline.
