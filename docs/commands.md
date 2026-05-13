# Commands

All bot controls now run exclusively through Discord slash commands. Type `/` in any channel to see the available commands (the bot must share the server) or narrow the list by typing `/wa` and selecting the desired action. Commands can be invoked anywhere, but responses are ephemeral outside the control channel. The legacy `#control-room` text commands have been removed—use slash commands or the persistent buttons in the control channel.

---

## Conversation Management

### `/pairwithcode`
Request a pairing code for a specific phone number.  
Usage: `/pairwithcode phone:<E.164 phone number>`  
Note: `phone` can include a leading `+`, spaces, dashes, dots, or parentheses; WA2DC normalizes it before requesting the pairing code. Run this while WhatsApp is showing a fresh QR/pairing prompt, then enter the code immediately in WhatsApp. WA2DC waits briefly after the WhatsApp pairing prompt before requesting a code and refuses to request codes for already registered sessions, but pairing codes are still less reliable than QR scanning because WhatsApp may reject or rate-limit them.

Advanced troubleshooting: WA2DC starts fresh/unregistered WhatsApp sessions with the Android browser profile by default because it has better view-once media support. When `/pairwithcode` is used from Android, WA2DC stores a temporary `macos-chrome` pairing profile, clears the unregistered WhatsApp auth stub, and restarts; run `/pairwithcode phone:<number>` again after the restart to receive the code. The command warns that this profile is less reliable for WhatsApp view-once media. Set `WA2DC_WHATSAPP_BROWSER` before startup to force a specific profile; supported values are `android`, `macos-chrome`, `windows-chrome`, `ubuntu-chrome`, and `baileys`. For prerelease startup OOM isolation, `WA2DC_WHATSAPP_BROWSER=macos-chrome` or `WA2DC_WHATSAPP_BROWSER=baileys` can be used temporarily without changing the default for other installs.

### `/chatinfo`
Show which WhatsApp chat the current channel/thread is linked to (JID + type), plus the Discord target mode.  
Usage: `/chatinfo`

### `/start`
Create a brand-new WhatsApp conversation and link it using the current default chat mode (`channel` or `thread`).  
Usage: `/start contact:<phone number or saved contact name>`

### `/defaultchat`
Choose whether new WhatsApp chats are created as regular Discord channels or as forum threads under managed forum channels.  
Usage: `/defaultchat mode:<channel|thread> host_name:<optional forum name>`

### `/threadnotifications`
Toggle the one-time notification post WA2DC sends when it creates a new WhatsApp thread.  
Usage: `/threadnotifications enabled:<true|false>`

### `/threadtargets`
Manage which Discord roles/users are pinged when WA2DC creates a new WhatsApp thread. This is the single add/remove/list command for thread notification targets.  
Usage: `/threadtargets action:<add|remove|list> user:<optional @user> role:<optional @role>`  
Pick exactly one of `user` or `role` when using `add` or `remove`.

### `/link`
Link an existing Discord text/news channel or forum thread to an existing WhatsApp chat without creating anything new.  
Usage: `/link contact:<name or number> channel:<#channel> force:<true|false>`  
Enable `force` to override a channel/thread that is already linked to another chat.  
Note: thread targets must be forum threads; WA2DC does not support linking raw text-channel threads.

### `/move`
Move an existing WhatsApp link (and webhook) from one Discord target to another.  
Usage: `/move from:<#current-channel> to:<#new-channel> force:<true|false>`

### `/list`
List all known contacts and groups, optionally filtered.  
Usage: `/list query:<optional text>`

### `/poll`
Create a WhatsApp poll from Discord.  
Usage: `/poll question:"text" options:"opt1,opt2,..." select:<count> announcement:<true|false>`  
Notes: Poll messages and live vote updates are mirrored to Discord, voting can only be done directly in WhatsApp. In newsletter-linked channels, WA2DC now tries an interactive poll first, then falls back to a text poll summary if WhatsApp rejects the payload.

### `/setpinduration`
Set the default expiration time (24h, 7d, or 30d) for WhatsApp pins created from Discord.  
Usage: `/setpinduration duration:<24h|7d|30d>`

Thread mode notes:

- `channel` remains the default for backward compatibility.
- In `thread` mode, WA2DC creates forum threads under auto-managed forum channels named `whatsapp-threads`, `whatsapp-threads-2`, and so on, unless you provide `host_name`.
- `host_name` is sanitized into a Discord channel name and only affects newly created managed forum channels.
- Existing channel links continue working unchanged after you switch the default.
- Thread notification pings are sent only once when the thread is first created, never on every mirrored message.

### Newsletters

Once a newsletter is linked to a Discord channel, regular outbound sends flow through the same `sendMessage(...)` bridge path used for DMs/groups (no special send command needed). Newsletter edits/deletes from Discord are not currently supported by Baileys, so WA2DC shows an in-channel reminder to edit/delete directly in WhatsApp on phone. Reactions are routed through the newsletter reaction API.

Important: Until upstream Baileys newsletter image/video posting is fixed, use `/newsletterurlfallback enabled:true` as the temporary alternative for newsletter image/video attachments.

Newsletter attachment behavior:

- WhatsApp newsletter posting currently supports only image/video media from WA2DC.
- Other attachment types are skipped, and WA2DC posts a notice with WhatsApp’s guidance: https://faq.whatsapp.com/549900560675125
- URL fallback for newsletter image/video attachments is controlled by `/newsletterurlfallback` (default: disabled) and is the temporary workaround for current upstream Baileys newsletter media restrictions.

### `/newslettercreate`
Create a WhatsApp newsletter and automatically link it to a Discord channel.  
Usage: `/newslettercreate name:"title" description:"optional text"`

### `/newsletterupdate`
Update a newsletter's name and/or description.  
Usage: `/newsletterupdate jid:<optional ...@newsletter> name:"optional" description:"optional"`  
If `jid` is omitted, the current channel must already be linked to a newsletter.

### `/newsletterpicture`
Set or remove the newsletter picture.  
Usage: `/newsletterpicture mode:<set|remove> url:<required when mode=set> jid:<optional ...@newsletter>`

### `/newsletteradmincount`
Fetch the newsletter admin count.  
Usage: `/newsletteradmincount jid:<optional ...@newsletter>`

### `/newslettersubscribers`
Fetch the current newsletter subscriber count.  
Usage: `/newslettersubscribers jid:<optional ...@newsletter>`

### `/newsletterfollow`
Follow a newsletter.  
Usage: `/newsletterfollow jid:<optional ...@newsletter> invite:<optional invite code or link>`
If `jid` is omitted, WA2DC will try to resolve the newsletter via `invite`.

### `/newsletterunfollow`
Unfollow a newsletter.  
Usage: `/newsletterunfollow jid:<optional ...@newsletter>`

### `/newslettermute`
Mute a newsletter.  
Usage: `/newslettermute jid:<optional ...@newsletter>`

### `/newsletterunmute`
Unmute a newsletter.  
Usage: `/newsletterunmute jid:<optional ...@newsletter>`

### `/newsletterupdatename`
Update only the newsletter name.  
Usage: `/newsletterupdatename name:"new title" jid:<optional ...@newsletter>`

### `/newsletterupdatedescription`
Update only the newsletter description.  
Usage: `/newsletterupdatedescription description:"new text" jid:<optional ...@newsletter>`

### `/newslettermessages`
Fetch recent messages from a newsletter.  
Usage: `/newslettermessages jid:<optional ...@newsletter> count:<1-50> before:<unix seconds> after:<unix seconds>`

### `/newslettermessagedebug`
Inspect WA2DC mapping/debug data for a newsletter-linked Discord message.  
Usage: `/newslettermessagedebug messageid:<discord message id> jid:<optional ...@newsletter>`  
Shows Discord->WhatsApp ID mapping, resolved `server_id`, pending correlation, sent flags, cached ack errors, and recent per-message newsletter operation history.

### `/newslettersubscribeupdates`
Request newsletter live updates subscription metadata.  
Usage: `/newslettersubscribeupdates jid:<optional ...@newsletter>`

### `/newslettermetadata`
Fetch raw newsletter metadata (including viewer role if exposed by WhatsApp).  
Usage: `/newslettermetadata jid:<optional ...@newsletter>`

### `/newsletterinviteinfo`
Show the newsletter invite code/link exposed by WhatsApp metadata.  
Usage: `/newsletterinviteinfo jid:<optional ...@newsletter>`

### `/newsletterchangeowner`
Transfer newsletter ownership to another WhatsApp user JID/number.  
Usage: `/newsletterchangeowner user:<jid or number> jid:<optional ...@newsletter>`

### `/newsletterdemote`
Demote a newsletter admin by WhatsApp user JID/number.  
Usage: `/newsletterdemote user:<jid or number> jid:<optional ...@newsletter>`

### `/newsletterdelete`
Delete a newsletter (irreversible) and remove its local bridge mapping.  
Usage: `/newsletterdelete confirm:true jid:<optional ...@newsletter>`

### `/newsletterurlfallback`
Toggle the temporary plain-URL workaround for newsletter image/video attachments.  
Usage: `/newsletterurlfallback enabled:<true|false>`  
When enabled, WA2DC sends image/video attachments as plain links (no thumbnail/attachment payload).  
This is the recommended temporary alternative until upstream Baileys newsletter image/video posting is fixed.  
When disabled (default), image/video attachments are not sent to newsletters and WA2DC posts an in-channel explanation.

---

## Whitelist Controls

### `/listwhitelist`
Show the conversations currently allowed to bridge when the whitelist is enabled.

### `/addtowhitelist`
Add a linked channel to the whitelist.  
Usage: `/addtowhitelist channel:<#channel>`

### `/removefromwhitelist`
Remove a linked channel from the whitelist.  
Usage: `/removefromwhitelist channel:<#channel>`

---

## Formatting & Prefixes

### `/setdcprefix`
Override the prefix prepended to Discord → WhatsApp messages.  
Usage: `/setdcprefix prefix:<optional text>` (omit to reset to usernames)

### `/dcprefix`
Toggle whether the configured prefix is used.  
Usage: `/dcprefix enabled:<true|false>`

### `/waprefix`
Toggle whether WhatsApp sender names are prepended inside Discord messages.  
Usage: `/waprefix enabled:<true|false>`

### `/waplatformsuffix`
Toggle whether WhatsApp messages mirrored to Discord include a suffix showing the sender platform (Android/iOS/Desktop/Web).  
Usage: `/waplatformsuffix enabled:<true|false>`

---

## Privacy

### `/hidephonenumbers`
Hide WhatsApp phone numbers on Discord (use pseudonyms when a real contact name isn’t available).  
Usage: `/hidephonenumbers enabled:<true|false>`

---

## Mentions

WA2DC can optionally translate WhatsApp @mentions into Discord user mentions, if you link a WhatsApp contact to a Discord user.
This only works for **real WhatsApp mentions** (select the person from WhatsApp’s mention picker); manually typing `@name` without selecting won’t include mention metadata and can’t be translated reliably.
WhatsApp group-wide `@all` mentions are mirrored as Discord `@everyone` mentions when WhatsApp includes mention-all metadata; plain typed `@all` text is left unchanged.
If a WhatsApp contact is linked, WA2DC will also translate **Discord user @mentions** into **WhatsApp mentions** when forwarding messages from Discord to WhatsApp (you must use a real Discord mention — select the user from autocomplete so Discord inserts a `<@...>` mention). In WhatsApp group chats, real Discord `@everyone` / `@here` mentions are forwarded as WhatsApp `@all`; plain typed text is left unchanged.

### `/linkmention`
Link a WhatsApp contact to a Discord user so future WhatsApp @mentions ping them in Discord.  
Usage: `/linkmention contact:<phone number or saved contact name> user:<@user>`
Note: phone numbers can include `+`, spaces, or dashes; WA2DC normalizes them automatically.
Note: WhatsApp can represent the same person as a phone JID (`...@s.whatsapp.net`, “PN”) and/or a Linked-Device ID (`...@lid`, “LID”). If mentions don’t ping even though the link exists, you may be receiving **LID mentions**. You can link the LID directly by passing it as the contact value, e.g. `/linkmention contact:<someid@lid> user:<@user>`. On older versions, you may need to link **both** the PN and LID for the same contact.

### `/unlinkmention`
Remove a WhatsApp→Discord mention link for a contact.  
Usage: `/unlinkmention contact:<phone number or saved contact name>`

### `/mentionlinks`
List all configured WhatsApp→Discord mention links.

### `/jidinfo`
Show the known WhatsApp IDs (PN `@s.whatsapp.net` and/or LID `@lid`) for a contact, and whether those IDs are linked for mention pings.  
Usage: `/jidinfo contact:<phone number or saved contact name>`
How to find PN/LID:
- Easiest: run `/jidinfo contact:<name or number>` and look for lines marked `(PN)` and `(LID)`.
- Advanced: open `storage/contacts` and search for the contact name; keys ending in `@s.whatsapp.net` are PN, keys ending in `@lid` are LID.

---

## Attachments & Downloads

Defaults (out of the box):

- WhatsApp → Discord media bursts use batches of `10` attachments (`/setwamediaburstsize` can lower this for slower machines or unstable connections).
- WhatsApp audio is mirrored in its original format by default (`/waaudiomp3 enabled:true` opts in to MP3 conversion for older clients).
- Local downloads are disabled (`/localdownloads enabled:true` to turn on).
- Download directory is `./downloads` and pruning is disabled (`/setdownloadlimit`, `/setdownloadmaxage`, `/setdownloadminfree` all default to `0` = off).
- Local download server is disabled; when enabled it defaults to local-only (`127.0.0.1` bind, `localhost` URLs, port `8080`).
- WhatsApp view-once media is mirrored to Discord as spoiler attachments.

### `/setwamediaburstsize`
Set how many WhatsApp attachments WA2DC uploads to Discord per batch when mirroring media bursts.  
Usage: `/setwamediaburstsize count:<1-10>`  
Default: `10`  
Lower values can help on slower machines or unstable connections, at the cost of producing more Discord messages for large WhatsApp image bursts.
- Download links are signed (survive restarts) and never expire by default (`/setdownloadlinkttl seconds:0`).

### `/waaudiomp3`
Toggle MP3 conversion for WhatsApp audio before uploading it to Discord.  
Usage: `/waaudiomp3 enabled:<true|false>`  
Default: `false` (original WhatsApp audio is preserved).  
Requires `ffmpeg`; if conversion is unavailable or fails, WA2DC falls back to the original WhatsApp audio.

To make download links reachable from other devices (phone/PC), you usually want:

- `/setlocaldownloadserverbindhost host:0.0.0.0` (listen on all interfaces)
- `/setlocaldownloadserverhost host:<LAN IP or domain>` (generate URLs recipients can reach)
- Ensure firewall/port forwarding allows the configured port (default `8080`)

### `/waupload`
Toggle whether Discord attachments are uploaded to WhatsApp (vs sending as links).  
Usage: `/waupload enabled:<true|false>`

### `/waembeds`
Toggle whether Discord embed content (text and supported media) is mirrored to WhatsApp.  
Usage: `/waembeds enabled:<true|false>`  
Default: `false` (disabled).

### `/localdownloads`
Control whether large WhatsApp attachments are downloaded locally when they exceed Discord’s upload limit.  
Usage: `/localdownloads enabled:<true|false>`

### `/getdownloadmessage`
Show the current local-download notification template.

### `/setdownloadmessage`
Update the notification template.  
Usage: `/setdownloadmessage message:"text with {url}/{fileName}/..."`.

### `/getdownloaddir`
Show the folder used for downloaded files.

### `/setdownloaddir`
Change the download directory.  
Usage: `/setdownloaddir path:<folder>`

### `/setdownloadlimit`
Limit the download directory size (GB).  
Usage: `/setdownloadlimit size:<number>`

### `/setdownloadmaxage`
Delete downloaded files older than the given age (days).  
Usage: `/setdownloadmaxage days:<number>` (0 disables age-based cleanup)

### `/setdownloadminfree`
Keep at least the given free disk space (GB) by pruning old downloads.  
Usage: `/setdownloadminfree gb:<number>` (0 disables free-space pruning)

### `/setfilesizelimit`
Override the Discord upload size limit used to decide when to download instead of re-uploading.  
Usage: `/setfilesizelimit bytes:<integer>`

### `/setdownloadlinkttl`
Set local download link expiry in seconds.  
Usage: `/setdownloadlinkttl seconds:<integer>` (0 = never expire)

### `/localdownloadserver`
Start/stop the built-in HTTP(S) server that serves downloaded files.  
Usage: `/localdownloadserver enabled:<true|false>`

### `/setlocaldownloadserverhost`
Configure the hostname used in generated download URLs.  
Usage: `/setlocaldownloadserverhost host:<value>`

### `/setlocaldownloadserverbindhost`
Configure which interface the download server listens on.  
Usage: `/setlocaldownloadserverbindhost host:<value>` (e.g., `127.0.0.1` or `0.0.0.0`)

### `/setlocaldownloadserverport`
Configure which port the download server listens on.  
Usage: `/setlocaldownloadserverport port:<1-65535>`

### `/httpsdownloadserver`
Toggle HTTPS for the download server (requires certificates).  
Usage: `/httpsdownloadserver enabled:<true|false>`

### `/sethttpscert`
Set TLS certificate paths for the download server.  
Usage: `/sethttpscert key_path:<file> cert_path:<file>`

---

## Messaging Behavior

### `/deletes`
Toggle mirrored message deletions between Discord and WhatsApp.  
Usage: `/deletes enabled:<true|false>`

### `/readreceipts`
Turn read receipts on or off entirely.  
Usage: `/readreceipts enabled:<true|false>`

### `/dmreadreceipts`, `/publicreadreceipts`, `/reactionreadreceipts`
Pick the delivery style when read receipts are enabled (DM, short channel reply, or ☑️ reaction).

### `/changenotifications`
Toggle profile-picture / status-change alerts and WhatsApp Status (stories) mirroring (posted into the `status@broadcast` / `#status` channel).  
Usage: `/changenotifications enabled:<true|false>`

### `/oneway`
Restrict the bridge to one direction or keep it bidirectional.  
Usage: `/oneway direction:<discord|whatsapp|disabled>`

### `/redirectbots`
Allow or block Discord bot messages from being forwarded to WhatsApp.  
Usage: `/redirectbots enabled:<true|false>`

### `/redirectwebhooks`
Allow or block Discord webhook messages from being forwarded to WhatsApp.  
Usage: `/redirectwebhooks enabled:<true|false>`

### `/redirectannouncements`
Allow or block Discord announcement/crosspost webhooks from being forwarded to WhatsApp.  
Usage: `/redirectannouncements enabled:<true|false>`  
Default: `false` (disabled).

### Typing indicators (automatic)
When someone starts typing in a linked Discord channel, WA2DC sends WhatsApp presence updates (`composing` / `paused`) to the linked chat so your WhatsApp account shows “typing…”. This only runs when Discord → WhatsApp bridging is enabled (bidirectional or `/oneway direction:whatsapp`). WhatsApp cannot show *which* Discord user is typing—only that the bridge account is.

### `/publishing`
Toggle automatic cross-posting for messages sent to Discord news channels.  
Usage: `/publishing enabled:<true|false>`

### `/ping`
Return the current bot latency.

---

## Maintenance & Settings

### `/restart`
Safely save state and restart the bot (requires running via the watchdog runner).  
Usage: `/restart` (control channel only)

### `/resync`
Re-sync WhatsApp contacts/groups. Set `rename:true` to rename Discord channels to match WhatsApp subjects. The group refresh uses a lightweight group list query and does not download every group participant roster.

### `/autosaveinterval`
Change how often the bot persists state (seconds).  
Usage: `/autosaveinterval seconds:<integer>`

### `/lastmessagestorage`
Limit how many WhatsApp messages remain editable/deletable from Discord.  
Usage: `/lastmessagestorage size:<integer>`

### `/localdownloadserver`, `/setlocaldownloadserverhost`, `/setlocaldownloadserverbindhost`, `/setlocaldownloadserverport`, `/setdownloadlinkttl`, `/httpsdownloadserver`, `/sethttpscert`
See “Attachments & Downloads” above (listed again here for visibility).

---

## Update Management

The control channel now shows a persistent update card with “Update”, “Skip update”, and “Roll back” buttons that survive restarts. These buttons trigger the same slash commands listed below.

### `/updatechannel`
Switch between the stable and unstable release channels.  
Usage: `/updatechannel channel:<stable|unstable>`

### `/checkupdate`
Manually check for updates on the active channel.

### `/skipupdate`
Dismiss the current update notification without installing.

### `/update`
Download and install the available release (packaged installs only). Docker/source deployments will be reminded to pull and restart manually.  
For packaged installs, the updater refreshes both the executable and the matching signed `runtime/` sidecar archive when the release publishes one.  
If the updated packaged install crash-loops during startup, the watchdog runner automatically rolls back to the previous `.oldVersion` executable and `runtime/` sidecar (2 non-zero exits before 120 seconds uptime).

### `/rollback`
Restore the previous packaged binary when one is available. The dedicated “Roll back” button only appears if a backup exists.  
This is still useful for manual recovery, but update failures are now auto-rolled back by the watchdog runner when possible.

---

Need help remembering the command names? Type `/wa` inside Discord and let the client autocomplete each slash command along with its required options. All commands are self-documented via Discord’s UI, so you no longer have to memorize legacy text formats.
