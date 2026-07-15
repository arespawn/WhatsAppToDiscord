# Runtime And Layout

> Owner: WA2DC maintainers
> Last reviewed: 2026-03-19
> Scope: Runtime model, startup, and repository map.

## Runtime model

WA2DC bridges WhatsApp and Discord:

- WhatsApp side: Baileys (`@whiskeysockets/baileys`)
- Discord side: Discord bot (`discord.js`)
- State: local persistence in `storage/`
- Process supervision: watchdog runner in `src/runner.js`
- Runtime logging: `WA2DC_LOG_LEVEL` sets the Pino threshold for both the watchdog and worker loggers. Supported values are `trace`, `debug`, `info`, `warn`, `error`, `fatal`, and `silent`; the default is `info`, and invalid values prevent startup. It controls structured `logs.txt` entries and pretty Pino console output, while raw process warnings or dependency `console` output can still reach `terminal.log`. Debug logs can contain operational identifiers such as WhatsApp JIDs and Discord channel/message IDs, so treat diagnostic logs as sensitive.

Primary flow:

1. `src/runner.js` starts worker process and handles restart/backoff.
2. `src/index.js` bootstraps state/storage and starts platform handlers.
3. Discord/WhatsApp handlers mirror messages and control commands.

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
