# Runtime And Layout

> Owner: WA2DC maintainers
> Last reviewed: 2026-05-13
> Scope: Runtime model, startup, and repository map.

## Runtime model

WA2DC bridges WhatsApp and Discord:

- WhatsApp side: Baileys (`@whiskeysockets/baileys`)
- Discord side: Discord bot (`discord.js`)
- State: local persistence in `storage/`
- Process supervision: watchdog runner in `src/runner.js`

Primary flow:

1. `src/runner.js` starts worker process and handles restart/backoff.
2. `src/index.js` bootstraps state/storage and starts platform handlers.
3. Discord/WhatsApp handlers mirror messages and control commands.

WhatsApp startup guardrails:

- `src/whatsappHandler.js` intentionally does not process WhatsApp history-sync payloads beyond push-name updates. The bridge only needs live/offline message delivery, and history payload processing can make Baileys allocate large decoded batches during reconnects after pairing.
- Do not eagerly call `groupFetchAllParticipating()` on WhatsApp reconnect or `/resync`. Group metadata is refreshed through live group events and `/resync` uses a lightweight `@g.us` participating-groups query that does not request every participant roster/description; full all-groups fetches can allocate very large Baileys response structures after pairing.
- Pass Baileys a bounded logger wrapper instead of the root pino logger. Baileys errors can include bundled `data:text/javascript;base64...` stack traces and binary payloads; keep those summarized so `logs.txt` and `terminal.log` stay useful and do not drive heap pressure.
- Keep WhatsApp startup memory probes around socket creation, WA connection, real initial buffer flushes, and LID session migration. These probes are intentionally small structured logs used to diagnose packaged OOM rollbacks.
- The Baileys rc11 postinstall patch skips startup event buffering when history sync is disabled, avoids buffer-and-immediate-flush on the disabled-history path, and bounds tctoken pruning so large auth stores do not trigger single huge heap allocations while the socket is coming online.

## Developer quick start

- Install deps: `npm ci`
- Run with watchdog: `npm start`
- Serve docs: `npm run docs`
- Bundle for Node smoke: `npm run bundle`
- Bundle for pkg: `npm run bundle:pkg`
- Build local binary: `npm run build:bin`
  packaged output includes the executable plus `build/runtime/` for runtime sidecar modules such as `sharp`, `canvas`, `jsdom`, and `lottie-web`
  release automation also publishes a signed `${binary}.runtime.tar.gz` archive so packaged self-update can replace the sidecar automatically
  packaged startup will also try to bootstrap `runtime/` from the matching signed release asset when the sidecar is missing or unusable

Smoke startup without external connections:

- `WA2DC_SMOKE_TEST=1 node src/index.js`

## Repository map

Core runtime (`src/`):

- `src/index.js`: app bootstrap and top-level lifecycle
- `src/runner.js`: watchdog, restart, and crash-loop handling
- `src/state.js`: in-memory state and default settings
- `src/storage.js`: persistence and first-run initialization
- `src/discordHandler.js`: Discord client + slash command handling
- `src/whatsappHandler.js`: Baileys event handling and bridge flow
- `src/utils.js`: shared helpers (formatting, updater, networking, migrations)
- `src/clientFactories.js`: injectable factories for tests
- `src/groupMetadataCache.js`: chat metadata cache
- `src/groupMetadataRefresh.js`: metadata refresh scheduling
- `src/messageStore.js`: TTL message cache for edits/polls/pins
- `src/pollUtils.js`: poll formatting/state helpers

Tests and CI:

- `tests/`: Node test runner coverage (`npm test`)
- `.github/workflows/ci-tests.yml`: CI test workflow
