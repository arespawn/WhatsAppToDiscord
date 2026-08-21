# Testing and Release

> Owner: WA2DC maintainers
> Last reviewed: 2026-08-05
> Scope: Validation commands, documentation checks, CI, bundling, and packaged release constraints.

## Validation matrix

Preferred checks before handoff:

- `npm run docs:check` for commands, usage options, relative links, and historical setup assets
- `npm run check` for Biome lint/format validation of source, tests, and scripts
- `npm test` for the full Node test suite
- `npm run bundle` for runtime bundle compatibility
- `WA2DC_SMOKE_TEST=1 node src/index.js` for startup-sensitive changes
- `npm run build:bin:smoke` when packaging or runtime-sidecar behavior changes

The `ci-tests` workflow runs tests, the ESM bundle, bundled watchdog smoke, and packaged binary smoke on current Ubuntu, macOS, and Windows runners with the latest Node.js 24 release, which must remain at or above the supported 24.15.0 floor. The separate lint workflow runs `npm run ci:check`, using Biome's CI mode to enforce lint rules, formatting, and assist actions such as import organization.

## Documentation checks

`tests/docs.test.js` imports the named `slashCommands` registration metadata and verifies that:

- every registered command appears exactly once in `docs/commands.md`
- every section has one normalized usage line
- documented option names/order match registration
- relative Markdown links and image targets resolve
- all historical setup JPGs remain embedded

Keep these checks dependency-free and network-free. External links are verified manually against authoritative sources to avoid flaky CI.

## Packaging model

- `npm run bundle` bundles `src/runner.js` to ESM `out.js` for Node smoke checks.
- `npm run bundle:pkg` bundles the same entry to pkg-safe CJS `out.cjs`; avoid base64 data-URL bootstraps that inflate packaged stacks and startup heap.
- `@yao-pkg/pkg` is pinned by the build scripts/workflow and packages `out.cjs` with `--no-bytecode`.
- Builds stage `build/runtime/` for `sharp`, `canvas`, `jsdom`, and `lottie-web`.
- Release automation publishes a signed `${binary}.runtime.tar.gz` for every packaged binary.
- Packaged startup may download and verify the matching sidecar when `runtime/` is missing or unusable.
- `/update` and rollback must treat the executable and runtime sidecar as one versioned unit.
- `process.pkg` is the supported packaged/source runtime distinction.

## Baileys compatibility

The repository currently pins Baileys `7.0.0-rc14` and patches it during `postinstall`. Release builds must run after the patch succeeds. Tests must cover each source replacement marker so an upstream package change fails installation visibly rather than producing a partially patched runtime.

The current patch set covers:

- Android browser-profile support
- disabled-history startup buffering and receipt behavior while unavailable
- pre-auth notification acknowledgements and incomplete link-code pairing notices
- LID migration probes
- bounded tctoken indexing/pruning

Fresh pairing prefers `fetchLatestWaWebVersion()` and falls back to `fetchLatestBaileysVersion()`. Keep the associated pairing regression tests and upstream issue references current when the pinned Baileys version changes.

## Dependency and artifact rules

When changing dependencies, verify ESM bundle, pkg CJS bundle, native/dynamic assets, and sidecar install/update/rollback paths. Packages with top-level `await`, runtime filesystem lookup, or native addons require explicit packaged verification.

Generated `out.js`, `out.cjs`, and `build/` artifacts must not be edited or committed manually.
