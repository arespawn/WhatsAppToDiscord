# WhatsApp To Discord

WhatsAppToDiscord is a Discord bot that uses WhatsApp Web as a bridge between Discord and WhatsApp. It is built on top of [discord.js](https://github.com/discordjs/discord.js) and [Baileys](https://github.com/WhiskeySockets/Baileys) libraries.

Originally created by [Fatih Kilic](https://github.com/FKLC), now maintained by [arespawn](https://github.com/arespawn).

> ✅ **Release channels:** Stable builds use tags like `v2.x.y`. Prereleases use tags like `v2.x.y-alpha.N` or `v2.x.y-beta.N` and are published to the `unstable` update channel.

## Requirements

- Node.js 24 or higher

## Features

- Supports media (Image, Video, Audio, Document, Stickers), including Discord sticker conversion for WhatsApp, and reactions!
- Allows whitelisting, so you can choose what to see on Discord
- Translates mentions between WhatsApp and Discord
- Allows usage of WhatsApp through the Discord overlay
- Syncs message edits between WhatsApp and Discord
- Bridges WhatsApp polls into Discord (creation and live updates; voting stays in WhatsApp due to API limits)
- Uses minimal resources because it doesn't simulate a browser
- Open Source, you can see, modify and run your own version of the bot!
- Self Hosted, so your data never leaves your computer
- Automatically restarts itself if it crashes
- Checks for updates every couple of days and can apply signed updates on command (packaged builds only)

**Note:** Due to limitations of the WhatsApp Web protocol, the bot can only notify you of incoming or missed calls. It cannot forward the audio or video streams of a WhatsApp call to Discord.

## Security notes

- WA2DC intentionally does **not** implement per-user/role authorization for commands. Use Discord channel/role permissions (and Discord's command permissions UI) to control who can use the bot.
- Keep `#control-room` private. It contains WhatsApp QR codes and is where you manage links/updates/settings.
- Link previews are fetched by the bot host to generate WhatsApp previews. For safety, WA2DC blocks link-preview fetches to loopback/private/link-local addresses and enforces tight size/timeouts; internal URLs may not show a preview.
- Self-update is only supported when signed release artifacts are available (packaged builds that ship a matching `.sig` file). This signature is separate from Apple notarization/codesigning.

## Persistence

- WA2DC stores app state and WhatsApp auth state in `storage/wa2dc.sqlite` (embedded SQLite; no external DB required).
- On first startup after upgrading, WA2DC automatically migrates legacy files from `storage/settings`, `storage/chats`, `storage/contacts`, `storage/lastMessages`, `storage/lastTimestamp`, and `storage/baileys/*`.
- After successful migration, legacy files are moved to `storage/legacy-backup-<timestamp>/`.
- Optional encryption-at-rest for SQLite payloads is available with `WA2DC_DB_PASSPHRASE` (set it before first DB creation).
- If an encrypted DB is detected and `WA2DC_DB_PASSPHRASE` is missing or wrong, WA2DC exits during startup.

## Baileys 7 migration

This repository currently pins the published npm package `@whiskeysockets/baileys@7.0.0-rc10`. Upstream outlines every breaking change in their migration article: [https://whiskey.so/migrate-latest](https://whiskey.so/migrate-latest). Notes and common workarounds:

**Notes**

- Local Identifiers (LIDs) are now preferred over PN-based JIDs. The bot listens for `lid-mapping.update` events, migrates stored chats/whitelists as WhatsApp reveals PN↔LID pairs, and always talks to the chat using the identifier WhatsApp considers canonical.
- WA2DC applies a small postinstall patch for upstream PR 2201 so `Browsers.android('13')` remains available while running rc10.
- Fresh WhatsApp startup uses the Android Baileys browser profile by default for view-once media support. The `/pairwithcode` flow can temporarily restart into `macos-chrome` because pairing codes are more reliable with that profile.
- When WA2DC sees registered WhatsApp auth without a matching saved browser-profile marker, it clears only the WhatsApp auth state and asks you to pair again. This prevents older sessions from being reused blindly under a different browser profile.
- WA2DC also keeps rc10 reconnects on the initial-sync wait path instead of immediately flushing buffered events when `accountSyncCounter > 0`; this avoids a packaged-startup heap spike seen after switching existing sessions to the Android browser profile.
- WA2DC logs bounded WhatsApp startup memory probes and patches rc10 tctoken pruning to run in batches, so large auth stores do not trigger a single huge heap allocation while the socket is coming online.
- The Signal auth store seeds the newly required `lid-mapping`, `tctoken`, `device-list`, and `device-index` namespaces so rc10 can write those blobs safely.

**Common issues & workarounds**

- **Duplicate Discord channels after the LID migration** – If a conversation suddenly starts flowing into a brand-new Discord channel, re-link it back to the original room via the control channel (`link --force <contact> #old-channel`) rather than editing files on disk. The bot will create a webhook inside the existing channel, clean up the stray webhook, and update its saved metadata. If you prefer to move the webhook that already exists in the duplicate channel, run `move #duplicate-channel #old-channel --force` so the bot reuses that webhook and deletes the redundant channel mapping for you.
- **`restartRequired (515)` after QR/pairing** – WhatsApp can request a socket restart immediately after pairing. WA2DC saves the current Baileys creds and reconnects with a short status message instead of treating this as a generic failed connection. Disconnect logging is bounded so large Baileys protocol payloads do not inflate `terminal.log`.
- **Prerelease rolls back after an out-of-memory crash** – Packaged updates automatically roll back after two startup crashes before the 120-second health window. Check `terminal.log` for `WhatsApp startup memory probe` entries. As a temporary isolation step, set `WA2DC_WHATSAPP_BROWSER=macos-chrome` or `WA2DC_WHATSAPP_BROWSER=baileys` before starting the same build; Android remains the default unless this variable is set.
- **Repeated "Connection was lost" logs** – WhatsApp occasionally drops the socket with timeout errors. The bot now keeps retrying with exponential backoff instead of deleting the session, so expect control-channel status messages while it reconnects. If the retries never succeed, rescan the QR code to refresh the session.
- **Startup fails with encrypted DB/passphrase errors** – If you enabled `WA2DC_DB_PASSPHRASE`, keep using the same passphrase for that `storage/wa2dc.sqlite`. If you lose it, restore from backup and migrate again.
- **Startup fails during migration** – Check file ownership/permissions under `storage/` and available disk space, then restart. Migration is transactional and won’t partially apply broken auth key writes.
- **Docker logs show `unable to open database file`** – The mounted `./storage` directory is not writable by the runtime user. The official image now auto-fixes ownership on startup when running as root. If you run with a custom non-root user, fix host ownership first (for example `sudo chown -R 1000:1000 ./WA2DC`).

## Running

Start the bot with `npm start` or run the executable from the releases page. The start script watches the process and brings it back up if it crashes. Running `node src/index.js` directly skips this behaviour, so crashes will stop the bot.

Runtime logs are written to `logs.txt`. Everything printed to the terminal is also saved to `terminal.log`, which can help diagnose issues when running on a headless server.

Alternatively, you can run the bot using Docker. Copy `.env.example` to `.env`, put your Discord bot token in it and execute:

```bash
docker compose up -d
```

The compose file mounts the `storage` directory so data is kept between container restarts. It uses the `latest` tag (stable channel) by default; switch to `unstable` if you explicitly want prerelease builds.
At container start, the image repairs ownership of the mounted `storage/` directory, then runs WA2DC as the unprivileged `node` user.

To update a running container, pull the new image and recreate the service:

```bash
docker compose pull wa2dc && docker compose up -d wa2dc
```

This keeps you in control of when updates are applied instead of auto-updating.

## Updates and release channels

- Images are pushed to the GitHub Container Registry on every release with immutable version tags plus moving `latest` (stable) and `unstable` channels.
- The bot checks for new releases every couple of days. Set `WA2DC_UPDATE_CHANNEL=unstable` to be notified about prereleases; otherwise it follows the stable channel.
- Packaged binaries can apply updates after you confirm with the `update` command. Set `WA2DC_KEEP_OLD_BINARY=1` to keep the previous executable as a rollback.
- Packaged self-update refreshes the executable and the signed `runtime/` sidecar archive together when the release publishes matching artifacts.
- Packaged startup also attempts a one-time signed bootstrap of `runtime/` when the sidecar is missing or unusable, so end users normally do not need to install it manually.
- Switch channels from the control channel with `updateChannel stable|unstable`.
- Packaged installs keep the previous binary so you can run `rollback` from the control channel if a release breaks.
- Packaged installs running through `src/runner.js` now auto-rollback after an `/update` if the new build crash-loops during startup (2 non-zero exits before 120 seconds uptime).
- Docker and source installs only notify you. Review the changelog and pull a new image when you are ready.
- Pinning a specific version tag makes rollbacks easier on Docker.

## Setup

The setup is short, but challenging for some. So, we explained every step in detail for your convenience, just [click here](setup.md) to get started.

## Installer scripts

If you prefer source installation from terminal, see [Installer Scripts](install-scripts.md) for Linux/macOS (`install_script.sh`) and Windows (`install_script.ps1`) usage and options.

## Commands

The bot supports many commands to allow rich customization. You can see the commands by [clicking here.](commands.md)

## Developer docs

For contributors, the engineering knowledge base lives in [`docs/dev/`](dev/README.md).
`AGENTS.md` is intentionally brief and acts as a map into that directory.
