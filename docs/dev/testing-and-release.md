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

Release pipeline builds packaged binaries from a pkg-safe CJS runtime bundle:

- esbuild bundles `src/runner.js` to `out.js` (ESM) for Node smoke checks
- esbuild also bundles `src/runner.js` directly to `out.cjs` (CJS) for pkg; avoid base64 `data:` URL bootstraps because they inflate packaged stack/source strings and startup heap
- pinned `@yao-pkg/pkg` produces platform binaries from `out.cjs` with `--no-bytecode`
- packaged builds also stage `build/runtime/` as a sidecar for runtime-only media dependencies (`sharp`, `canvas`, `jsdom`, `lottie-web`) so native image normalization and Discord sticker rendering remain available in packaged runtimes
- release builds publish a signed `${binary}.runtime.tar.gz` archive for each packaged binary so `/update` can refresh the sidecar automatically
- packaged startup may download that signed runtime archive on demand when a packaged install is missing `runtime/`
- runtime may branch on `process.pkg` for packaged-vs-source behavior
- WhatsApp socket startup prefers `fetchLatestWaWebVersion()` so fresh pairing uses WhatsApp's current web client revision, then falls back to `fetchLatestBaileysVersion()` when the live lookup is unavailable (see [Baileys issue #2679](https://github.com/WhiskeySockets/Baileys/issues/2679))
- `postinstall` patches Baileys rc13 for the Android browser profile, disabled-history startup buffering, inbound delivered receipts while unavailable, pre-auth notification ACKs during pairing, incomplete link-code pairing notifications, LID migration probes, and bounded tctoken pruning; release builds must run after that patch has been applied
- WhatsApp may send an empty `link_code_companion_reg` notice before the complete pairing payload; the patch checks all three required cryptographic fields before decoding, ACKs and skips incomplete notices, and logs only missing field names, stage, and child tags (see [Baileys issue #2600](https://github.com/WhiskeySockets/Baileys/issues/2600))

## Packaging-safe dependency rules

When adding/changing dependencies, verify:

- esbuild can bundle the runtime entry successfully
- ESM-only dependencies and packages that use top-level `await` must be verified against the pkg CJS bundle path
- pkg can resolve/load any runtime assets
- dynamic fs/native addon behavior is explicitly handled when required
- packaged releases keep the executable and `runtime/` sidecar together; moving the binary without its sidecar can disable native modules such as `sharp` or the Discord sticker renderer stack
- packaged self-update must refresh both the executable and the matching signed runtime sidecar archive, and rollback paths must restore both artifacts together

Generated artifacts (`out.js`, `out.cjs`, `build/`) should not be manually edited.
