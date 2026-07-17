# WhatsApp To Discord

<p align="center">
  <img src="docs/_media/logo.png" alt="WA2DC logo" width="180" />
</p>

[![Latest release](https://img.shields.io/github/v/release/arespawn/WhatsAppToDiscord?display_name=tag&sort=semver&logo=github)](https://github.com/arespawn/WhatsAppToDiscord/releases/latest) [![Total downloads](https://img.shields.io/github/downloads/arespawn/WhatsAppToDiscord/total?logo=github)](https://github.com/arespawn/WhatsAppToDiscord/releases) [![License](https://img.shields.io/github/license/arespawn/WhatsAppToDiscord)](LICENSE.txt) [![Tests](https://img.shields.io/github/actions/workflow/status/arespawn/WhatsAppToDiscord/ci-tests.yml?label=tests&logo=github)](https://github.com/arespawn/WhatsAppToDiscord/actions/workflows/ci-tests.yml) [![Lint](https://img.shields.io/github/actions/workflow/status/arespawn/WhatsAppToDiscord/lint.yml?label=lint&logo=biome)](https://github.com/arespawn/WhatsAppToDiscord/actions/workflows/lint.yml) [![Docker images](https://img.shields.io/github/actions/workflow/status/arespawn/WhatsAppToDiscord/docker-publish.yml?label=docker&logo=docker)](https://github.com/arespawn/WhatsAppToDiscord/actions/workflows/docker-publish.yml) [![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen?logo=github)](https://github.com/arespawn/WhatsAppToDiscord/pulls)

WhatsAppToDiscord (WA2DC) is a self-hosted bridge that mirrors WhatsApp chats into Discord using WhatsApp Web (via [Baileys](https://github.com/WhiskeySockets/Baileys)) and a Discord bot (via [discord.js](https://github.com/discordjs/discord.js)).

Originally created by [Fatih Kilic](https://github.com/FKLC), the project is now maintained by [arespawn](https://github.com/arespawn) with the blessing of the previous author.

> [!IMPORTANT]
> The documentation website is the best place to start (setup, commands, configuration, troubleshooting): https://arespawn.github.io/WhatsAppToDiscord/

## Requirements

- Node.js 24 or higher

## Installer scripts

For source installs/updates with automatic dependency setup:

- Linux/macOS: `./install_script.sh`
- Windows PowerShell: `.\install_script.ps1`

Detailed options and platform notes are documented in [`docs/install-scripts.md`](docs/install-scripts.md).

## Highlights

- Mirrors messages, media, reactions, and edits between WhatsApp and Discord
- Lets you whitelist which chats appear in Discord
- Bridges WhatsApp polls into Discord (creation and live updates; voting stays in WhatsApp due to API limits)
- Self-hosted: runs on your own machine/server

## Security notes

- WA2DC intentionally relies on Discord permissions for access control. Keep the control channel private and restrict who can use bot commands using Discord role/channel permissions.

## Persistence

- WA2DC stores app state and WhatsApp auth keys in `storage/wa2dc.sqlite` (embedded SQLite, no external database service required).
- Legacy flat-file storage is no longer migrated at startup; keep or restore `storage/wa2dc.sqlite` when moving installs.
- Optional payload encryption-at-rest is available through `WA2DC_DB_PASSPHRASE` (set it before first DB creation).
- If the DB is encrypted and `WA2DC_DB_PASSPHRASE` is missing or wrong, WA2DC exits during startup instead of running with invalid auth state.

## Disclaimer

> [!CAUTION]
> This project is not affiliated, associated, authorized, endorsed by, or in any way officially connected with WhatsApp or any of its subsidiaries or its affiliates. The official WhatsApp website can be found at whatsapp.com. "WhatsApp" as well as related names, marks, emblems and images are registered trademarks of their respective owners.
>
> The maintainers do not in any way condone the use of this application in practices that violate the Terms of Service of WhatsApp. The maintainers of this application call upon the personal responsibility of its users to use this application in a fair way, as it is intended to be used. Use at your own discretion. Do not spam people with this. We discourage any stalkerware, bulk or automated messaging usage.
