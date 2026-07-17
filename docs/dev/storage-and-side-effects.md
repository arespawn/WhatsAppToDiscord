# Storage And Side Effects

> Owner: WA2DC maintainers
> Last reviewed: 2026-02-12
> Scope: On-disk contracts, runtime artifacts, and file-permission constraints.

## Persistence contract

Persisted app/auth state lives under `storage/wa2dc.sqlite` (embedded SQLite).
Legacy flat-file storage is no longer migrated at startup; installs must already have `storage/wa2dc.sqlite`.

Settings defaults and validation live in `src/contracts.js`, while persisted values are loaded by `src/storage.js`.
Optional encryption-at-rest is enabled by `WA2DC_DB_PASSPHRASE`; passphrase handling is implemented in `src/persistence/sqliteStore.js`.

Chat-link records in persisted `chats` state now store the webhook host `channelId` plus an optional `threadId` for thread-mode links.
Channel-only string records are unsupported and ignored.
Thread-mode settings such as `DefaultChatType`, `DefaultThreadHostName`, `ThreadNotificationsEnabled`, `ThreadNotificationRoles`, and `ThreadNotificationUsers` are regular persisted settings.

## Runtime artifacts

The app creates/uses these files in the working directory:

- `.env`: optional startup configuration for source runs; packaged binaries instead look beside the executable
- `storage/`: persistent bridge/auth state
- `downloads/`: optional local media download destination
- `logs.txt`: structured logs (pino)
- `terminal.log`: worker stdout/stderr tee from runner
- `crash-report.txt`: queued crash report when control channel is unavailable
- `restart.flag`: restart-now signal consumed by `src/runner.js`

If behavior around these files changes, document it here and in user-facing docs when applicable.

## File permission policy

`src/storage.js` enforces restrictive permissions and this must remain true:

- Directories: `0700`
- Files: `0600`

Never loosen these defaults.

WA2DC does not create or change permissions on `.env`. Operators should restrict it to the runtime account (for example, `chmod 600 .env` on Unix-like systems), because it can contain the Discord token and database passphrase.

Docker note: the official image entrypoint may normalize ownership of mounted `storage/` to `node:node` before startup, then run the app as `node`. This is a container-start side effect and is intended to preserve write access after upgrades from older root-running images.

## Secret hygiene

Never commit or expose:

- `.env` secrets
- Discord tokens
- WhatsApp auth/session blobs
- persisted storage payloads containing private message data
