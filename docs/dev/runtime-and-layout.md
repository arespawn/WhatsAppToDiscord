# Runtime and Layout

> Owner: WA2DC maintainers
> Last reviewed: 2026-08-29
> Scope: Process lifecycle, startup invariants, module ownership, and packaged runtime behavior.

## Process model

`src/loadRuntimeEnvironment.js` is imported before runtime modules inspect `process.env`. Source runs load `.env` from the working directory; packaged runs load it beside the executable. Existing environment values win, missing files are ignored, and other read failures stop startup.

Normal source and packaged startup uses the watchdog:

1. `src/runner.js` configures supervisor logging and starts the worker.
2. `src/index.js` initializes SQLite-backed app/auth state, handlers, autosave, and crash reporting.
3. `src/discordHandler.js` and `src/whatsappHandler.js` connect the transports and register bridge events.
4. The runner handles explicit restart flags, bounded crash restarts, exponential backoff, and packaged post-update rollback validation.

`SIGINT` and `SIGTERM` use a bounded graceful-shutdown path. The watchdog requests shutdown over a validated internal IPC message, including on Windows where forwarding these POSIX signal names to a child can terminate it abruptly. The worker first blocks reconnect work, independently quiesces the download server and WhatsApp ingress, and, once startup hydration is complete, saves local state. It then makes a time-limited report attempt while Discord remains available, destroys Discord, saves again, and closes SQLite last. Each stage is bounded so a stuck transport cannot prevent the final persistence stages. A matching OS-signal/IPC copy delivered to the worker is coalesced briefly; two direct OS signals still force an immediate exit. The watchdog waits for the real worker exit event after graceful shutdown and after `SIGKILL`, using a short final deadline only if the child exit event never arrives.

Queued crash-report delivery runs in the background after Discord startup so a slow Discord request cannot delay WhatsApp startup or QR generation. New fatal reports are atomically written directly to unique private `crash-report.pending-*.txt` spool files, so consecutive failures cannot overwrite one another or a legacy canonical `crash-report.txt`. Startup atomically claims any canonical report into the same spool. Success removes only the owned pending file, while failure leaves it for the next startup.

The official Docker entrypoint starts `src/index.js` directly and relies on the container restart policy rather than nesting the watchdog inside the container.

`WA2DC_LOG_LEVEL` configures the Pino threshold for watchdog and worker loggers. Accepted levels are `trace`, `debug`, `info`, `warn`, `error`, `fatal`, and `silent`; the default is `info`. Structured entries go to `logs.txt`, while watchdog-captured stdout/stderr also goes to `terminal.log`. Raw dependency/process output can bypass structured filtering, and debug logs can contain WhatsApp JIDs or Discord IDs.

## WhatsApp startup invariants

- Do not process history-sync batches beyond required push-name updates. WA2DC needs live/offline delivery, not decoded reconnect history.
- Do not call `groupFetchAllParticipating()` during reconnect or `/resync`. Use live group events and the lightweight participating-group query.
- Keep the bounded Baileys logger wrapper. Baileys errors can contain bundled data URLs, stack payloads, or binary structures that must be summarized.
- Preserve memory probes around socket creation, connection, genuine initial-buffer flushes, and LID migration. They diagnose packaged startup rollback/OOM failures.
- Fresh sessions default to the Android browser profile for view-once behavior. Pairing-code flows may temporarily select a Chrome profile; changing the profile of a registered session can require clearing WhatsApp auth and pairing again.
- Prefer `fetchLatestWaWebVersion()` for fresh pairing, falling back to `fetchLatestBaileysVersion()` only when the live lookup fails.
- Keep the pinned-Baileys postinstall patch synchronized with its tests. It covers the Android profile, disabled-history buffering, delivered receipts while unavailable, pre-auth/incomplete pairing notifications, LID migration probes, and bounded tctoken pruning.

## Module ownership

Runtime and configuration:

- `src/runner.js` / `src/runnerLogic.js`: supervision, restart/backoff, restart flags, and automatic packaged rollback
- `src/index.js`: worker bootstrap, autosave, crash reports, and platform lifecycle
- `src/runtimeEnvironment.js`: `.env` path and loading semantics
- `src/contracts.js`: settings defaults/normalization, one-way modes, browser-profile values, Discord permissions, and newsletter timing constants
- `src/state.js`: mutable in-memory runtime state

Persistence and routing:

- `src/storage.js` and `src/persistence/sqliteStore.js`: app state, auth state, SQLite permissions, encryption, and transactions
- `src/auth/sqliteAuthState.js`: Baileys auth key/credential adapter
- `src/messageStore.js`: bounded TTL message cache stored in SQLite
- `src/chatLinks.js`: channel/thread link normalization and host/target resolution
- `src/newsletterBridge.js`: outbound/server ID correlation, ack tracking, and bounded newsletter diagnostics

Transports and normalization:

- `src/discordHandler.js`: Discord client, slash commands, channel/thread routing, and Discord-side events
- `src/whatsappHandler.js`: Baileys socket, WhatsApp-side events, pairing profiles, and bridge dispatch
- `src/clientFactories.js`: Discord/Baileys client construction, version selection, and injectable test overrides
- `src/whatsappResync.js`: lightweight contact/participating-group refresh
- `src/groupMetadataCache.js` / `src/groupMetadataRefresh.js`: bounded metadata caching and scheduled refresh
- `src/pollUtils.js`: WhatsApp poll option and encryption-key extraction
- `src/internal/`: sticker, image, GIF, and audio send/receive normalization
- `src/utils.js`: transport helpers, mentions, link previews, download server, updater, file delivery, and JID migration helpers
- `src/processErrors.js` / `src/processExitReporting.js` / `src/shutdown.js`: tightly identified Undici transport failures remain non-fatal across both process error events; other failures retain bounded exit/crash reporting, cleanup, and watchdog escalation

## Developer commands

- Install: `npm ci`
- Run watchdog: `npm start`
- Serve docs: `npm run docs`
- Check docs: `npm run docs:check`
- Static checks: `npm run check`
- Tests: `npm test`
- ESM bundle: `npm run bundle`
- pkg-safe bundle: `npm run bundle:pkg`
- Local packaged build: `npm run build:bin`
- Packaged build and smoke: `npm run build:bin:smoke`
- Worker smoke: `WA2DC_SMOKE_TEST=1 node src/index.js`
- Signal smoke: `WA2DC_SMOKE_TEST=1 WA2DC_SMOKE_WAIT_FOR_SIGNAL=1 node src/runner.js`, then send `SIGINT`

## Packaged runtime model

`npm run build:bin` creates an executable plus `build/runtime/`. The runtime sidecar contains modules that cannot be relied on inside the pkg bundle, including `sharp`, `canvas`, `jsdom`, and `lottie-web`.

Release automation publishes a matching signed `${binary}.runtime.tar.gz` archive. Packaged startup can bootstrap a missing/unusable `runtime/`, `/update` replaces the executable and sidecar together, and rollback restores both matching backups. Do not describe moving a packaged executable without its runtime sidecar as fully supported.
