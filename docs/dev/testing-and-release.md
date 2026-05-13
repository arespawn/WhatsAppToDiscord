# Testing And Release

> Owner: WA2DC maintainers
> Last reviewed: 2026-05-13
> Scope: Validation commands, CI expectations, and packaging constraints.

## Validation matrix

Preferred checks before handoff:

- `npm run lint` (Biome)
- `npm test`
- `WA2DC_SMOKE_TEST=1 node src/index.js` for startup-sensitive changes

CI executes the following on `ubuntu-latest`, `macos-latest`, and `windows-latest`:

- `npm test`
- `npm run bundle`
- bundled smoke boot from `out.js` (`WA2DC_SMOKE_TEST=1`)
- packaged binary build + smoke (`npm run build:bin:smoke`)

## Packaging model

Release pipeline builds packaged binaries from an ESM runtime bundle plus a pkg-safe CJS bootstrap:

- esbuild bundles `src/runner.js` to `out.js` (ESM) for Node smoke checks
- esbuild also bundles `src/runner.js` to `out.js` (ESM) for pkg, then writes `out.cjs` as a tiny bootstrap that loads `out.js` from pkg's virtual filesystem and dynamically imports it
- pinned `@yao-pkg/pkg` produces platform binaries from `out.cjs` with `--no-bytecode`
- packaged builds also stage `build/runtime/` as a sidecar for runtime-only media dependencies (`sharp`, `canvas`, `jsdom`, `lottie-web`) so native image normalization and Discord sticker rendering remain available in packaged runtimes
- release builds publish a signed `${binary}.runtime.tar.gz` archive for each packaged binary so `/update` can refresh the sidecar automatically
- packaged startup may download that signed runtime archive on demand when a packaged install is missing `runtime/`
- runtime may branch on `process.pkg` for packaged-vs-source behavior
- `postinstall` patches Baileys rc11 for the Android browser profile and for reconnect initial-sync buffering; release builds must run after that patch has been applied

## Packaging-safe dependency rules

When adding/changing dependencies, verify:

- esbuild can bundle the runtime entry successfully
- ESM-only dependencies, including packages that use top-level `await`, stay on the ESM side of the pkg boundary (`out.js`) instead of being forced into a bundled CJS entry
- pkg can resolve/load any runtime assets
- dynamic fs/native addon behavior is explicitly handled when required
- packaged releases keep the executable and `runtime/` sidecar together; moving the binary without its sidecar can disable native modules such as `sharp` or the Discord sticker renderer stack
- packaged self-update must refresh both the executable and the matching signed runtime sidecar archive, and rollback paths must restore both artifacts together

Generated artifacts (`out.js`, `out.cjs`, `build/`) should not be manually edited.
