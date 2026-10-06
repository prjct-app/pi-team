# Package structure and compatibility

## Identity

- npm name: `@prjct.app/pi-team`
- Repository: [prjct-app/pi-team](https://github.com/prjct-app/pi-team)
- Tested host: Pi `0.85.1`; Node.js `22.19+`

The npm name and repository name may differ. The package rename changed no
runtime command names, event names, persisted entry types, or settings keys.

## Dependencies

Pi-provided libraries are declared in `peerDependencies` with `*`, as the Pi
package guide requires, and are not bundled. The exact Pi 1.0.4 devDependencies
establish the tested baseline; the peer wildcard is not a claim that every Pi
release is supported. This package has **no runtime dependencies**: storage is
self-contained.

Third-party runtime dependencies would belong in `dependencies`. A package that
directly imports another Pi package's resources must bundle it instead.

## Publishing

The `files` allowlist ships runtime resources, user documentation, and licence
files; tests, dependencies, and repository settings are excluded. Run
`npm run check:package` to inspect the exact prospective tarball, and confirm every
manifest entry and referenced local document is present. Only claim npm
availability after verifying a successful registry publication.

## Official references

Pinned to the tested version rather than the moving main branch:

- [Packages](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/packages.md) — manifest, sources, dependencies, deduplication
- [Extensions](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/extensions.md) — lifecycle, commands, tools, messages, UI
- [TUI](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/tui.md) — components, rendering, widths

The installed `@earendil-works/pi-coding-agent@1.0.4` ships the same guides under
`docs/`. The [current guide](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)
may describe changes beyond this tested baseline.
