# Troubleshooting & FAQ

Start with `logs.txt` and, when using the watchdog runner, `terminal.log`. Increase structured log detail with `WA2DC_LOG_LEVEL=debug`, but treat diagnostic logs as sensitive because they can contain WhatsApp JIDs and Discord identifiers.

## WhatsApp pairing and sessions

### Pairing ends with `restartRequired (515)`

WhatsApp can require a socket restart immediately after successful pairing. WA2DC saves credentials and reconnects; wait for the next control-channel status before retrying.

### Pairing times out with `QR refs attempts ended (408)`

Scan the next fresh QR code or rerun `/pairwithcode` only after WA2DC posts a new pairing prompt. WA2DC prefers WhatsApp's current Web revision and falls back to Baileys' published revision when the live lookup is unavailable. This works around the upstream [Baileys pairing-version issue](https://github.com/WhiskeySockets/Baileys/issues/2679).

### `/pairwithcode` causes a restart

Fresh sessions use the Android browser profile for view-once support. Pairing codes can be more reliable under a Chrome profile, so WA2DC may store a temporary pairing profile, clear only the unregistered auth stub, and restart. Run `/pairwithcode` again after the new prompt.

### Pairing reports `failed to ack notification` or `Invalid buffer`

The pinned Baileys release can receive incomplete or pre-auth pairing notifications. WA2DC applies bounded patches that safely acknowledge and skip incomplete payloads without logging cryptographic data. The incomplete-link-code case is tracked upstream in [Baileys issue #2600](https://github.com/WhiskeySockets/Baileys/issues/2600).

### The updated build rolls back after startup crashes

Packaged updates are validated for 120 seconds. Two nonzero exits in that window trigger automatic restoration of the previous executable and runtime sidecar. Inspect the WhatsApp startup memory probes in `terminal.log`. As a temporary diagnostic, try `WA2DC_WHATSAPP_BROWSER=macos-chrome` or `baileys`, understanding that a profile change may require fresh pairing.

### WhatsApp repeatedly disconnects

Transient connection loss is retried with backoff. If the session never recovers, restart once and pair again only after ordinary network, DNS, clock, and firewall problems have been ruled out.

## Discord setup and routing

### Slash commands are missing

Use WA2DC's generated authorization URL to invite the bot again. The authorization must include both `bot` and `applications.commands` scopes. Also confirm the bot can access the configured server and channel.

### Messages are empty or do not bridge from Discord

Enable **Message Content Intent** on the Discord application's Bot page, then restart WA2DC. Also check `/oneway`, the whitelist, and the `redirectbots`/`redirectwebhooks` settings.

### Where can commands be used?

Slash commands can be invoked in any channel shared with the bot; replies are ephemeral outside `#control-room`. `/restart` is deliberately limited to the control channel. Use Discord role, channel, and command permissions to restrict access.

### `/ping` reports negative or unexpectedly high latency

`/ping` compares Discord's interaction timestamp with the WA2DC host's system clock. An incorrect or drifting host clock can therefore produce a negative or unusually large value. Enable automatic time synchronization on the host, then try the command again.

### LID migration created a duplicate Discord channel

Relink the WhatsApp chat to the original target with `/link contact:<contact> channel:<#old-channel> force:true`. To reuse the webhook from the duplicate target, use `/move from:<#duplicate-channel> to:<#old-channel> force:true`. Do not edit SQLite manually.

### A forum thread cannot be linked

WA2DC accepts forum threads and regular text/news channels. Threads created under ordinary text channels are not supported because webhook routing and recovery depend on the forum host relationship.

## Storage and startup

### Startup cannot find existing state

Confirm that `storage/wa2dc.sqlite` was copied with the install and is readable and writable by the runtime account. Legacy flat files are not migrated or loaded.

### Startup fails with a passphrase error

Use the exact `WA2DC_DB_PASSPHRASE` present when the encrypted database was created. A missing or wrong passphrase cannot be repaired; restore a matching backup and passphrase. Setting a passphrase after an unencrypted database already exists does not encrypt that database.

### Docker reports `unable to open database file`

The mounted `./storage` directory is not writable by the container runtime. The official entrypoint repairs its ownership when it starts as root, then runs WA2DC as the unprivileged `node` user. Custom non-root deployments must set compatible host ownership before startup.

### The standalone executable does not read `.env`

Place `.env` beside the packaged executable. Source runs use `.env` from the current working directory. Operating-system environment variables override the file; unreadable files stop startup. See [Configuration](configuration.md).

## Media

### Discord voice messages fail on WhatsApp

Install `ffmpeg` for the most compatible Opus/Ogg voice-note conversion. Without it, WA2DC attempts a raw audio send that some WhatsApp clients may reject.

### WhatsApp audio does not play on an older Discord client

Run `/waaudiomp3 enabled:true` and install `ffmpeg`. If conversion is unavailable or fails, WA2DC preserves the original attachment.

### A WhatsApp GIF arrives as a video

WhatsApp represents GIF playback as a video payload. WA2DC uses `ffmpeg` to create a real Discord GIF when available and otherwise sends the original video.

### A Discord image arrives as a file

WA2DC uses `sharp` to normalize unsupported static images. If the runtime sidecar is missing or the image cannot be decoded safely, it falls back to a document rather than dropping it.

### A Discord sticker is not converted

Static and animated conversion depends on packaged runtime modules such as `sharp`, `canvas`, `jsdom`, and `lottie-web`. Keep the packaged `runtime/` sidecar beside the executable or allow signed bootstrap to restore it.

### View-once media behavior

WA2DC mirrors supported WhatsApp view-once media to Discord as spoiler attachments. Availability depends on the active WhatsApp browser profile and upstream protocol behavior.

## Operations and releases

### `/update` fails with `TAR_ENTRY_INFO` while installing v2.5.0 or v2.5.1

The Linux and macOS runtime sidecar archives published with v2.5.0 and v2.5.1 contain absolute build-host symbolic links. The packaged updater intentionally rejects those links and restores the previous executable and runtime together. Do not bypass verification or keep retrying the affected release. Keep the working installation and upgrade directly to the first stable release newer than v2.5.1 when it is published.

### Why is the binary flagged as unknown or suspicious?

WA2DC releases may not carry platform publisher notarization, so reputation-based tools can warn about them. Download only from the official [release page](https://github.com/arespawn/WhatsAppToDiscord/releases), verify the published SHA-256 checksum, and run from source if you require independent inspection. Never bypass a warning for a file obtained elsewhere.

### Can WA2DC run continuously on a server?

Yes, but it uses unofficial WhatsApp Web integration and could be affected by account restrictions or protocol changes. Secure the host, control Discord access, keep backups, and use the software at your own risk.

### Can WhatsApp calls be bridged to Discord?

No. WhatsApp Web does not expose live call audio or video streams. WA2DC can only post incoming or missed call notifications.

### How are packaged updates rolled back?

`/update` first downloads the complete executable/runtime pair to a private staging directory. It verifies the signed release manifest, size, SHA-256 hash, and RSA signature of each asset before changing the installation. It then keeps the previous executable and matching runtime sidecar when possible. `/rollback` restores them manually; the watchdog also rolls back automatically after an unhealthy updated startup. Docker users should pin or pull an older image tag, and source users should check out an older revision.

### Why can I see an update but no Update button?

In-app self-update is supported for Linux x64, Linux ARM64, macOS Intel, and Windows x64 packaged binaries. Docker, source installs, macOS ARM, Windows ARM, and other targets still receive release notifications but must update through their installation method. Stable users never receive a beta through the stable channel, and WA2DC will not offer a downgrade.

### What is the difference between stable and unstable updates?

`stable` follows published `vX.Y.Z` releases through GitHub's latest stable-release endpoint. `unstable` follows `vX.Y.Z-beta.N` releases from the `next` branch. Beta is the only prerelease phase. Every published release completes native smoke tests, signing, checksums, update-manifest generation, and container publication before its draft is made visible.

### How do I build a binary?

Install Node.js 24.15.0–24.x or 26.0.0 and newer, run `npm ci`, then `npm run build:bin`. Output is written to `build/`, including the executable and `runtime/` sidecar. `npm run build:bin:smoke` also runs the packaged smoke test. Full packaging constraints live in [Testing and Release](dev/testing-and-release.md).
