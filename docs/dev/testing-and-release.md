# Testing and Release

> Owner: WA2DC maintainers
> Last reviewed: 2026-08-30
> Scope: Validation commands, documentation checks, CI, bundling, and packaged release constraints.

## Validation matrix

Preferred checks before handoff:

- `npm run docs:check` for commands, usage options, relative links, and historical setup assets
- `npm run check` for Biome lint/format validation of source, tests, and scripts
- `npm test` for the full Node test suite
- `npm run bundle` for runtime bundle compatibility
- `WA2DC_SMOKE_TEST=1 node src/index.js` for startup-sensitive changes
- `npm run build:bin:smoke` when packaging or runtime-sidecar behavior changes

The normal smoke mode skips external transports and exits itself, so it does not exercise signal handling. Process-lifecycle changes also require the focused shutdown tests, which inject stuck ingress, saves, reporters, and spawned/cluster workers to verify ordered persistence, validated supervisor IPC, source-aware duplicate coalescing, deliberate second-signal behavior, actual-child exit tracking, and watchdog `SIGKILL` escalation without using live credentials. Run source and packaged signal smoke with `WA2DC_SMOKE_TEST=1 WA2DC_SMOKE_WAIT_FOR_SIGNAL=1`, wait for the ready message, and send Ctrl-C; both watchdog and worker must exit. Crash-report queue tests verify bounded log-tail reads, private atomic writes, identical-content replacement safety, and failed-delivery recovery from claimed spool files.

The `CI` workflow runs for pull requests and pushes to `main` and `next`. It validates Conventional Commit pull-request titles, runs Biome and documentation checks, and runs tests, the ESM bundle smoke test, and packaged smoke tests on Ubuntu, macOS Intel, and Windows. Superseded runs for the same pull request are cancelled. Release builds use Node.js 24 and must remain at or above the supported 24.15.0 floor.

## Branch and version policy

- `next` is the integration and beta branch. Normal feature and dependency pull requests target `next` and use squash merge.
- `main` is the stable branch. Promote a tested `next` beta through a `next` to `main` pull request using a merge commit.
- Release Please uses `.release-please-manifest.json`, initialized at `2.4.0`, with the repository bootstrap commit `00e2c9fe55067e2b8e1c842b1a1da972999a0b63`.
- `next` seeds prerelease numbering at `beta.1` and produces only `vX.Y.Z-beta.N` prereleases. `main` uses the same prerelease-aware versioning strategy with prerelease output disabled, which removes the tested beta suffix instead of applying a second feature/breaking bump; it produces `vX.Y.Z` stable releases.
- Release Please PRs own `package.json`, `package-lock.json`, `CHANGELOG.md`, and the release manifest version. Stable release PRs also run `scripts/normalizeStableChangelog.js`, which folds user-facing entries from every matching beta section into both the stable changelog section and the release PR body while excluding `Miscellaneous` release/checkpoint entries. Release Please then uses that normalized PR body for the GitHub Release page. Do not hand-edit versions during an ordinary release.
- `feat` is minor; `fix`, `fix(deps)`, `perf`, and `revert` are patch; `!` or `BREAKING CHANGE` is major. Maintenance-only `docs`, `test`, `ci`, `build`, and `chore` commits do not independently release.

Promotion CI requires the published beta tag to resolve to `next` HEAD and requires its signed update-manifest assets. The gate waits up to 10 minutes for the fail-closed release pipeline to publish the beta, avoiding a race between the release and promotion workflows. The promotion pull-request body must contain an exact `Release-As: X.Y.Z` line matching the beta version without its suffix; GitHub must use the pull-request title and body as the merge-commit title and message so Release Please prepares that stable version. Together these checks prove there are no commits after the tested beta and make the stable transition deterministic. If `main` changed independently, synchronize it into `next` before publishing the final beta; a reconciliation after beta publication requires a new beta, forced with a `Release-As: X.Y.Z-beta.N` commit footer when it has no independently releasable changes. After stable publication, the GitHub App opens a `main` to `next` synchronization PR. If `next` is unexpectedly missing, the job recreates it at the exact stable release commit and exits successfully because no synchronization diff remains.

## Automated release pipeline

`Release` runs on pushes to `main` and `next`. A repository-scoped GitHub App token allows Release Please PRs to trigger normal required CI. When a release PR is merged, Release Please creates the tag and a draft release; the draft remains invisible until all subsequent work succeeds.

The pipeline then:

1. Resolves the tag to `main` or `next`, checks its channel/version, and rejects non-draft or unrelated manual recovery tags.
2. Re-runs Biome, documentation checks, tests, bundling, and startup smoke against the tag.
3. Builds and smoke-tests Linux x64, Linux ARM64, macOS Intel, and Windows x64 on native runners.
4. Collects the unsigned executable/runtime pairs in the protected `release-signing` environment. One job checks the exact asset set, writes deterministic SHA-256 files, signs every executable and runtime archive, and creates and signs `update-manifest.json`.
5. Produces binary provenance and container SBOM/provenance attestations, then uploads assets to the draft.
6. Publishes the GHCR image from the same tag as immutable `vX.Y.Z[-beta.N]` plus `unstable`, or `stable` and `latest`.
7. Removes draft status only after signing, upload, and container publication succeed.

A failed release remains a draft and cannot become the latest GitHub release. To retry an idempotent failed build, dispatch `Release` with the existing draft tag. Recovery revalidates the tag, package version, channel, branch ancestry, and draft/prerelease flags before rebuilding or replacing assets.

All third-party actions are pinned to full commit SHAs. Dependabot maintains their version comments and proposed updates, which remain review-required.

## Repository rollout and protection

Before enabling the workflow in GitHub:

1. Create a repository-scoped GitHub App with Contents, Pull requests, and Issues read/write access, install it only on this repository, set its Client ID as the `RELEASE_APP_CLIENT_ID` repository variable, and store its private key as the `RELEASE_APP_PRIVATE_KEY` repository secret.
2. Create the protected `release-signing` environment and store the existing RSA private key as its `SIGN_KEY` secret. Restrict environment deployment to `main` and `next`; require maintainer approval if the repository's threat model needs it.
3. Merge the automation to `main`, create `next` from that exact commit, and protect both branches. Require `CI` checks, one or more reviews, resolved conversations, and block ordinary direct pushes. Allow the installed release App only where automation needs it.
4. Enable squash merge for normal work into `next` and merge commits for the `next` to `main` promotion PR. Configure merge-commit titles from the pull-request title and merge-commit messages from the pull-request body so the validated stable `Release-As` footer reaches Release Please. Disable automatic head-branch deletion: `next` is the long-lived promotion head, and deleting it can retarget its open pull requests to `main` before the post-release job runs.
5. Publish and exercise `v2.5.0-beta.1`, including `/update` and rollback on each packaged target. Promote only after those checks pass.

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
- Runtime archives preserve only relative symbolic links that resolve inside `runtime/`; archive creation fails on absolute, escaping, or dangling links.
- Releases from `v2.5.0-beta.1` onward publish a signed schema-1 update manifest containing the release tag, commit, channel, exact sizes, SHA-256 hashes, and per-asset signature names for all four targets.
- Packaged startup may download and verify the matching sidecar when `runtime/` is missing or unusable.
- `/update` downloads the complete executable/runtime pair to a private staging directory and verifies the signed manifest, sizes, hashes, and per-asset RSA signatures before modifying the installation. Rollback treats both artifacts as one versioned unit.
- Cross-filesystem sidecar installation preserves relative symbolic-link targets instead of binding them to the temporary extraction directory.
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
