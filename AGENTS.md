# Agent Notes (AGENTS.md)

This file is the quick map for coding agents working in WA2DC.
It intentionally stays short; detailed guidance lives in `docs/dev/`.

## Project snapshot

WhatsAppToDiscord (WA2DC) is a self-hosted bridge that mirrors WhatsApp chats into Discord.

- WhatsApp transport: Baileys (`@whiskeysockets/baileys`)
- Discord transport: Discord bot (`discord.js`)
- Persistent state: local `./storage/`
- Runtime entry: watchdog runner `src/runner.js`

## Fast start

- Prereq: Node.js `>=24`
- Install: `npm ci`
- Run bot: `npm start`
- Run docs: `npm run docs`
- Lint: `npm run lint` (Biome)
- Test: `npm test`
- Bundle: `npm run bundle`
- Build binary: `npm run build:bin`
- Smoke boot: `WA2DC_SMOKE_TEST=1 node src/index.js`

## Where the source of truth lives

Use these docs for detailed guidance:

- `docs/dev/README.md`: developer docs index and ownership/freshness rules
- `docs/dev/runtime-and-layout.md`: runtime model and repository map
- `docs/dev/storage-and-side-effects.md`: disk formats, runtime files, and permission rules
- `docs/dev/bridge-constraints.md`: anti-loop protections, JID/LID handling, routing constraints
- `docs/dev/change-playbooks.md`: slash command and settings change procedures
- `docs/dev/testing-and-release.md`: test matrix, CI, bundling/pkg constraints
- `docs/dev/security-and-privacy.md`: secret handling and safety boundaries

## Critical guardrails

- Follow the current SQLite-only storage contract in `docs/dev/storage-and-side-effects.md`.
- Do not loosen storage permissions (`0700` dirs / `0600` files).
- Avoid bridge echo loops; maintain sender-tracking protections.
- Respect whitelist and one-way routing checks when touching message flows.
- Do not hardcode PN vs LID assumptions for WhatsApp identifiers.
- Keep Discord output within platform limits (message length / file size).
- Use Biome for linting/format checks.
- Treat `out.js`, `out.cjs`, and `build/` as generated artifacts.
- Never commit secrets (`.env`, auth state, tokens, session blobs).

## Runtime artifacts to avoid breaking

The app may create/use:

- `storage/`
- `downloads/`
- `logs.txt`
- `terminal.log`
- `crash-report.txt`
- `restart.flag`

If your change affects these files or their semantics, update `docs/dev/storage-and-side-effects.md`.

## Definition of done for behavior changes

When changing user-visible behavior or bridge logic:

- Update the relevant `docs/dev/` page(s).
- Update end-user docs when applicable (`docs/commands.md`, `docs/setup.md`, `docs/faq.md`).
- Run at least: `npm test` and smoke boot for startup-sensitive changes.

## Notes for contributors

Keep this file around ~100 lines and treat it as a table of contents, not an encyclopedia.
When detailed guidance changes, edit `docs/dev/` first, then adjust links here.
