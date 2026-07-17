# Slash Command Reference

WA2DC controls are Discord slash commands. Type `/` in a server shared with the bot, then search for the command name. Commands may be used in any linked server channel; replies are ephemeral outside the control channel. `/restart` is restricted to the control channel.

Required options use angle brackets. Optional options use square brackets. Discord also shows each command's live option descriptions and allowed values.

## Conversations and threads

### `/pairwithcode`

Request a WhatsApp pairing code for a phone number. QR pairing is generally more reliable. The number may contain a leading `+`, spaces, dashes, dots, or parentheses; WA2DC normalizes it before sending the request. See [Troubleshooting & FAQ](faq.md) for browser-profile restarts and pairing failures.

Usage: `/pairwithcode phone:<E.164 phone number>`

### `/chatinfo`

Show the WhatsApp JID, chat type, and Discord channel/thread mode linked to the current target.

Usage: `/chatinfo`

### `/start`

Start a conversation with a saved contact or phone number. WA2DC creates a Discord channel or forum thread according to `/defaultchat`.

Usage: `/start contact:<name or phone number>`

### `/defaultchat`

Choose whether newly discovered WhatsApp chats become regular Discord channels or forum threads. In thread mode, `host_name` selects the managed forum name; otherwise WA2DC uses `whatsapp-threads`, adding a numeric suffix when needed.

Usage: `/defaultchat mode:<channel|thread> host_name:[forum name]`

### `/threadnotifications`

Toggle the one-time notification sent when WA2DC creates a new WhatsApp forum thread. Notifications are not repeated for every mirrored message.

Usage: `/threadnotifications enabled:<true|false>`

### `/threadtargets`

Add, remove, or list the Discord users and roles notified when a new WhatsApp thread is created. For `add` and `remove`, provide exactly one user or role.

Usage: `/threadtargets action:<add|remove|list> user:[@user] role:[@role]`

### `/link`

Link an existing WhatsApp chat to an existing Discord text/news channel or forum thread. Raw threads under text channels are unsupported. Set `force` only when intentionally replacing another chat's link.

Usage: `/link contact:<name or phone number> channel:<#channel or forum thread> force:[true|false]`

### `/move`

Move an existing WhatsApp link and its webhook to another Discord target. Set `force` only when intentionally replacing the destination's current link.

Usage: `/move from:<#current target> to:<#new target> force:[true|false]`

### `/list`

List known WhatsApp contacts and groups, optionally filtered by text. Use `/resync` if expected entries are missing.

Usage: `/list query:[search text]`

### `/poll`

Create a WhatsApp poll from a linked Discord target. Supply at least two comma-separated options; `select` defaults to one. Polls and vote updates mirror to Discord, but voting happens in WhatsApp. Newsletter polls fall back to a text summary when WhatsApp rejects the interactive payload.

Usage: `/poll question:<text> options:<comma-separated choices> select:[count] announcement:[true|false]`

### `/setpinduration`

Set the default expiry for WhatsApp pins created from Discord.

Usage: `/setpinduration duration:<24h|7d|30d>`

## Newsletters

Newsletter commands accept a `jid` when shown. If it is omitted, the current Discord target must already be linked to a newsletter. Regular messages use the normal bridge; Discord-side newsletter edits and deletes are not sent to WhatsApp. Perform those actions in the WhatsApp phone app.

### `/newslettercreate`

Create a WhatsApp newsletter and link it to a new Discord channel.

Usage: `/newslettercreate name:<title> description:[text]`

### `/newsletterupdate`

Update a newsletter's name, description, or both.

Usage: `/newsletterupdate jid:[...@newsletter] name:[new title] description:[new text]`

### `/newsletterpicture`

Set or remove the newsletter picture. `url` is required when `mode` is `set`.

Usage: `/newsletterpicture mode:<set|remove> url:[image URL] jid:[...@newsletter]`

### `/newsletteradmincount`

Fetch the newsletter administrator count.

Usage: `/newsletteradmincount jid:[...@newsletter]`

### `/newslettersubscribers`

Fetch the current newsletter subscriber count.

Usage: `/newslettersubscribers jid:[...@newsletter]`

### `/newsletterfollow`

Follow a newsletter. An invite code or link can be used instead of a JID.

Usage: `/newsletterfollow jid:[...@newsletter] invite:[invite code or link]`

### `/newsletterunfollow`

Unfollow a newsletter.

Usage: `/newsletterunfollow jid:[...@newsletter]`

### `/newslettermute`

Mute a newsletter.

Usage: `/newslettermute jid:[...@newsletter]`

### `/newsletterunmute`

Unmute a newsletter.

Usage: `/newsletterunmute jid:[...@newsletter]`

### `/newsletterupdatename`

Update only the newsletter name.

Usage: `/newsletterupdatename name:<new title> jid:[...@newsletter]`

### `/newsletterupdatedescription`

Update only the newsletter description.

Usage: `/newsletterupdatedescription description:<new text> jid:[...@newsletter]`

### `/newslettermessages`

Fetch recent newsletter messages. `count` accepts 1–50 and defaults to 10; `before` and `after` are Unix timestamps in seconds.

Usage: `/newslettermessages jid:[...@newsletter] count:[1-50] before:[Unix seconds] after:[Unix seconds]`

### `/newslettermessagedebug`

Inspect WA2DC's mapping, `server_id`, acknowledgement, pending-correlation, and recent operation data for a newsletter-backed Discord message.

Usage: `/newslettermessagedebug messageid:<Discord message ID> jid:[...@newsletter]`

### `/newslettersubscribeupdates`

Request newsletter live-update subscription metadata.

Usage: `/newslettersubscribeupdates jid:[...@newsletter]`

### `/newslettermetadata`

Fetch newsletter metadata, including the viewer role when WhatsApp exposes it.

Usage: `/newslettermetadata jid:[...@newsletter]`

### `/newsletterinviteinfo`

Show the invite link or code exposed by newsletter metadata.

Usage: `/newsletterinviteinfo jid:[...@newsletter]`

### `/newsletterchangeowner`

Transfer newsletter ownership to another WhatsApp user. Verify the destination carefully before running this command.

Usage: `/newsletterchangeowner user:<WhatsApp JID or number> jid:[...@newsletter]`

### `/newsletterdemote`

Demote a newsletter administrator.

Usage: `/newsletterdemote user:<WhatsApp JID or number> jid:[...@newsletter]`

### `/newsletterdelete`

Permanently delete a newsletter and remove its local bridge mapping. This action is irreversible and requires explicit confirmation.

Usage: `/newsletterdelete confirm:<true> jid:[...@newsletter]`

### `/newsletterurlfallback`

Toggle the temporary plain-URL fallback for newsletter image/video attachments. It is disabled by default. When disabled, unsupported media is skipped with an explanation; other attachment types are not sent to newsletters.

Usage: `/newsletterurlfallback enabled:<true|false>`

## Whitelist

An empty whitelist allows every linked chat. Once entries are added, only listed chats bridge.

### `/addtowhitelist`

Add the WhatsApp chat linked to a Discord channel or thread to the whitelist.

Usage: `/addtowhitelist channel:<#linked target>`

### `/removefromwhitelist`

Remove the WhatsApp chat linked to a Discord channel or thread from the whitelist.

Usage: `/removefromwhitelist channel:<#linked target>`

### `/listwhitelist`

List the chats currently in the whitelist.

Usage: `/listwhitelist`

## Formatting, privacy, and mentions

Mention translation only uses real platform metadata: select a WhatsApp contact from the mention picker or a Discord user from autocomplete. Plain typed `@name` text is left unchanged. In WhatsApp groups, a real `@all` mention becomes Discord `@everyone`; real Discord `@everyone` or `@here` becomes WhatsApp `@all`. Plain typed versions are never promoted to group-wide mentions.

### `/setdcprefix`

Set a static prefix for Discord-to-WhatsApp messages. Omit `prefix` to return to sender usernames.

Usage: `/setdcprefix prefix:[text]`

### `/dcprefix`

Toggle Discord sender prefixes on messages sent to WhatsApp.

Usage: `/dcprefix enabled:<true|false>`

### `/waprefix`

Toggle WhatsApp sender-name prefixes on messages mirrored to Discord.

Usage: `/waprefix enabled:<true|false>`

### `/waplatformsuffix`

Toggle the Android/iOS/Desktop/Web sender-platform suffix on WhatsApp messages mirrored to Discord.

Usage: `/waplatformsuffix enabled:<true|false>`

### `/hidephonenumbers`

Hide WhatsApp phone numbers on Discord, using stable pseudonyms when a real contact name is unavailable.

Usage: `/hidephonenumbers enabled:<true|false>`

### `/linkmention`

Link a WhatsApp contact to a Discord user so real WhatsApp mentions can ping that user. WA2DC also translates real Discord mentions back to WhatsApp when possible. PN and LID identifiers are both supported.

Usage: `/linkmention contact:<name, number, or JID> user:<@user>`

### `/unlinkmention`

Remove a WhatsApp-to-Discord mention link.

Usage: `/unlinkmention contact:<name, number, or JID>`

### `/mentionlinks`

List configured WhatsApp-to-Discord mention links.

Usage: `/mentionlinks`

### `/jidinfo`

Show known PN (`@s.whatsapp.net`) and LID (`@lid`) variants for a contact and whether they are linked for mentions. Use this command instead of inspecting the SQLite database manually.

Usage: `/jidinfo contact:<name, number, or JID>`

## Media and downloads

Defaults: WhatsApp-to-Discord media batches contain up to 10 attachments; WhatsApp audio remains in its original format; local downloads and the download server are disabled; pruning and link expiry are disabled; the server binds to `127.0.0.1:8080` and generates `localhost` URLs when enabled.

### `/waaudiomp3`

Toggle MP3 conversion for WhatsApp audio uploaded to Discord. Conversion requires `ffmpeg`; WA2DC falls back to the original file when conversion is unavailable or fails.

Usage: `/waaudiomp3 enabled:<true|false>`

### `/waupload`

Toggle whether Discord attachments are uploaded to WhatsApp instead of sent as links.

Usage: `/waupload enabled:<true|false>`

### `/waembeds`

Toggle mirroring supported Discord embed text and media to WhatsApp. Disabled by default.

Usage: `/waembeds enabled:<true|false>`

### `/localdownloads`

Toggle downloading WhatsApp attachments locally when they exceed Discord's configured upload limit.

Usage: `/localdownloads enabled:<true|false>`

### `/getdownloadmessage`

Show the current local-download notification template.

Usage: `/getdownloadmessage`

### `/setdownloadmessage`

Set the local-download notification template. Supported placeholders are `{abs}`, `{resolvedDownloadDir}`, `{downloadDir}`, `{fileName}`, and `{url}`.

Usage: `/setdownloadmessage message:<template text>`

### `/getdownloaddir`

Show the configured download directory.

Usage: `/getdownloaddir`

### `/setdownloaddir`

Set the download directory. Ensure the WA2DC runtime account can create and protect files there.

Usage: `/setdownloaddir path:<directory>`

### `/setdownloadlimit`

Set the maximum download-directory size in gigabytes. `0` disables size-based pruning.

Usage: `/setdownloadlimit size:<gigabytes>`

### `/setfilesizelimit`

Override the Discord upload-size threshold, in bytes, used to decide when local download handling is needed.

Usage: `/setfilesizelimit bytes:<positive integer>`

### `/setwamediaburstsize`

Set the number of WhatsApp attachments uploaded to Discord per batch. Valid values are 1–10; lower values can help slow or unreliable hosts.

Usage: `/setwamediaburstsize count:<1-10>`

### `/localdownloadserver`

Start or stop the built-in server for locally downloaded attachments. Exposing it beyond localhost requires deliberate bind, host, firewall, and TLS configuration.

Usage: `/localdownloadserver enabled:<true|false>`

### `/setlocaldownloadserverport`

Set the local download server port. Valid values are 1–65535.

Usage: `/setlocaldownloadserverport port:<1-65535>`

### `/setlocaldownloadserverhost`

Set the hostname or IP inserted into generated download URLs. This does not control the listening interface.

Usage: `/setlocaldownloadserverhost host:<hostname or IP>`

### `/setlocaldownloadserverbindhost`

Set the interface on which the local download server listens. `127.0.0.1` is local-only; `0.0.0.0` listens on all IPv4 interfaces.

Usage: `/setlocaldownloadserverbindhost host:<bind address>`

### `/setdownloadlinkttl`

Set signed download-link lifetime in seconds. `0` means links do not expire.

Usage: `/setdownloadlinkttl seconds:<zero or positive integer>`

### `/setdownloadmaxage`

Delete downloaded files older than the configured number of days. `0` disables age-based pruning.

Usage: `/setdownloadmaxage days:<zero or positive number>`

### `/setdownloadminfree`

Prune old downloads to keep at least the configured free disk space in gigabytes. `0` disables free-space pruning.

Usage: `/setdownloadminfree gb:<zero or positive number>`

### `/httpsdownloadserver`

Toggle HTTPS for the local download server. Configure a key and certificate before enabling it.

Usage: `/httpsdownloadserver enabled:<true|false>`

### `/sethttpscert`

Set the TLS private-key and certificate paths used by the local download server.

Usage: `/sethttpscert key_path:<key file> cert_path:<certificate file>`

## Messaging behavior

### `/deletes`

Toggle mirrored message deletions between Discord and WhatsApp.

Usage: `/deletes enabled:<true|false>`

### `/readreceipts`

Enable or disable bridge read-receipt notifications.

Usage: `/readreceipts enabled:<true|false>`

### `/dmreadreceipts`

Deliver enabled read receipts by direct message.

Usage: `/dmreadreceipts`

### `/publicreadreceipts`

Deliver enabled read receipts as short channel replies. This is the default mode.

Usage: `/publicreadreceipts`

### `/reactionreadreceipts`

Deliver enabled read receipts as ☑️ reactions.

Usage: `/reactionreadreceipts`

### `/publishing`

Toggle automatic cross-posting for messages sent into Discord announcement channels.

Usage: `/publishing enabled:<true|false>`

### `/changenotifications`

Toggle profile/status change alerts and WhatsApp Status mirroring into the linked `status@broadcast` target.

Usage: `/changenotifications enabled:<true|false>`

### `/oneway`

Set the bridge direction. `discord` sends only WhatsApp → Discord, `whatsapp` sends only Discord → WhatsApp, and `disabled` restores bidirectional bridging.

Usage: `/oneway direction:<discord|whatsapp|disabled>`

### `/redirectbots`

Toggle forwarding messages from other Discord bots to WhatsApp. Enabled by default.

Usage: `/redirectbots enabled:<true|false>`

### `/redirectwebhooks`

Toggle forwarding Discord webhook messages to WhatsApp. Disabled by default.

Usage: `/redirectwebhooks enabled:<true|false>`

### `/redirectannouncements`

Toggle forwarding Discord announcement/crosspost webhook messages to WhatsApp. Disabled by default.

Usage: `/redirectannouncements enabled:<true|false>`

Discord typing indicators are automatic when Discord-to-WhatsApp bridging is enabled. WhatsApp shows that the bridge account is typing, not which Discord user is typing.

## Maintenance

### `/ping`

Show the current Discord bot latency.

Usage: `/ping`

### `/help`

Show the WA2DC documentation link.

Usage: `/help`

### `/resync`

Refresh WhatsApp contacts and participating groups. Set `rename` to update linked Discord target names. The group refresh avoids downloading every participant roster.

Usage: `/resync rename:[true|false]`

### `/autosaveinterval`

Set how often WA2DC persists app state, in seconds. The default is 300 seconds.

Usage: `/autosaveinterval seconds:<positive integer>`

### `/lastmessagestorage`

Set how many recent message mappings remain available for edits, deletions, quotes, pins, and reactions. The default is 500.

Usage: `/lastmessagestorage size:<positive integer>`

### `/restart`

Persist state and request a safe restart. This command works only in the control channel and requires the watchdog runner; Docker relies on its container restart policy instead.

Usage: `/restart`

## Updates

The control channel contains persistent update, skip, and rollback controls. Source and Docker deployments receive notifications but update through their normal deployment workflow.

### `/updatechannel`

Switch between stable releases and prereleases.

Usage: `/updatechannel channel:<stable|unstable>`

### `/update`

Install the available signed update on a supported packaged binary. The executable and matching runtime sidecar are updated together. Unsupported source and Docker installs receive manual-update guidance.

Usage: `/update`

### `/checkupdate`

Check the active release channel immediately and refresh the persistent update card.

Usage: `/checkupdate`

### `/skipupdate`

Dismiss the current update notification without installing it.

Usage: `/skipupdate`

### `/rollback`

Restore the previous packaged executable and runtime sidecar when a backup is available. Docker and source deployments must roll back using their normal deployment tools.

Usage: `/rollback`
