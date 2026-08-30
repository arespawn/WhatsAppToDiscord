# Bridge Constraints

> Owner: WA2DC maintainers
> Last reviewed: 2026-08-30
> Scope: Routing, identity, anti-loop, thread/newsletter, and transport constraints that prevent regressions.

## Echo-loop and message tracking

Mirrored events must not bounce indefinitely between transports. Preserve and extend the relevant trackers when adding event types:

- `state.sentMessages`
- `state.sentReactions`
- `state.sentPins`
- bidirectional recent-message mappings in `state.lastMessages`
- TTL message payloads in `src/messageStore.js`

Newsletter pending-send/server-ID correlation has separate bounded state in `src/newsletterBridge.js`; do not substitute ordinary Baileys outbound IDs where WhatsApp requires a newsletter `server_id`.

## WhatsApp identity

WhatsApp contacts may be represented by PN JIDs, LIDs, or discovered PN↔LID pairs. Use shared helpers such as:

- `utils.whatsapp.formatJid(...)`
- `utils.whatsapp.hydrateJidPair(...)`
- `utils.whatsapp.migrateLegacyJid(...)`

Do not hardcode a contact as exclusively `@s.whatsapp.net` or `@lid`. Identity-aware behavior includes chat links, whitelists, mention links, sender tracking, contact naming, and quoted-message attribution.

## Routing gates

Every new message/event flow must preserve:

- `state.settings.oneWay`: `bidirectional`, `to-discord`, or `to-whatsapp`
- whitelist checks through `state.settings.Whitelist` and `utils.whatsapp.inWhitelist(...)`
- sent-event tracking before mirrored events can be observed on the opposite transport
- `broadcast: true` for Discord-to-WhatsApp `@broadcast` sends
- the resolved Discord thread target ID while retaining the parent webhook host channel ID

Managed forum hosts are selected by configured name and a bot-owner marker in the forum topic. Separate WA2DC bot users must not silently share a managed host. Only forum threads are supported bridge thread targets; raw threads under text channels are rejected.

## Mentions and Discord limits

- Partition long Discord output with `utils.discord.partitionText(...)`; Discord messages are limited to 2,000 characters.
- Enable Discord `@everyone` parsing for WhatsApp `@all` only when WhatsApp includes mention-all metadata.
- Send WhatsApp `mentionAll` for Discord `@everyone`/`@here` only when Discord includes real everyone-mention metadata and the target is a WhatsApp group.
- Translate individual mentions only from real platform mention metadata; do not interpret arbitrary typed `@name` text.
- Respect `DiscordFileSizeLimit` and local-download fallback behavior.

## Media delivery

- Bound WhatsApp-to-Discord attachment batches with `WhatsAppDiscordMediaBurstSize`; never exceed Discord's 10-file upload limit.
- Keep ordinary WhatsApp media lazy until Discord send time. Stage attachments sequentially into private temporary files, enforce `DiscordFileSizeLimit` against actual bytes, and retry from those replayable files instead of reopening WhatsApp streams.
- Apply a 60-second timeout to each WhatsApp media download and to Discord REST requests. A failed attachment must not discard successful siblings: upload the remainder with a notice, or preserve the message text and emit the check-WhatsApp fallback when none can be staged.
- Keep Discord REST multipart requests on Node's global `fetch`, for both the main client and standalone stored-webhook clients. The process also loads a newer Undici major through link preview handling; mixing its global dispatcher with `@discordjs/rest`'s bundled Undici request can leave multipart bodies unsent until the socket closes.
- Retry transient Discord upload failures from Undici and Node HTTP/2 streams, then emit a fallback notice instead of silently dropping media. Upload diagnostics may include counts, byte totals, durations, attempts, and outcomes, but never message content, sender IDs, or webhook tokens.
- Normalize unsupported static Discord images when possible, fall back to WhatsApp document delivery on failure, and precompute outbound JPEG thumbnails when tooling is available.
- Send album-eligible image/video sets to ordinary WhatsApp chats as media albums; keep mixed or unsupported sets on the sequential fallback path.
- Mirror WhatsApp view-once media as Discord spoiler attachments.
- Deduplicate Discord animated uploads/provider embeds and prefer the true animated candidate over static previews.
- Convert WhatsApp `gifPlayback` video to a Discord GIF when `ffmpeg` is available; preserve the original video on failure.
- Preserve WhatsApp audio by default. Convert to MP3 only when configured and fall back to the original attachment.
- Prefer Discord's sticker asset URL. Convert static and animated stickers through the dedicated renderer when available.
- Keep Discord-to-WhatsApp bare-URL normalization narrow enough that email addresses remain unchanged.

## Newsletters

Treat newsletters as standard `sendMessage(...)` destinations where supported, with these exceptions:

- Image/video attachments follow `NewsletterMediaUrlFallback`: send plain URLs when enabled; otherwise skip and explain the limitation.
- Other attachment types are skipped with a user-facing notice and the [WhatsApp newsletter-media guidance link](https://faq.whatsapp.com/549900560675125/).
- Discord-originated newsletter edit/delete is not dispatched; remind the user to perform it in the phone app.
- Pending outbound IDs are correlated with raw `live_updates` `server_id` values as early as possible.
- Reactions use `newsletterReactMessage(jid, serverId, reaction?)` when available.
- Newsletter polls try the interactive payload first and fall back to text after send failure or acknowledgement rejection.
- Incoming reactions may arrive through `newsletter.reaction`, raw `live_updates`, or both; correlate by `server_id` and deduplicate.

Keep newsletter ack, pending-send, and debug state bounded by TTL and per-message/per-JID limits.
