# Configuration

WA2DC combines startup environment variables with settings persisted by slash commands. Environment variables configure secrets and process-level behavior; slash commands configure bridge behavior and are stored in SQLite.

## `.env` loading

- Source runs load `.env` from the current working directory.
- Packaged executables load `.env` from the executable's directory.
- Docker Compose passes the repository's `.env` through `env_file`.
- Existing operating-system environment variables take precedence over values in `.env`.
- A missing file is ignored. Other read errors stop startup.

WA2DC does not change `.env` permissions. Restrict it to the runtime account, for example with `chmod 600 .env` on Unix-like systems.

## Supported operator variables

| Variable | Purpose | Default / important behavior |
| --- | --- | --- |
| `WA2DC_TOKEN` | Supplies the Discord token during first-run setup | Prompted interactively when absent; the resulting token is persisted in SQLite |
| `WA2DC_DB_PASSPHRASE` | Encrypts SQLite payload columns at rest | Must be set before first database creation; setting it later does not convert an existing unencrypted database |
| `WA2DC_UPDATE_CHANNEL` | Chooses release notifications | `stable`; use `unstable` for prereleases |
| `WA2DC_KEEP_OLD_BINARY` | Forces retention of the previous packaged executable for rollback | Set to `1`; packaged installs normally retain rollback data through the persisted default |
| `WA2DC_LOG_LEVEL` | Sets watchdog and worker Pino verbosity | `info`; valid values are `trace`, `debug`, `info`, `warn`, `error`, `fatal`, and `silent` |
| `WA2DC_WHATSAPP_BROWSER` | Advanced WhatsApp browser-profile override | `android`; supported values are `android`, `macos-chrome`, `windows-chrome`, `ubuntu-chrome`, and `baileys` |

`WA2DC_WHATSAPP_BROWSER` is mainly a pairing or startup diagnostic. Changing profiles for an existing registered session can clear WhatsApp authentication and require pairing again.

An encrypted database exits at startup if its passphrase is missing or wrong. Back up the passphrase separately from the database.

## Important bridge defaults

- New WhatsApp chats create regular Discord channels. `/defaultchat` can switch to managed forum threads.
- Bridging is bidirectional. `/oneway` can restrict it to WhatsApp → Discord or Discord → WhatsApp.
- An empty whitelist permits every linked chat. Adding entries restricts bridging to those chats.
- Discord attachments upload to WhatsApp by default; Discord embeds do not.
- WhatsApp audio stays in its original format unless `/waaudiomp3 enabled:true` is selected.
- WhatsApp media uploads to Discord use batches of 10 attachments.
- Mirrored deletions and public read-receipt notifications are enabled.
- Local downloads, the local download server, HTTPS, and download pruning are disabled.
- The local download server defaults to `127.0.0.1:8080` and generates `localhost` URLs.
- Update notifications follow the stable channel.

The [Slash Command Reference](commands.md) documents every persisted setting and accepted option.

## Storage and backups

Persistent state lives in `storage/wa2dc.sqlite`, including settings, chat links, contact names, WhatsApp credentials/keys, and TTL message mappings. There are no editable `storage/settings`, `storage/contacts`, or other legacy flat files.

For a consistent backup:

1. Stop WA2DC.
2. Copy the complete `storage/` directory.
3. Preserve the matching database passphrase if encryption is enabled.
4. Restart WA2DC.

Do not edit SQLite rows while WA2DC is running. Use slash commands to change supported settings.

## Media tooling

`ffmpeg` is optional and is not installed by WA2DC. It enables Discord voice-message normalization, WhatsApp GIF-to-GIF conversion, and opt-in WhatsApp audio-to-MP3 conversion. Each flow falls back to a compatible original payload when possible.

Packaged binaries use `runtime/` for native modules such as `sharp`, `canvas`, `jsdom`, and `lottie-web`. Signed packaged updates refresh the executable and matching sidecar together, and packaged startup can bootstrap a missing sidecar from a matching signed release asset.

The official Docker image contains the native image/sticker libraries but does not currently include optional `ffmpeg`. Build a custom image if those conversions are required in Docker.

## Local download server safety

The built-in server is local-only by default. To expose it to other devices, configure both the bind address and generated URL host, then secure the listening port with a firewall, reverse proxy, or TLS. Signed links prevent path guessing but do not replace network access controls. Set a nonzero link TTL when URLs should expire.

## Update behavior by installation type

| Installation | Notification | Self-update | Rollback |
| --- | --- | --- | --- |
| Packaged binary | Yes | Yes, when matching signed assets exist | `/rollback` and automatic startup rollback when backups exist |
| Docker | Yes | No | Pull a previous image tag and recreate the service |
| Node.js source | Yes | No | Check out the previous source revision and run `npm ci` |

The packaged watchdog automatically restores the previous executable and runtime sidecar after two nonzero startup exits inside the 120-second update-validation window.
