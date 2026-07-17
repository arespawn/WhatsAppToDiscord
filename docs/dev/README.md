# Developer Knowledge Base

> Owner: WA2DC maintainers
> Last reviewed: 2026-07-17
> Scope: Engineering/runtime behavior, safety constraints, and change procedures.

This directory is the canonical maintenance reference. `AGENTS.md` remains a short map and should link here instead of duplicating implementation details.

## Read order

- `runtime-and-layout.md`: process lifecycle, module ownership, environment loading, and packaged runtime model
- `storage-and-side-effects.md`: SQLite schema responsibilities, runtime files, lifetimes, and explicit permission enforcement
- `bridge-constraints.md`: routing, identity, anti-loop, thread, newsletter, and transport constraints
- `change-playbooks.md`: safe command, setting, persistence, and documentation changes
- `testing-and-release.md`: validation, CI, bundling, packaged sidecars, and release invariants
- `security-and-privacy.md`: secret, log, network, local-server, and authorization boundaries

## Maintenance policy

- Update the owning developer page and relevant public page in the same change as behavior.
- Keep public documentation task-oriented and version-neutral; keep patch and internal compatibility details here.
- Preserve each page's owner, last-reviewed date, and explicit scope metadata.
- Change a review date only after checking the page against source, tests, scripts, and workflows.
- Run `npm run docs:check` whenever slash-command metadata, documented options, internal links, routes, or assets change.
- Keep pages topic-scoped; link between them instead of copying long sections.
