# WhatsApp To Discord

<p align="center">
  <img src="docs/_media/logo.png" alt="WA2DC logo" width="180" />
</p>

[![Latest release](https://img.shields.io/github/v/release/arespawn/WhatsAppToDiscord?display_name=tag&sort=semver&logo=github)](https://github.com/arespawn/WhatsAppToDiscord/releases/latest) [![Total downloads](https://img.shields.io/github/downloads/arespawn/WhatsAppToDiscord/total?logo=github)](https://github.com/arespawn/WhatsAppToDiscord/releases) [![License](https://img.shields.io/github/license/arespawn/WhatsAppToDiscord)](LICENSE.txt) [![Tests](https://img.shields.io/github/actions/workflow/status/arespawn/WhatsAppToDiscord/ci-tests.yml?label=tests&logo=github)](https://github.com/arespawn/WhatsAppToDiscord/actions/workflows/ci-tests.yml) [![Lint](https://img.shields.io/github/actions/workflow/status/arespawn/WhatsAppToDiscord/lint.yml?label=lint&logo=biome)](https://github.com/arespawn/WhatsAppToDiscord/actions/workflows/lint.yml) [![Docker images](https://img.shields.io/github/actions/workflow/status/arespawn/WhatsAppToDiscord/docker-publish.yml?label=docker&logo=docker)](https://github.com/arespawn/WhatsAppToDiscord/actions/workflows/docker-publish.yml) [![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen?logo=github)](https://github.com/arespawn/WhatsAppToDiscord/pulls)

WhatsAppToDiscord (WA2DC) is a self-hosted bridge that mirrors WhatsApp chats into Discord through [Baileys](https://github.com/WhiskeySockets/Baileys) and [discord.js](https://github.com/discordjs/discord.js).

Originally created by [Fatih Kilic](https://github.com/FKLC), the project is now maintained by [arespawn](https://github.com/arespawn) with the blessing of the previous author.

Start with the documentation at [arespawn.com](https://arespawn.com/):

- [Setup](https://arespawn.com/#/setup)
- [Configuration](https://arespawn.com/#/configuration)
- [Slash commands](https://arespawn.com/#/commands)
- [Troubleshooting](https://arespawn.com/#/faq)

## Highlights

- Bidirectional message, media, reaction, edit, delete, poll, and pin bridging
- Whitelist and one-way routing controls
- Discord channels or forum threads for WhatsApp conversations
- PN/LID-aware WhatsApp identity handling
- Newsletter and broadcast support
- Packaged binaries, Docker images, and Node.js source installs

## Installation choices

- **Packaged binary:** download a signed release asset from [GitHub Releases](https://github.com/arespawn/WhatsAppToDiscord/releases/latest).
- **Docker:** copy `.env.example` to `.env`, set `WA2DC_TOKEN`, then run `docker compose up -d`.
- **Source:** install Node.js 24.15.0–24.x or 26.0.0 and newer, run `npm ci`, then `npm start`. The [installer scripts](docs/install-scripts.md) can automate this path.

## Data and security

WA2DC runs on your host, but bridging necessarily sends messages and media through WhatsApp and Discord. It stores app state and WhatsApp authentication in `storage/wa2dc.sqlite`; optional payload encryption is available through `WA2DC_DB_PASSPHRASE` when the database is first created.

Keep the Discord control channel private, restrict bridged channels with Discord permissions, protect `.env` and `storage/`, and never share tokens, QR codes, session data, logs, or database copies. See [Privacy and Data Handling](docs/privacypolicy.txt) and [Security Policy](SECURITY.md).

## Development

```bash
npm ci
npm run check
npm test
WA2DC_SMOKE_TEST=1 node src/index.js
```

Contributor guidance starts in [AGENTS.md](AGENTS.md) and [docs/dev/](docs/dev/README.md).

## Disclaimer

> [!CAUTION]
> WA2DC is not affiliated with or endorsed by WhatsApp or Discord. WhatsApp and related names, marks, emblems, and images are trademarks of their respective owners. WA2DC uses unofficial WhatsApp Web integration and may be affected by upstream protocol changes or account restrictions. Use it responsibly; do not use it for spam, stalkerware, bulk messaging, or activity that violates platform terms.
