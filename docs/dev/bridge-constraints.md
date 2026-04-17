# Bridge Constraints

> Owner: WA2DC maintainers
> Last reviewed: 2026-04-06
> Scope: Message-routing and identity constraints that prevent regressions.

## Echo-loop prevention

Bridge bounce protection relies on state trackers:

- `state.sentMessages`
- `state.sentReactions`
- `state.sentPins`

When adding new mirrored events, extend loop-prevention tracking accordingly.

## JID/LID migration hygiene

WhatsApp identifiers may be PN-based JIDs or LID-based JIDs.
Use shared helpers instead of assumptions:

- `utils.whatsapp.formatJid(...)`
- `utils.whatsapp.hydrateJidPair(...)`
- `utils.whatsapp.migrateLegacyJid(...)`

Do not hardcode behavior to `@s.whatsapp.net` or `@lid` only.

## Discord platform limits

Respect transport constraints when emitting output:

- 2000-character message limit
- use `utils.discord.partitionText(...)` for long responses
- respect file-size gating (for example `DiscordFileSizeLimit`)
- keep WhatsApp-backed Discord attachment uploads bounded during media bursts; honor `state.settings.WhatsAppDiscordMediaBurstSize` and do not exceed Discord's 10-file upload limit
- treat transient Discord upload transport failures from both Undici and Node HTTP/2 stream errors as retryable so WhatsApp-backed media bursts can recover or emit a fallback notice instead of dropping silently
- preserve Discord -> WhatsApp attachment delivery for unsupported static image formats by normalizing them to WhatsApp-safe image payloads when possible, and fall back to document delivery instead of dropping the message when normalization fails
- precompute outbound `jpegThumbnail` data for Discord -> WhatsApp image sends when possible so packaged Baileys builds do not need to discover image tooling at send time
- when a Discord message contains multiple album-eligible image/video attachments for a normal WhatsApp chat, prefer relaying them as a WhatsApp media album instead of separate standalone sends; keep mixed/unsupported attachment sets on the sequential fallback path
- do not flatten or duplicate animated Discord media just to satisfy static image normalization paths; when Discord exposes both a GIF file entry and its preview video for the same upload, prefer a single animated send candidate
- when Discord GIF providers (for example Tenor/Giphy) expose extensionless video URLs plus static preview thumbnails, infer the animated video send from the provider embed and suppress the duplicate preview image
- when WhatsApp exposes GIFs as `videoMessage` payloads with `gifPlayback`, prefer transcoding them into real Discord GIF attachments when runtime tooling (`ffmpeg`) is available; if transcoding is unavailable or fails, fall back to the original video attachment instead of dropping media
- prefer the sticker asset URL exposed by Discord over reconstructing sticker CDN/proxy URLs locally; convert Discord sticker assets into WhatsApp sticker payloads when possible, including animated Lottie stickers via the dedicated renderer path
- keep Discord -> WhatsApp bare-URL normalization narrow enough that plain email addresses are forwarded unchanged instead of being rewritten into malformed `https://.../@domain` text

## Routing gates

Routing may be restricted by deployment settings. Message-flow changes must preserve:

- `state.settings.oneWay`
- whitelist checks via `state.settings.Whitelist`
- helper checks via `utils.whatsapp.inWhitelist(...)`
- broadcast delivery mode for WhatsApp `@broadcast` chats (`sendMessage(..., ..., { broadcast: true })`
  on Discord -> WhatsApp sends)
- newsletter delivery mode for WhatsApp `@newsletter` chats:
  outbound sends should use standard `sendMessage(...)` payloads like DMs/groups where possible.
  image/video attachments should follow `state.settings.NewsletterMediaUrlFallback`:
  when enabled, send them as plain URLs (no WhatsApp media payload) as a temporary workaround until upstream Baileys newsletter media posting is fixed.
  when disabled (default), do not send image/video attachments; emit an in-channel explanation.
  non-image/video attachments should be skipped with a user-facing notice and WhatsApp FAQ link (`https://faq.whatsapp.com/549900560675125`).
  newsletter edit/delete from Discord are intentionally not dispatched to WhatsApp; emit a Discord reminder to perform edit/delete in the WhatsApp phone app instead.
  consume raw newsletter `live_updates` notifications (when present) to map pending outbound IDs to `server_id` values as early as possible for supported flows.
  reactions should use `newsletterReactMessage(jid, serverId, reaction?)` when available.
  optional send-side hardening (ack-aware retry paths and quote fallback behavior) can be enabled with `WA2DC_NEWSLETTER_SPECIAL_FLOW=1`.
  Poll sends to newsletters should still try interactive payload first, then fall back to text on send or ack rejection (commonly ack error `479`).
  Mirror incoming WhatsApp newsletter reactions via `newsletter.reaction` and/or raw `live_updates` notifications, keyed by `server_id`.

When Discord links target forum threads instead of plain channels, resolve routing through the thread target ID while preserving the parent webhook host channel ID for webhook operations and recovery.
