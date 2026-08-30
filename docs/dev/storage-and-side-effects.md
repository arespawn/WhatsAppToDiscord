# Storage and Side Effects

> Owner: WA2DC maintainers
> Last reviewed: 2026-08-30
> Scope: SQLite contracts, runtime artifacts, lifetimes, and explicit filesystem-permission enforcement.

## SQLite persistence contract

Persistent app and WhatsApp authentication state lives in `storage/wa2dc.sqlite`, opened through Node's embedded SQLite API in WAL mode. Legacy flat-file storage is not loaded or migrated, and files such as `storage/settings` or `storage/contacts` do not exist in the current contract.

Table responsibilities:

- `meta`: storage/encryption metadata
- `app_state`: JSON/text values for settings, chat links, contact names, recent message mappings, and last timestamp
- `auth_creds`: the single serialized Baileys credential record
- `auth_keys`: serialized Baileys Signal/auth namespaces keyed by logical filename
- `message_store`: TTL-cached message payloads used by edits, polls, pins, newsletter flows, and related lookups

`src/contracts.js` owns settings defaults and normalization. `src/chatLinks.js` accepts object records with webhook `channelId` and optional `threadId`; unsupported legacy channel-string records are ignored. `src/messageStore.js` bounds cached entries and prunes expired/old records.

Recent WhatsApp↔Discord message mappings remain JSON-compatible but are managed by a unique-key bounded map. Refreshing an existing pair must not consume additional capacity or evict unrelated mappings. Saves are serialized, include privacy-safe cardinality diagnostics, and recover from the previous in-memory snapshot instead of persisting an unexplained drop of more than half of a non-trivial mapping set.

SQLite may create `wa2dc.sqlite-wal` and `wa2dc.sqlite-shm` while running. Stop WA2DC before filesystem-level backup so the copied database is consistent; copy the complete `storage/` directory rather than selecting individual files.

On `SIGINT` or `SIGTERM`, WA2DC blocks reconnect work, independently quiesces download and WhatsApp ingress, and saves current app state before attempting its bounded Discord shutdown report. It then destroys Discord, saves once more, and closes SQLite last. Every stage has a deadline, so a stuck transport cannot prevent the final save/close attempt; operators should continue to stop WA2DC normally before copying storage.

## Encryption behavior

`WA2DC_DB_PASSPHRASE` enables encryption of stored payload values when present at first database creation. The metadata needed to identify/derive the encrypted format remains readable. Setting a passphrase for an existing unencrypted database is ignored rather than silently converting it.

An encrypted database fails startup when the passphrase is missing or wrong. There is no recovery path without the original passphrase and a valid database backup.

## Runtime artifacts

Working-directory artifacts:

- `.env`: optional source configuration; packaged binaries instead load it beside the executable
- `storage/`: SQLite database and transient SQLite sidecars
- `downloads/`: optional large-media destination and pruning target
- `logs.txt`: structured Pino logs from worker and/or watchdog
- `terminal.log`: watchdog tee of worker stdout/stderr; absent when no watchdog is used
- `crash-report.txt`: legacy/interrupted fallback report atomically claimed into the pending spool at startup without being replaced by a newer fatal report
- `crash-report.pending-*.txt`: private, uniquely written or atomically claimed crash reports; consecutive failures remain separate, successful delivery removes only its owned spool file, and failed delivery retains it for startup recovery
- `restart.flag`: JSON restart request consumed and removed by `src/runner.js`

Packaged-install artifacts beside the executable:

- `runtime/`: native/dynamic media sidecar
- `${executable}.oldVersion`: previous executable retained for rollback
- `runtime.oldVersion/`: matching sidecar backup retained for rollback

Update archives and extraction directories are created under the operating-system temporary directory and cleaned on success/failure paths.
WhatsApp attachments bound for Discord are also staged under the operating-system temporary directory before upload. Each upload batch gets a private directory; files remain only through Discord retries and are removed on success, fallback, failure, or graceful shutdown.
Runtime sidecar archives contain only relative symbolic links that resolve inside `runtime/`; cross-filesystem installation preserves those links when moving the extracted sidecar beside the executable.

Changing the location, lifecycle, format, or meaning of any artifact requires updates here and in public configuration/troubleshooting docs.

## Explicit permission enforcement

On non-Windows platforms, code explicitly enforces:

- `storage/`: `0700`
- `storage/wa2dc.sqlite`: `0600`
- crash-report canonical, temporary, and pending spool files: `0600`
- directories created for local downloads: `0700`
- downloaded media files: `0600`
- temporary WhatsApp-to-Discord upload directories: `0700`
- temporary WhatsApp-to-Discord upload files: `0600`

Do not generalize those guarantees to `.env`, SQLite WAL/SHM sidecars, logs, restart flags, packaged sidecars, or rollback files. Those artifacts follow their creation API and process umask unless separately protected. Treat them as sensitive and recommend restrictive host permissions without claiming WA2DC enforces them.

WA2DC does not create or chmod `.env`. Operators should restrict it to the runtime account, for example `chmod 600 .env` on Unix-like systems.

## Docker side effects

The official entrypoint may create the configured storage directory, recursively change its ownership to `node:node` when starting as root, and then execute WA2DC as the unprivileged `node` user. This preserves access to mounted storage upgraded from older root-running images. Custom non-root images must arrange compatible ownership externally.

## Secret and backup hygiene

Never commit or attach real `.env` values, Discord tokens, database passphrases, WhatsApp QR/pairing codes, auth/session blobs, production databases, contact exports, message payloads, logs, downloads, or `.oldVersion` artifacts. Tests must use isolated temporary storage and synthetic credentials.
