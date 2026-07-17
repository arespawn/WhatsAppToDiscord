# WhatsApp To Discord

WhatsAppToDiscord (WA2DC) is a self-hosted bridge between WhatsApp and Discord. It mirrors conversations through a Discord bot without running a full browser.

> Stable releases use tags such as `v2.x.y`. Alpha and beta releases are published on the `unstable` update channel.

## What it bridges

- Messages, replies, edits, deletions, reactions, pins, typing indicators, and supported mentions
- Images, video, audio, documents, stickers, GIFs, view-once media, and large-file fallbacks
- WhatsApp polls and live vote updates (votes remain in WhatsApp)
- Direct chats, groups, broadcasts, newsletters, and WhatsApp Status notifications
- WhatsApp chats into regular Discord channels or forum threads

WhatsApp call audio and video cannot be bridged because WhatsApp Web does not expose those live streams. WA2DC can only post call notifications.

## Choose an installation

| Method | Best for | Updates |
| --- | --- | --- |
| Packaged binary | Simple desktop/server installs | Signed in-app update and rollback when release assets support the platform |
| Docker Compose | Containerized servers | Pull and recreate the container manually |
| Node.js source | Development and customized deployments | Pull source changes and run `npm ci` manually or through the installer scripts |

Follow [Setup](setup.md) for the complete first-run flow, then review [Configuration](configuration.md) and the [Slash Command Reference](commands.md).

## Security and data boundaries

WA2DC is self-hosted, but messages and media still pass through WhatsApp and Discord as part of bridging. Link previews are fetched by the WA2DC host, and update checks contact GitHub. Local state can include sensitive authentication material, contact identifiers, message mappings, downloads, and logs.

- Keep `#control-room` and bridged channels private through Discord permissions.
- Protect `.env`, `storage/`, logs, database backups, and packaged rollback artifacts.
- Do not share QR codes, pairing codes, Discord tokens, or WhatsApp session data.
- Set `WA2DC_DB_PASSPHRASE` before first database creation if payload encryption at rest is required.

See [Privacy and Data Handling](privacypolicy.txt) and [Troubleshooting & FAQ](faq.md) for operational details.

## Persistence

All persistent app and WhatsApp authentication state lives in `storage/wa2dc.sqlite`. Legacy flat files are not loaded or migrated. Stop WA2DC before copying the `storage/` directory for backup, and retain the original database passphrase with encrypted backups.

## Updates

- The default update channel is `stable`; `unstable` includes prereleases.
- Packaged binaries can update and roll back through Discord when matching signed assets exist.
- Docker and source installs receive notifications but are updated through their deployment workflow.
- Packaged media support uses a signed `runtime/` sidecar that is updated and rolled back with the executable.

## Baileys 7 migration

This anchor remains for existing bookmarks. Current PN/LID, pairing, browser-profile, and Baileys compatibility guidance now lives in [Troubleshooting & FAQ](faq.md#whatsapp-pairing-and-sessions); implementation details belong in the [developer runtime](dev/runtime-and-layout.md) and [release](dev/testing-and-release.md) references.

## Project links

- [Setup](setup.md)
- [Configuration](configuration.md)
- [Commands](commands.md)
- [Troubleshooting & FAQ](faq.md)
- [Installer scripts](install-scripts.md)
- [Developer documentation](dev/README.md)
- [Security policy](https://github.com/arespawn/WhatsAppToDiscord/blob/main/SECURITY.md)
- [Issue tracker](https://github.com/arespawn/WhatsAppToDiscord/issues/new/choose)

Originally created by [Fatih Kilic](https://github.com/FKLC) and now maintained by [arespawn](https://github.com/arespawn).
