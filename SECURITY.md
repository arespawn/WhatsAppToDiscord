# Security Policy

## Supported versions

Security fixes target the latest `main` branch and the most recent maintained release line. Older releases may not receive patches.

## Report a vulnerability privately

Do **not** open a public issue for a suspected vulnerability. Open a [private GitHub security advisory](https://github.com/arespawn/WhatsAppToDiscord/security/advisories/new) instead.

Include only the minimum information needed to reproduce and assess the issue:

- Affected version or commit
- Reproduction steps or a minimal proof of concept
- Expected confidentiality, integrity, or availability impact
- Known mitigations

Never include a real Discord token, WhatsApp QR/pairing code, session blob, encrypted database passphrase, private message, contact list, production database, or unredacted log. Use disposable test accounts and synthetic data.

## Disclosure process

After a report is confirmed, maintainers will triage it, develop and validate a fix, coordinate disclosure when practical, and publish an advisory and patched release.

## Security boundaries

WA2DC is self-hosted and intentionally relies on Discord permissions to control access to commands and bridged channels. Operators remain responsible for protecting the host, `.env`, `storage/`, logs, downloads, backups, and local download-server exposure. See [Privacy and Data Handling](docs/privacypolicy.txt) and the [developer security guidance](docs/dev/security-and-privacy.md).
