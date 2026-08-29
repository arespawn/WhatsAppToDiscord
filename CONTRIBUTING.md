# Contributing to WA2DC

Development flows through `next`; `main` contains the latest stable line. Open normal feature, fix, and dependency pull requests against `next`. Use squash merge so the pull-request title becomes the commit Release Please evaluates.

## Pull-request titles

Titles must follow Conventional Commits:

- `feat: ...` produces a minor release.
- `fix: ...`, `fix(deps): ...`, `perf: ...`, and `revert: ...` produce a patch release.
- Add `!`, as in `feat!: ...`, or a `BREAKING CHANGE` footer for a major release.
- `docs`, `test`, `ci`, `build`, and `chore` changes do not create a release by themselves.

Dependabot pull requests remain human-reviewed. Their accepted npm updates use `fix(deps)` and therefore participate in patch releases.

## Release lifecycle

1. Merge reviewed work into `next` with squash merge.
2. Release Please maintains a beta release PR on `next`, including the version and `CHANGELOG.md`.
3. Merging that PR starts the fail-closed native build, signing, container, and draft-release pipeline. A successful run publishes `vX.Y.Z-beta.N` and moves the `unstable` container tag.
4. Test the published beta. When it is ready, open a `next` to `main` pull request with a `chore: promote ...` title and an exact `Release-As: X.Y.Z` line in its body, then merge it with a merge commit. Promotion CI requires the footer, requires `next` HEAD to be the published beta tag, and waits for its signed update-manifest assets, so an unpublished beta or additional unreleased changes cannot be promoted accidentally.
5. Release Please maintains the stable release PR on `main`. Merging it publishes `vX.Y.Z`, `stable`, and `latest` only after all release jobs succeed.
6. The release GitHub App opens a `main` to `next` synchronization PR. Merge it before starting the next beta cycle.

Configure GitHub's default merge-commit title and message as the pull-request title and body so Release Please receives the required `Release-As` footer. Do not squash the `next` to `main` promotion PR: its constituent commits are the stable changelog input. Beta is the only prerelease phase; do not create automated alpha or release-candidate tags.

## Local validation

Use Node.js 24.15.0–24.x or 26.0.0 and newer, then run:

```bash
npm ci
npm run check
npm run docs:check
npm test
npm run bundle
WA2DC_SMOKE_TEST=1 node src/index.js
```

Run `npm run build:bin:smoke` for packaging, updater, runtime-sidecar, or dependency changes. The complete release and platform matrix is documented in [Testing and Release](docs/dev/testing-and-release.md).
