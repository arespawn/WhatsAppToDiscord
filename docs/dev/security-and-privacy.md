# Security and Privacy

> Owner: WA2DC maintainers
> Last reviewed: 2026-08-29
> Scope: Secret handling, logging, network access, local file serving, updates, and authorization boundaries.

WA2DC processes Discord tokens, WhatsApp authentication material, contact identifiers, mirrored content, attachments, message mappings, logs, and operator configuration.

## Secrets and persisted data

- Never log or expose Discord tokens, QR/pairing codes, passphrases, raw credentials, Signal keys, auth blobs, or unredacted pairing nodes.
- Tests and issue reports must use synthetic data and isolated temporary SQLite storage.
- Preserve `0700` storage/download directory and `0600` database/download file enforcement where implemented.
- Treat logs, SQLite sidecars, crash reports, restart flags, `.env`, runtime sidecars, backups, and rollback files as sensitive even when code does not enforce their mode.
- Encryption at rest covers encoded SQLite payload values, not live memory, network traffic, metadata required to open the store, or unrelated runtime artifacts.

## Logging and failure reporting

- Bound error serialization, nested causes, Baileys payloads, data URLs, and memory diagnostics.
- Review success, retry, fallback, shutdown, and crash paths for identifier/content leakage.
- Crash reports should contain actionable bounded errors and logs, never entire runtime state.
- Debug logging may include JIDs and Discord IDs; public docs must warn operators before requesting logs.

## Network boundaries

- Link-preview fetching must continue to block loopback, private, link-local, and unsafe redirect targets and enforce size/time limits for pages and thumbnails.
- `link-preview-js` is only used to parse response content that WA2DC has already fetched; do not delegate network fetching to it or bypass WA2DC's URL, DNS/IP, redirect, timeout, and size checks.
- Signed packaged updates from `v2.5.0-beta.1` onward must verify the release manifest signature before parsing it, then validate the exact tag, channel, platform mapping, safe filenames, sizes, SHA-256 hashes, and per-asset signatures. Releases older than `2.5.0` use only the fixed legacy filename/signature contract.
- Download the complete executable/runtime pair into a private staging directory before moving either installed artifact. Reject non-2xx responses, malformed or incomplete manifests, unsafe names, mismatches, and missing/bad signatures without touching the installation; restore matching backups on any later install failure.
- The local download server defaults to loopback. Binding publicly requires explicit operator configuration; path-safe signed URLs do not replace authentication, firewalling, TLS, expiry, or reverse-proxy controls.
- Do not introduce new outbound services, analytics, or telemetry without explicit documentation and operator control.

## Authorization

WA2DC intentionally uses Discord's guild, channel, role, and application-command permissions. Keep the control channel private and do not imply per-user authorization exists in WA2DC.

Command changes must consider whether they reveal stored data, change routing, delete remote resources, expose files, restart the process, or update binaries. Destructive operations require explicit options/confirmation and clear user-facing scope.

## Public statements

Do not claim that self-hosting means data never leaves the host. Mirroring transmits data through WhatsApp and Discord, link previews contact destination hosts, and update checks contact GitHub. Keep `docs/privacypolicy.txt`, public configuration, and this page aligned with actual code.

## Release credentials

The Release workflow uses separate trust boundaries:

- The repository-scoped GitHub App may write Contents, Pull requests, and Issues so Release Please and synchronization PRs can trigger normal CI. Its ID/private key must remain repository variables/secrets and the App must not be installed organization-wide without a separate review.
- `SIGN_KEY` belongs only in the restricted `release-signing` environment. Native build jobs upload unsigned artifacts and never receive it. One signing job validates the full expected asset set before using the key.
- GitHub's per-run token receives only each job's declared permissions. Third-party actions remain pinned to immutable commits.

Rotate either credential immediately if exposed. Rotating `SIGN_KEY` also requires shipping the matching public key through a reviewed compatibility plan; replacing only the private key makes all new in-app updates unverifiable.
