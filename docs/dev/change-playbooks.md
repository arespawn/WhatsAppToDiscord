# Change Playbooks

> Owner: WA2DC maintainers
> Last reviewed: 2026-07-17
> Scope: Safe command, setting, persistence, and documentation changes.

## Add or change a slash command

Slash commands live in `commandHandlers` in `src/discordHandler.js`. Define the registration `description`, ordered `options`, and `execute(ctx)` implementation.

- Keep registration through `slashCommands` / `registerSlashCommands()`.
- Keep replies ephemeral outside the control channel through `CommandResponder`.
- Use `ctx.replyPartitioned(...)` when output can exceed Discord limits.
- Add exactly one H3 section and normalized `Usage:` line in `docs/commands.md`.
- Keep documented option names and order identical to registration metadata.
- Run `npm run docs:check`; command-reference parity is enforced from the named `slashCommands` export.

## Add or change a setting

1. Add or adjust the default and normalization in `src/contracts.js`.
2. Accept only the intended persisted shape in `normalizeSettings(...)`.
3. Update the owning slash command and tests.
4. Document the default and behavior in public configuration/commands.
5. If the setting affects routing, persistence, security, files, or packaging, update the owning developer page.

## Rename or remove a setting

Remove the unsupported key from `src/contracts.js` and document the breaking behavior. Do not add hidden aliases or parallel read/write paths unless an explicit compatibility migration is part of the change.

## Change persisted data or filesystem effects

- Treat `docs/dev/storage-and-side-effects.md` as the contract.
- Preserve restrictive modes for storage/download paths.
- Use transactions for multi-record SQLite invariants.
- Add failure, restart, and malformed-data tests.
- Update public backup/configuration guidance when operators must act.
- Never reintroduce implicit legacy flat-file migration.

## Change documentation or site navigation

- Preserve established public route filenames unless a redirect/compatibility plan is explicit.
- Update `_sidebar.md`, route SEO/canonical data, sitemap, and robots entries together when adding a public page.
- Keep historical setup images referenced unless the documentation policy changes explicitly.
- Run `npm run docs:check`, serve the site with `npm run docs`, and inspect navigation, light/dark themes, narrow layout, links, and images.
