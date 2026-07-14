# Frequently Asked Questions
Here you will find frequently asked questions on [GitHub issues](https://github.com/arespawn/WhatsAppToDiscord/issues)

## What is a whitelist?
A whitelist allows you to receive messages only from the conversations that are on the list. A blacklist would do the opposite, but WhatsApp already has that feature called blocking.

## Can I use this bot on a public server?
You can do whatever you want with the bot. Just make sure that you get the permissions right. You can enable Discord prefix and whitelist your school's/institution's WhatsApp group, basically creating a bridge between two platforms. Also, make sure that you restrict public access to `#control-room` so that people won't mess with the whitelist.

## Flagged as a virus
The bot is completely open-source, even the compilation is done publicly using [GitHub Actions](https://github.com/arespawn/WhatsAppToDiscord/actions). Is it possible for me to replace the binaries? Technically yes, but that would be a really bad reputation. I believe the main reason the bot gets flagged as a virus is the download count. This project is quite small, and it doesn't get many downloads. Microsoft SmartScreen also tries to deter users from running executables from unknown developers. A code signing certificate would probably help, but they are quite pricey and are not worth for an open-source project in my opinion. If you want to make sure nothing shady happens, you can simply clone the repo and compile/run your own version after inspecting the code.

## Negative or sky-high ping
This is due to the time difference between Discords' servers and your computer. As the ping is measured in milliseconds, even small differences can produce a huge/weird number. This can be fixed, but just syncing the time is an easier solution.

## Bot only responds with `Unknown command type help...`
This is due to [Discord Intents](https://discord.com/developers/docs/topics/gateway#privileged-intents). You have to enable message content intent. You can do this by going to [Discord Developer Portal](https://discord.com/developers/applications/) > Your Application > Bot > Scroll down > Enable *"MESSAGE CONTENT INTENT"*.

## Lost my bot token, how to regenerate one?
You can do this by going to [Discord Developer Portal](https://discord.com/developers/applications/) > Your Application > Bot > Click *"Reset Token"*. A new token will be issued. You can simply copy and paste it to the bot.

## Where do I type the commands?
When you invite the bot, it should create a text channel called `#control-room`. There, you can use all the [commands](commands.md).

## Can I host the bot on a server so that it runs on 7/24?
Possibly, but be aware you may get banned. On GitHub, I've seen two instances ([#1](https://github.com/FKLC/WhatsAppToDiscord/issues/75#issuecomment-1179018481), [#2](https://github.com/FKLC/WhatsAppToDiscord/issues/88#issuecomment-1229547828)) of running the bot on a server, and apparently, it is fine, but always be cautious.

## Sending voice messages on Discord
WA2DC can mirror Discord voice-style attachments to WhatsApp voice notes (`ptt`).

- For best compatibility, install `ffmpeg` on the host running WA2DC. The bridge will transcode Discord voice uploads to Opus/Ogg mono before sending.
- If `ffmpeg` is not installed, WA2DC still attempts a raw audio send, but some voice uploads may fail on WhatsApp clients.

## Why did a WhatsApp GIF arrive on Discord as a video?
WhatsApp usually exposes GIF sends as short `videoMessage` payloads flagged with `gifPlayback`, not as literal `.gif` files.

- For best compatibility, install `ffmpeg` on the host running WA2DC. The bridge will transcode WhatsApp GIF-playback videos into real Discord GIF attachments when possible.
- If `ffmpeg` is not installed or transcoding fails, WA2DC falls back to mirroring the original WhatsApp video attachment, so Discord may show a play button instead of an inline GIF.

## Why did a Discord image arrive on WhatsApp as a file?
WA2DC now normalizes static unsupported Discord image formats such as pasted WebP before sending them to WhatsApp. This normalization relies on `sharp`. If `sharp` is unavailable in the current runtime or the image still cannot be decoded safely, the bridge falls back to sending it as a regular document so the message is still delivered instead of being dropped.

GIF uploads prefer Discord's animated video rendition when Discord exposes both a file entry and a preview embed for the same media, so the same GIF should not be mirrored twice.

Discord stickers are now mirrored as real WhatsApp stickers when possible. Static and animated Discord stickers are converted to WhatsApp-safe WebP sticker payloads by the bridge runtime.

## Can I bridge WhatsApp calls to Discord?
No. The WhatsApp Web protocol used by the bot does not expose the real-time audio or video streams of a call. Incoming and missed calls are only sent as notifications to Discord, so the bot cannot relay or receive live WhatsApp calls.

## How do I change the log verbosity?
Set the `WA2DC_LOG_LEVEL` environment variable to one of `trace`, `debug`, `info`, `warn`, `error`, `fatal` or `silent` (default: `info`). Setting it to `debug` is useful for diagnosing connection or pairing issues. If you set an invalid value, the bot will fail to start.

## Is it possible to run on Docker?
Yes. You can build the image manually or use the provided `docker-compose.yml`. Copy `.env.example` to `.env`, set your Discord token inside and run `docker compose up -d` to start the container.

## How to build an executable of the program
The bot is built publicly on [GitHub actions](https://github.com/arespawn/WhatsAppToDiscord/actions), but here's a walkthrough of the whole process.
1. Install Node and NPM [here](https://nodejs.org/en/download).
1. Install Git [here](https://git-scm.com/downloads)
1. Execute the following commands to clone and enter bot's folder:
    1. `git clone https://github.com/arespawn/WhatsAppToDiscord.git`
    1. `cd WhatsAppToDiscord` 
1. Run `npm ci` to install dependencies
1. Run `npm run build:bin` to bundle + package for your current OS/CPU (output goes to `build/`)
    - Optional smoke test: `npm run build:bin:smoke`
1. Keep the generated `runtime/` folder next to the executable. Packaged builds use that sidecar for native modules such as `sharp`.
1. That's it. You will have your executable in the `build` folder.
