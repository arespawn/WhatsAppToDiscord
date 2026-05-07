import fs from "node:fs";
import * as baileys from "@whiskeysockets/baileys";
import discordJs from "discord.js";
import {
	getChatHostChannelId,
	getChatTargetChannelId,
	isThreadChatLink,
} from "./chatLinks.js";
import { createDiscordClient } from "./clientFactories.js";
import groupMetadataCache from "./groupMetadataCache.js";
import messageStore from "./messageStore.js";
import {
	getNewsletterAckError,
	getNewsletterMessageDebug,
	getNewsletterServerIdFromMessage,
	getPendingNewsletterSend,
	isLikelyNewsletterServerId,
	normalizeBridgeMessageId,
	resolveNewsletterServerIdForDiscordMessage,
	waitForNewsletterAckError,
	waitForNewsletterServerId,
} from "./newsletterBridge.js";
import {
	ONE_WAY_MODES,
	oneWayAllowsDiscordToWhatsApp,
	oneWayAllowsWhatsAppToDiscord,
} from "./oneWay.js";
import { resolveRestartFlagPath } from "./runnerLogic.js";
import state from "./state.js";
import storage from "./storage.js";
import utils from "./utils.js";

const {
	ActionRowBuilder,
	ApplicationCommandOptionType,
	ButtonBuilder,
	ButtonStyle,
	ChannelType,
	GatewayIntentBits,
	MessageFlags,
	MessageType,
} = discordJs;
const { getDevice } = baileys;

const DEFAULT_AVATAR_URL = "https://cdn.discordapp.com/embed/avatars/0.png";
const PIN_DURATION_PRESETS = {
	"24h": 24 * 60 * 60,
	"7d": 7 * 24 * 60 * 60,
	"30d": 30 * 24 * 60 * 60,
};
const AnnouncementChannelTypes = [ChannelType.GuildAnnouncement, "GUILD_NEWS"];
const TextBridgeChannelTypes = [
	ChannelType.GuildText,
	ChannelType.GuildAnnouncement,
	"GUILD_TEXT",
	"GUILD_NEWS",
];
const ThreadBridgeChannelTypes = [
	ChannelType.PublicThread,
	ChannelType.AnnouncementThread,
	"PUBLIC_THREAD",
	"ANNOUNCEMENT_THREAD",
];
const ForumChannelTypes = [ChannelType.GuildForum, "GUILD_FORUM"];
const ApplicationCommandOptionTypes = {
	STRING: ApplicationCommandOptionType.String,
	INTEGER: ApplicationCommandOptionType.Integer,
	NUMBER: ApplicationCommandOptionType.Number,
	BOOLEAN: ApplicationCommandOptionType.Boolean,
	CHANNEL: ApplicationCommandOptionType.Channel,
	ROLE: ApplicationCommandOptionType.Role,
	USER: ApplicationCommandOptionType.User,
};

const client = createDiscordClient({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.GuildMessageReactions,
		GatewayIntentBits.GuildMessageTyping,
		GatewayIntentBits.MessageContent,
	],
});
let controlChannel;
let slashRegisterWarned = false;
const pendingAlbums = {};
const deliveredMessages = new Set();
const BOT_PERMISSIONS = 536879120;
const UPDATE_BUTTON_IDS = utils.discord.updateButtonIds;
const ROLLBACK_BUTTON_ID = utils.discord.rollbackButtonId;
const bridgePinnedMessages = new Set();
const pinExpiryTimers = new Map();
const DISCORD_FORWARD_CONTEXT_TTL_MS = 5 * 60 * 1000;
const DISCORD_MESSAGE_LOCATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DISCORD_MESSAGE_LOCATION_MISS_TTL_MS = 10 * 1000;
const NEWSLETTER_SERVER_ID_WAIT_TIMEOUT_MS = 8000;
const NEWSLETTER_SERVER_ID_WAIT_POLL_MS = 150;
const NEWSLETTER_ACK_WAIT_WITH_SERVER_ID_MS = 2500;
const NEWSLETTER_ACK_WAIT_WITHOUT_SERVER_ID_MS = 8000;
const newsletterAckWaitMsForSentMessage = (sentMessage) =>
	getNewsletterServerIdFromMessage(sentMessage)
		? NEWSLETTER_ACK_WAIT_WITH_SERVER_ID_MS
		: NEWSLETTER_ACK_WAIT_WITHOUT_SERVER_ID_MS;
const discordForwardContextCache = new Map();
const discordForwardContextTimers = new Map();
const discordMessageLocationCache = new Map();
const discordMessageLocationTimers = new Map();
const discordMessageLocationMissCache = new Map();
const discordMessageLocationMissTimers = new Map();
const quotedWhatsAppMessageLocationCache = new Map();
const quotedWhatsAppMessageLocationTimers = new Map();
let restartInProgress = false;
const allowsWhatsAppToDiscord = () =>
	oneWayAllowsWhatsAppToDiscord(state.settings.oneWay);
const allowsDiscordToWhatsApp = () =>
	oneWayAllowsDiscordToWhatsApp(state.settings.oneWay);

const resolveDiscordMessageIdForWhatsAppId = (whatsAppMessageId) => {
	const normalizedWaMessageId = normalizeBridgeMessageId(whatsAppMessageId);
	if (!normalizedWaMessageId) {
		return null;
	}

	const direct = normalizeBridgeMessageId(
		state.lastMessages?.[normalizedWaMessageId],
	);
	if (direct && direct !== normalizedWaMessageId && direct !== "true") {
		return direct;
	}

	for (const [keyRaw, valueRaw] of Object.entries(state.lastMessages || {})) {
		if (normalizeBridgeMessageId(valueRaw) !== normalizedWaMessageId) continue;
		const candidate = normalizeBridgeMessageId(keyRaw);
		if (
			!candidate ||
			candidate === normalizedWaMessageId ||
			candidate === "true"
		)
			continue;
		return candidate;
	}

	return null;
};

const resolveChannelIdForJid = (jid) => {
	const normalizedJid = utils.whatsapp.formatJid(jid);
	return (
		getChatTargetChannelId(state.chats?.[normalizedJid]) ||
		getChatTargetChannelId(state.chats?.[jid]) ||
		null
	);
};

const getDiscordTargetMentionForJid = (jid) => {
	const targetChannelId =
		utils.discord.getChatTargetChannelId?.(jid) || resolveChannelIdForJid(jid);
	return targetChannelId ? `<#${targetChannelId}>` : null;
};

const getChatModeLabel = (chatLink = {}) =>
	isThreadChatLink(chatLink) ? "Thread" : "Channel";

const resolveManualLinkTarget = async (channel) => {
	if (!channel) {
		return {
			ok: false,
			error:
				"Please choose a regular text/news channel or a forum thread from the configured Discord server.",
		};
	}

	if (TextBridgeChannelTypes.includes(channel.type)) {
		return {
			ok: true,
			hostChannel: channel,
			targetChannel: channel,
			targetChannelId: channel.id,
			threadId: null,
		};
	}

	if (!ThreadBridgeChannelTypes.includes(channel.type)) {
		return {
			ok: false,
			error:
				"Only text/news channels or forum threads can be linked to WhatsApp chats.",
		};
	}

	const parentId = channel.parentId || channel.parent?.id;
	const parentChannel =
		channel.parent ||
		(parentId ? await utils.discord.getChannel(parentId) : null);
	if (!parentChannel || !ForumChannelTypes.includes(parentChannel.type)) {
		return {
			ok: false,
			error:
				"WA2DC only supports linking WhatsApp threads to forum threads, not raw text-channel threads.",
		};
	}

	return {
		ok: true,
		hostChannel: parentChannel,
		targetChannel: channel,
		targetChannelId: channel.id,
		threadId: channel.id,
	};
};

const buildChatLinkFromWebhook = (webhook, { threadId = null } = {}) => ({
	id: webhook.id,
	type: webhook.type,
	token: webhook.token,
	channelId: webhook.channelId,
	...(threadId ? { threadId } : {}),
});

const isWebhookSharedAcrossChats = (webhookId, exceptJid = null) =>
	Object.entries(state.chats || {}).some(
		([jid, chatLink]) =>
			jid !== exceptJid &&
			String(chatLink?.id || "") === String(webhookId || ""),
	);

const requestSafeRestart = async (
	ctx,
	{
		message = "Restarting...",
		exitCode = 0,
		reason = "manual",
		targetVersion = null,
	} = {},
) => {
	if (restartInProgress) {
		await ctx.reply("Restart already in progress.");
		return;
	}
	restartInProgress = true;
	state.shutdownRequested = true;

	try {
		await storage.save();
	} catch (err) {
		restartInProgress = false;
		state.shutdownRequested = false;
		state.logger?.error({ err }, "Failed to save state before restart");
		await ctx.reply("Failed to save state; restart aborted. Check logs.");
		return;
	}

	const flagPath = resolveRestartFlagPath(
		process.env.WA2DC_RESTART_FLAG_PATH,
		process.cwd(),
	);
	let flagWritten = true;
	let resolvedExitCode = exitCode;
	const restartPayload = JSON.stringify({
		reason,
		requestedAt: Date.now(),
		...(targetVersion ? { targetVersion } : {}),
	});
	try {
		await fs.promises.writeFile(flagPath, restartPayload, "utf8");
	} catch (err) {
		flagWritten = false;
		resolvedExitCode = resolvedExitCode === 0 ? 1 : resolvedExitCode;
		state.logger?.error(
			{ err, flagPath },
			"Failed to write restart flag; falling back to crash restart",
		);
	}

	const suffix = flagWritten
		? ""
		: " (restart flag write failed; falling back to crash restart)";
	try {
		await ctx.reply(`${message}${suffix}`);
	} catch (err) {
		state.logger?.warn?.(
			{ err },
			"Failed to send restart confirmation message",
		);
	}

	try {
		utils.stopDownloadServer();
	} catch (err) {
		void err;
	}
	try {
		void Promise.resolve(
			state.waClient?.end?.(new Error("Restart requested")),
		).catch(() => {});
	} catch (err) {
		void err;
	}
	try {
		state.waClient?.ws?.close?.();
	} catch (err) {
		void err;
	}
	try {
		state.dcClient?.destroy?.();
	} catch (err) {
		void err;
	}

	setTimeout(() => process.exit(resolvedExitCode), 250);
};

const getPinDurationSeconds = () => {
	const configured = Number(state.settings.PinDurationSeconds);
	if (Number.isFinite(configured) && configured > 0) {
		return configured;
	}
	return PIN_DURATION_PRESETS["7d"];
};

const schedulePinExpiryNotice = (message, durationSeconds) => {
	const durationMs = durationSeconds * 1000;
	if (!message || durationMs <= 0) {
		return;
	}
	const existing = pinExpiryTimers.get(message.id);
	if (existing) {
		clearTimeout(existing);
	}
	const timer = setTimeout(async () => {
		pinExpiryTimers.delete(message.id);
		let target = message;
		try {
			target = await message.fetch();
		} catch (err) {
			void err;
		}
		if (!target?.pinned) return;
		bridgePinnedMessages.add(target.id);
		try {
			await target.unpin();
		} catch (err) {
			void err;
		} finally {
			bridgePinnedMessages.delete(target.id);
		}
		await target.channel
			?.send(
				`Pin expired after ${Math.round(durationSeconds / 86400)} day${durationSeconds === 86400 ? "" : "s"}.`,
			)
			.catch(() => {});
	}, durationMs);
	pinExpiryTimers.set(message.id, timer);
};

const clearPinExpiryNotice = (messageId) => {
	const timer = pinExpiryTimers.get(messageId);
	if (timer) {
		clearTimeout(timer);
		pinExpiryTimers.delete(messageId);
	}
};

const clearTimedCacheEntry = (cache, timers, key) => {
	if (!key) return;
	const normalizedKey = String(key);
	const timer = timers.get(normalizedKey);
	if (timer) {
		clearTimeout(timer);
		timers.delete(normalizedKey);
	}
	cache.delete(normalizedKey);
};

const setTimedCacheEntry = (cache, timers, key, value, ttlMs) => {
	if (!key) return;
	const normalizedKey = String(key);
	clearTimedCacheEntry(cache, timers, normalizedKey);
	cache.set(normalizedKey, value);
	const timer = setTimeout(() => {
		cache.delete(normalizedKey);
		timers.delete(normalizedKey);
	}, ttlMs);
	timer?.unref?.();
	timers.set(normalizedKey, timer);
};

const consumeForwardContext = (messageId) => {
	if (!messageId) return null;
	const normalizedId = String(messageId);
	const context = discordForwardContextCache.get(normalizedId) || null;
	clearTimedCacheEntry(
		discordForwardContextCache,
		discordForwardContextTimers,
		normalizedId,
	);
	return context;
};

const buildDiscordMessageUrl = ({ guildId, channelId, messageId }) => {
	if (!guildId || !channelId || !messageId) return null;
	return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
};

const normalizeForwardSnapshotAttachment = (attachment, index = 0) => {
	if (!attachment || typeof attachment !== "object") return null;
	const url =
		attachment.url || attachment.proxy_url || attachment.proxyUrl || null;
	if (!url || typeof url !== "string") return null;
	const id = attachment.id ? String(attachment.id) : `${index + 1}`;
	const name = attachment.filename || attachment.name || `forwarded-${id}`;
	const contentType =
		attachment.content_type ||
		attachment.contentType ||
		"application/octet-stream";
	return {
		url,
		name,
		contentType,
	};
};

const normalizeForwardSnapshotEmbedMedia = (media = {}) => {
	if (!media || typeof media !== "object") return null;
	const url = media.url || null;
	const proxyURL = media.proxyURL || media.proxy_url || media.proxyUrl || null;
	if (!url && !proxyURL) return null;
	return {
		...(url ? { url } : {}),
		...(proxyURL ? { proxyURL } : {}),
	};
};

const normalizeForwardSnapshotEmbed = (embed = {}) => {
	if (!embed || typeof embed !== "object") return null;

	const fields = Array.isArray(embed.fields)
		? embed.fields
				.map((field = {}) => {
					if (!field || typeof field !== "object") return null;
					const name = typeof field.name === "string" ? field.name : "";
					const value = typeof field.value === "string" ? field.value : "";
					if (!name && !value) return null;
					return {
						...(name ? { name } : {}),
						...(value ? { value } : {}),
					};
				})
				.filter(Boolean)
		: [];
	const authorName = embed.author?.name;
	const footerText = embed.footer?.text;
	const providerName = embed.provider?.name;
	const image = normalizeForwardSnapshotEmbedMedia(embed.image);
	const video = normalizeForwardSnapshotEmbedMedia(embed.video);
	const thumbnail = normalizeForwardSnapshotEmbedMedia(embed.thumbnail);
	const normalized = {
		...(typeof authorName === "string" && authorName.trim()
			? { author: { name: authorName } }
			: {}),
		...(typeof embed.title === "string" && embed.title.trim()
			? { title: embed.title }
			: {}),
		...(typeof embed.description === "string" && embed.description.trim()
			? { description: embed.description }
			: {}),
		...(typeof embed.url === "string" && embed.url.trim()
			? { url: embed.url }
			: {}),
		...(fields.length ? { fields } : {}),
		...(typeof footerText === "string" && footerText.trim()
			? { footer: { text: footerText } }
			: {}),
		...(typeof providerName === "string" && providerName.trim()
			? { provider: { name: providerName } }
			: {}),
		...(image ? { image } : {}),
		...(video ? { video } : {}),
		...(thumbnail ? { thumbnail } : {}),
	};
	if (!Object.keys(normalized).length) return null;
	return normalized;
};

const extractForwardSnapshot = (rawData = {}) => {
	const snapshots = Array.isArray(rawData.message_snapshots)
		? rawData.message_snapshots
		: Array.isArray(rawData.messageSnapshots)
			? rawData.messageSnapshots
			: [];
	if (!snapshots.length) return null;

	const rawSnapshot = snapshots[0] || {};
	const snapshotMessage =
		rawSnapshot?.message && typeof rawSnapshot.message === "object"
			? rawSnapshot.message
			: rawSnapshot?.data && typeof rawSnapshot.data === "object"
				? rawSnapshot.data
				: rawSnapshot;

	const content =
		typeof snapshotMessage?.content === "string" ? snapshotMessage.content : "";
	const snapshotAttachments = Array.isArray(snapshotMessage?.attachments)
		? snapshotMessage.attachments
		: [];
	const attachments = snapshotAttachments
		.map((attachment, index) =>
			normalizeForwardSnapshotAttachment(attachment, index),
		)
		.filter(Boolean);
	const snapshotEmbeds = Array.isArray(snapshotMessage?.embeds)
		? snapshotMessage.embeds
		: [];
	const embeds = snapshotEmbeds
		.map((embed) => normalizeForwardSnapshotEmbed(embed))
		.filter(Boolean);

	if (!content && !attachments.length && !embeds.length) return null;
	return { content, attachments, ...(embeds.length ? { embeds } : {}) };
};

const cacheDiscordMessageLocation = (message, fallbackChannelId = null) => {
	const messageId = message?.id ? String(message.id) : null;
	if (!messageId) return;
	const channelId =
		message?.channelId || message?.channel?.id || fallbackChannelId || null;
	const guildId =
		message?.guildId || message?.guild?.id || state.settings.GuildID || null;
	const url =
		typeof message?.url === "string"
			? message.url
			: buildDiscordMessageUrl({ guildId, channelId, messageId });
	if (!channelId && !url) return;
	clearTimedCacheEntry(
		discordMessageLocationMissCache,
		discordMessageLocationMissTimers,
		messageId,
	);
	setTimedCacheEntry(
		discordMessageLocationCache,
		discordMessageLocationTimers,
		messageId,
		{ channelId: channelId || null, url: url || null },
		DISCORD_MESSAGE_LOCATION_TTL_MS,
	);
};

const getCachedQuotedWhatsAppMessageLocation = (
	whatsAppMessageId,
	discordMessageId = null,
) => {
	const normalizedWaId = normalizeBridgeMessageId(whatsAppMessageId);
	if (!normalizedWaId) return null;
	const cached = quotedWhatsAppMessageLocationCache.get(normalizedWaId);
	if (!cached) return null;
	const normalizedCachedDiscordId = normalizeBridgeMessageId(cached.discordId);
	const normalizedDiscordId = normalizeBridgeMessageId(discordMessageId);
	if (
		normalizedDiscordId &&
		normalizedCachedDiscordId &&
		normalizedDiscordId !== normalizedCachedDiscordId
	) {
		return null;
	}
	return cached;
};

const cacheQuotedWhatsAppMessageLocation = ({
	whatsAppMessageId,
	discordMessageId = null,
	location = null,
	fallbackChannelId = null,
} = {}) => {
	const normalizedWaId = normalizeBridgeMessageId(whatsAppMessageId);
	if (!normalizedWaId) return;

	const normalizedDiscordId = normalizeBridgeMessageId(discordMessageId);
	const cachedLocationByDiscordId = normalizedDiscordId
		? discordMessageLocationCache.get(normalizedDiscordId)
		: null;
	const resolvedLocation = location || cachedLocationByDiscordId || null;
	const channelId = resolvedLocation?.channelId || fallbackChannelId || null;
	const url =
		resolvedLocation?.url ||
		(normalizedDiscordId && channelId
			? buildDiscordMessageUrl({
					guildId: state.settings.GuildID || null,
					channelId,
					messageId: normalizedDiscordId,
				})
			: null);
	if (!channelId && !url && !normalizedDiscordId) return;

	setTimedCacheEntry(
		quotedWhatsAppMessageLocationCache,
		quotedWhatsAppMessageLocationTimers,
		normalizedWaId,
		{
			discordId: normalizedDiscordId || null,
			channelId: channelId || null,
			url: url || null,
		},
		DISCORD_MESSAGE_LOCATION_TTL_MS,
	);
};

const buildForwardContext = (message, rawContext = null) => {
	const isReplyMessage =
		message.type === MessageType.Reply || message.type === "REPLY";
	const fallbackIsForwarded = Boolean(message.reference && !isReplyMessage);
	const sourceChannelId =
		rawContext?.sourceChannelId || message.reference?.channelId || null;
	const sourceMessageId =
		rawContext?.sourceMessageId || message.reference?.messageId || null;
	const sourceGuildId =
		rawContext?.sourceGuildId || message.reference?.guildId || null;

	return {
		isForwarded: rawContext
			? Boolean(rawContext.isForwarded)
			: fallbackIsForwarded,
		sourceChannelId,
		sourceMessageId,
		sourceGuildId,
	};
};

const getMessageFlagsBitfield = (message = {}) => {
	if (typeof message?.flags === "number") return message.flags;
	if (typeof message?.flags?.bitfield === "number")
		return message.flags.bitfield;
	return 0;
};

const isBroadcastWebhookMessage = (message = {}) => {
	const flags = getMessageFlagsBitfield(message);
	const crosspostedMask = MessageFlags.Crossposted ?? 1;
	const isCrosspostMask = MessageFlags.IsCrosspost ?? 2;
	return (
		AnnouncementChannelTypes.includes(message?.channel?.type) ||
		(flags & crosspostedMask) !== 0 ||
		(flags & isCrosspostMask) !== 0
	);
};

const isBridgeWebhookId = (webhookId) => {
	if (!webhookId) return false;
	const normalized = String(webhookId);
	return Object.values(state.chats || {}).some(
		(chat) => String(chat?.id || "") === normalized,
	);
};

const collectSourceJidCandidates = async (sourceJid) => {
	const addCandidate = (set, value) => {
		const formatted = utils.whatsapp.formatJid(value);
		if (!formatted) return;
		set.add(formatted);
		const [userPart, serverPart] = formatted.split("@");
		if (
			(serverPart === "s.whatsapp.net" || serverPart === "lid") &&
			/^\d+$/.test(userPart)
		) {
			set.add(`${userPart}@${serverPart}`);
			set.add(`+${userPart}@${serverPart}`);
		}
	};

	const candidates = new Set();
	addCandidate(candidates, sourceJid);

	if (typeof utils.whatsapp.hydrateJidPair === "function") {
		try {
			const [primary, alternate] = await utils.whatsapp.hydrateJidPair(
				sourceJid,
				null,
			);
			addCandidate(candidates, primary);
			addCandidate(candidates, alternate);
		} catch (err) {
			state.logger?.debug?.({ err }, "Failed to hydrate forwarded source JID");
		}
	}

	if (typeof utils.whatsapp.resolveKnownJid === "function" && candidates.size) {
		const resolved = utils.whatsapp.resolveKnownJid(...candidates);
		addCandidate(candidates, resolved);
	}

	return [...candidates];
};

const resolveForwardSourceChannelId = async (sourceJid) => {
	if (!sourceJid) return null;
	const candidates = await collectSourceJidCandidates(sourceJid);
	for (const candidate of candidates) {
		const channelId = getChatTargetChannelId(state.chats?.[candidate]);
		if (channelId) return channelId;
	}
	return null;
};

const resolveForwardSourceFromQuote = async (message) => {
	const quotedWaId = normalizeBridgeMessageId(message?.quote?.id);
	const quotedSourceJid =
		message?.quote?.sourceJid || message?.quote?.remoteJid || null;
	const sourceChannelId = await resolveForwardSourceChannelId(quotedSourceJid);
	if (!quotedWaId && !quotedSourceJid) return null;

	const mappedDiscordIdRaw = quotedWaId
		? state.lastMessages?.[quotedWaId]
		: null;
	const mappedDiscordId = normalizeBridgeMessageId(mappedDiscordIdRaw);
	const cachedByQuotedWaId = quotedWaId
		? getCachedQuotedWhatsAppMessageLocation(quotedWaId, mappedDiscordId)
		: null;
	if (cachedByQuotedWaId?.channelId || cachedByQuotedWaId?.url) {
		return {
			channelId: cachedByQuotedWaId.channelId || sourceChannelId || null,
			url: cachedByQuotedWaId.url || null,
		};
	}
	if (!mappedDiscordId) {
		if (sourceChannelId) return { channelId: sourceChannelId, url: null };
		return null;
	}

	const cached = discordMessageLocationCache.get(mappedDiscordId);
	if (cached) {
		cacheQuotedWhatsAppMessageLocation({
			whatsAppMessageId: quotedWaId,
			discordMessageId: mappedDiscordId,
			location: cached,
			fallbackChannelId: sourceChannelId,
		});
		return {
			channelId: cached.channelId || sourceChannelId || null,
			url: cached.url || null,
		};
	}

	if (discordMessageLocationMissCache.has(mappedDiscordId)) {
		if (sourceChannelId) {
			const sourceChannel = await utils.discord.getChannel(sourceChannelId);
			const sourceFound = await sourceChannel?.messages
				?.fetch?.(mappedDiscordId)
				.catch(() => null);
			if (sourceFound) {
				cacheDiscordMessageLocation(sourceFound, sourceChannelId);
				const resolved = discordMessageLocationCache.get(mappedDiscordId);
				if (resolved) {
					cacheQuotedWhatsAppMessageLocation({
						whatsAppMessageId: quotedWaId,
						discordMessageId: mappedDiscordId,
						location: resolved,
						fallbackChannelId: sourceChannelId,
					});
					return {
						channelId: resolved.channelId || sourceChannelId,
						url: resolved.url || null,
					};
				}
			}
		}
		if (sourceChannelId) return { channelId: sourceChannelId, url: null };
		return null;
	}

	const channelIds = [];
	const seenChannelIds = new Set();
	const pushChannelId = (channelId) => {
		if (!channelId || seenChannelIds.has(channelId)) return;
		seenChannelIds.add(channelId);
		channelIds.push(channelId);
	};
	pushChannelId(sourceChannelId);
	pushChannelId(cachedByQuotedWaId?.channelId || null);
	for (const channelId of Object.values(state.chats || {})
		.map((chat) => getChatTargetChannelId(chat))
		.filter(Boolean)) {
		pushChannelId(channelId);
	}

	for (const channelId of channelIds) {
		const channel = await utils.discord.getChannel(channelId);
		if (!channel?.messages?.fetch) continue;

		const found = await channel.messages
			.fetch(mappedDiscordId)
			.catch(() => null);
		if (!found) continue;
		cacheDiscordMessageLocation(found, channelId);
		const resolved = discordMessageLocationCache.get(mappedDiscordId);
		if (resolved) {
			cacheQuotedWhatsAppMessageLocation({
				whatsAppMessageId: quotedWaId,
				discordMessageId: mappedDiscordId,
				location: resolved,
				fallbackChannelId: sourceChannelId || channelId,
			});
			return {
				channelId: resolved.channelId || sourceChannelId || channelId,
				url: resolved.url || null,
			};
		}
		const fallbackLocation = {
			channelId,
			url: buildDiscordMessageUrl({
				guildId: found.guildId || state.settings.GuildID || null,
				channelId,
				messageId: mappedDiscordId,
			}),
		};
		cacheQuotedWhatsAppMessageLocation({
			whatsAppMessageId: quotedWaId,
			discordMessageId: mappedDiscordId,
			location: fallbackLocation,
			fallbackChannelId: sourceChannelId || channelId,
		});
		return {
			channelId: fallbackLocation.channelId,
			url: fallbackLocation.url,
		};
	}

	setTimedCacheEntry(
		discordMessageLocationMissCache,
		discordMessageLocationMissTimers,
		mappedDiscordId,
		true,
		DISCORD_MESSAGE_LOCATION_MISS_TTL_MS,
	);
	if (sourceChannelId) return { channelId: sourceChannelId, url: null };

	return null;
};

class CommandResponder {
	constructor({ interaction, channel }) {
		this.interaction = interaction;
		this.channel = channel;
		this.replied = false;
		this.deferred = false;
		this.firstEditSent = false;
		this.ephemeral = interaction
			? interaction.channelId !== state.settings.ControlChannelID
			: false;
	}

	async defer() {
		if (!this.interaction || this.deferred || this.replied) {
			return;
		}
		await this.interaction.deferReply({ ephemeral: this.ephemeral });
		this.deferred = true;
		this.replied = true;
	}

	async send(payload) {
		const normalized =
			typeof payload === "string" ? { content: payload } : payload;
		if (this.interaction) {
			if (this.deferred) {
				if (!this.firstEditSent) {
					const reply = await this.interaction.editReply(normalized);
					this.firstEditSent = true;
					return reply;
				}
				return this.interaction.followUp({
					...normalized,
					ephemeral: this.ephemeral,
				});
			}
			if (!this.replied) {
				const reply = await this.interaction.reply({
					...normalized,
					ephemeral: this.ephemeral,
				});
				this.replied = true;
				return reply;
			}
			return this.interaction.followUp({
				...normalized,
				ephemeral: this.ephemeral,
			});
		}

		return this.channel?.send(normalized);
	}

	async sendPartitioned(text) {
		const parts = utils.discord.partitionText(text || "");
		for (const part of parts) {
			await this.send(part);
		}
	}
}

class CommandContext {
	constructor({ interaction, responder }) {
		this.interaction = interaction;
		this.responder = responder;
	}

	get channel() {
		return this.interaction?.channel ?? null;
	}

	get createdTimestamp() {
		return this.interaction?.createdTimestamp ?? Date.now();
	}

	get isControlChannel() {
		return this.channel?.id === state.settings.ControlChannelID;
	}

	async reply(payload) {
		return this.responder.send(payload);
	}

	async replyPartitioned(text) {
		return this.responder.sendPartitioned(text);
	}

	async defer() {
		return this.responder.defer();
	}

	getStringOption(name) {
		return this.interaction?.options?.getString(name);
	}

	getBooleanOption(name) {
		return this.interaction?.options?.getBoolean(name);
	}

	getIntegerOption(name) {
		return this.interaction?.options?.getInteger(name);
	}

	getNumberOption(name) {
		return this.interaction?.options?.getNumber(name);
	}

	getChannelOption(name) {
		return this.interaction?.options?.getChannel(name);
	}

	getRoleOption(name) {
		return this.interaction?.options?.getRole(name);
	}

	getUserOption(name) {
		return this.interaction?.options?.getUser(name);
	}
}

const sendWhatsappMessage = async (
	message,
	mediaFiles = [],
	messageIds = [],
) => {
	let msgContent = "";
	const files = [];
	const largeFiles = [];
	let components = [];
	const normalizedChannelJid =
		utils.whatsapp.formatJid(message.channelJid) || message.channelJid;
	const webhook = await utils.discord.getOrCreateChannel(message.channelJid);
	const linkedTargetChannelId =
		getChatTargetChannelId(state.chats?.[normalizedChannelJid]) ||
		webhook?.wa2dcTargetChannelId ||
		webhook?.channelId ||
		null;
	const avatarURL = message.profilePic || DEFAULT_AVATAR_URL;
	const mentionIdsRaw = Array.isArray(message?.discordMentions)
		? message.discordMentions
		: [];
	const mentionIds = [
		...new Set(
			mentionIdsRaw.map((id) => String(id)).filter((id) => /^\d+$/.test(id)),
		),
	];
	const mentionEveryone = message?.discordMentionEveryone === true;
	const allowedMentions = {
		parse: mentionEveryone ? ["everyone"] : [],
		...(mentionIds.length ? { users: mentionIds } : {}),
	};
	const content = utils.discord.convertWhatsappFormatting(message.content);
	const quoteContent = message.quote
		? utils.discord.convertWhatsappFormatting(message.quote.content)
		: null;
	const forwardedSource = message.isForwarded
		? await resolveForwardSourceFromQuote(message)
		: null;

	if (message.isGroup && state.settings.WAGroupPrefix) {
		msgContent += `[${message.name}] `;
	}

	if (message.isForwarded) {
		const lines = ["Forwarded"];
		if (forwardedSource?.channelId) {
			lines.push(`Source: <#${forwardedSource.channelId}>`);
		}
		if (forwardedSource?.url) {
			lines.push(`Jump: ${forwardedSource.url}`);
		}
		const forwardedBody = (content || "").split("\n").join("\n> ");
		if (forwardedBody) {
			lines.push(`> ${forwardedBody}`);
		}
		msgContent += lines.join("\n");
	} else if (message.quote) {
		const lines = [];

		const qContentRaw = quoteContent ?? "";
		const qContent = qContentRaw ? qContentRaw.split("\n").join("\n> ") : "";
		if (message.quote.name || qContent) {
			let quoteLine = "> ";
			if (message.quote.name) {
				quoteLine += message.quote.name;
				quoteLine += qContent ? ": " : ":";
			}
			if (qContent) {
				quoteLine += qContent;
			}
			lines.push(quoteLine.trimEnd());
		}

		let segment = lines.join("\n");
		if (content) {
			segment += (segment ? "\n" : "") + content;
		}
		msgContent += segment || content || "";

		if (message.quote.file) {
			if (message.quote.file.largeFile && state.settings.LocalDownloads) {
				largeFiles.push(message.quote.file);
			} else if (message.quote.file === -1 && !state.settings.LocalDownloads) {
				msgContent +=
					"WA2DC Attention: Received a file, but it's over Discord's upload limit. Check WhatsApp on your phone or enable local downloads.";
			} else {
				files.push(message.quote.file);
			}
		}
	} else {
		msgContent += content;
	}

	for (const file of mediaFiles) {
		if (file.largeFile && state.settings.LocalDownloads) {
			largeFiles.push(file);
		} else if (file === -1 && !state.settings.LocalDownloads) {
			msgContent +=
				"WA2DC Attention: Received a file, but it's over Discord's upload limit. Check WhatsApp on your phone or enable local downloads.";
		} else if (file !== -1) {
			files.push(file);
		}
	}

	if (!msgContent && !files.length && largeFiles.length) {
		const count = largeFiles.length;
		msgContent = `WA2DC: Received ${count} attachment${count === 1 ? "" : "s"} larger than Discord's upload limit. Download link${count === 1 ? "" : "s"} will be posted shortly.`;
	}

	if (
		message.isPoll &&
		Array.isArray(message.pollOptions) &&
		message.pollOptions.length
	) {
		const note =
			"\n\nPoll voting is only available on WhatsApp. Please vote from your phone.";
		msgContent = (msgContent || message.content || "Poll") + note;
		components = [];
	}

	if (state.settings.WASenderPlatformSuffix) {
		const idForDevice =
			typeof messageIds?.[0] === "string" ? messageIds[0] : message?.id;
		let platformLabel = null;
		if (typeof idForDevice === "string" && idForDevice.trim()) {
			try {
				const device = getDevice(idForDevice);
				if (device === "ios") platformLabel = "iOS";
				else if (device === "web") platformLabel = "Web";
				else if (device === "android") platformLabel = "Android";
				else if (device === "desktop") platformLabel = "Desktop";
			} catch {
				platformLabel = null;
			}
		}

		if (platformLabel) {
			const tag = `*(${platformLabel})*`;
			if (msgContent) {
				msgContent = `${msgContent}\n\n${tag}`;
			} else if (files.length || largeFiles.length) {
				msgContent = tag;
			}
		}
	}

	if (msgContent) {
		const normalization = utils.discord.ensureExplicitUrlScheme(msgContent);
		msgContent = normalization.text;
	}

	if (message.isEdit) {
		const dcMessageId = state.lastMessages[message.id];
		if (dcMessageId) {
			try {
				await utils.discord.safeWebhookEdit(
					webhook,
					dcMessageId,
					{ content: msgContent || null, components, allowedMentions },
					message.channelJid,
				);
				return;
			} catch (err) {
				state.logger?.error(err);
			}
		}
		msgContent = `Edited message:\n${msgContent}`;
		const dcMessage = await utils.discord.safeWebhookSend(
			webhook,
			{
				content: msgContent,
				username: message.name,
				avatarURL,
				components,
				allowedMentions,
			},
			message.channelJid,
		);
		cacheDiscordMessageLocation(dcMessage, linkedTargetChannelId);
		if (message.id != null) {
			state.lastMessages[dcMessage.id] = message.id;
		}
		return;
	}

	if (msgContent || files.length) {
		msgContent = utils.discord.partitionText(msgContent);
		while (msgContent.length > 1) {
			await utils.discord.safeWebhookSend(
				webhook,
				{
					content: msgContent.shift(),
					username: message.name,
					avatarURL,
					components,
					allowedMentions,
				},
				message.channelJid,
			);
		}

		const chunkArray = (arr, size) => {
			const chunks = [];
			for (let i = 0; i < arr.length; i += size) {
				chunks.push(arr.slice(i, i + size));
			}
			return chunks;
		};

		const fileChunks = utils.discord.chunkWebhookFilesForSend(files);
		const normalizedMessageIds = [
			...new Set(
				(messageIds.length ? messageIds : [message.id])
					.map((id) => normalizeBridgeMessageId(id))
					.filter(Boolean),
			),
		];
		const idChunks = chunkArray(normalizedMessageIds, 10);

		if (!fileChunks.length) fileChunks.push([]);

		let lastDcMessage;
		for (let i = 0; i < fileChunks.length; i += 1) {
			const sendArgs = {
				content: i === 0 ? msgContent.shift() || null : null,
				username: message.name,
				files: fileChunks[i],
				avatarURL,
				components,
				allowedMentions,
			};
			lastDcMessage = await utils.discord.safeWebhookSend(
				webhook,
				sendArgs,
				message.channelJid,
			);
			cacheDiscordMessageLocation(lastDcMessage, linkedTargetChannelId);
			const lastDiscordMessageId = normalizeBridgeMessageId(lastDcMessage?.id);
			if (!lastDiscordMessageId) {
				state.logger?.warn?.(
					{ jid: message.channelJid },
					"Skipped WhatsApp message mapping because Discord webhook response had no message ID",
				);
				continue;
			}

			if (
				i === 0 &&
				AnnouncementChannelTypes.includes(lastDcMessage?.channel?.type) &&
				state.settings.Publish
			) {
				await lastDcMessage.crosspost();
			}

			const waIdsForChunk = idChunks[i] || [];
			for (const waId of waIdsForChunk) {
				state.lastMessages[waId] = lastDiscordMessageId;
				cacheQuotedWhatsAppMessageLocation({
					whatsAppMessageId: waId,
					discordMessageId: lastDiscordMessageId,
					fallbackChannelId: linkedTargetChannelId,
				});
			}
			if (i === 0) {
				const primaryWaId =
					waIdsForChunk[0] ||
					normalizedMessageIds[0] ||
					normalizeBridgeMessageId(message?.id);
				if (primaryWaId) {
					state.lastMessages[lastDiscordMessageId] = primaryWaId;
				}
			}
		}

		if (largeFiles.length) {
			const placeholders = [];
			for (const file of largeFiles) {
				const placeholder = await utils.discord.safeWebhookSend(
					webhook,
					{
						content: `WA2DC: downloading "${file?.name || "attachment"}"...`,
						username: message.name,
						avatarURL,
						components: [],
					},
					message.channelJid,
				);
				placeholders.push(placeholder);
			}

			void (async () => {
				for (let i = 0; i < largeFiles.length; i += 1) {
					const file = largeFiles[i];
					const placeholder = placeholders[i];
					let downloadMessage;
					try {
						downloadMessage = await utils.discord.downloadLargeFile(file);
					} catch (err) {
						state.logger?.error(
							{ err },
							"Failed to download large WhatsApp attachment for local serving",
						);
						downloadMessage = `WA2DC Attention: Failed to download "${file?.name || "attachment"}". Please check WhatsApp.`;
					}
					const content =
						String(downloadMessage || "")
							.replace(/^\n+/, "")
							.trim() ||
						"WA2DC Attention: Download completed, but no message was generated.";
					try {
						await utils.discord.safeWebhookEdit(
							webhook,
							placeholder.id,
							{ content },
							message.channelJid,
						);
					} catch (err) {
						state.logger?.warn?.(
							{ err },
							"Failed to update local-download placeholder message",
						);
					}
				}
			})();
		}
	}
};

const flushAlbum = async (key) => {
	const album = pendingAlbums[key];
	if (!album) return;
	clearTimeout(album.timer);
	delete pendingAlbums[key];
	try {
		await sendWhatsappMessage(album.message, album.files, album.ids);
	} catch (err) {
		state.logger?.error({ err }, "Failed to forward WhatsApp album to Discord");
	}
};

const setControlChannel = async () => {
	controlChannel = await utils.discord.getControlChannel();
};

client.on("ready", async () => {
	await setControlChannel();
	await registerSlashCommands();
});

const removeDeletedLinkedChannel = (channel) => {
	const targetJids = utils.discord.channelIdToJids?.(channel?.id) || [];
	const hostJids = utils.discord.hostChannelIdToJids?.(channel?.id) || [];
	for (const jid of [...new Set([...targetJids, ...hostJids])]) {
		delete state.chats[jid];
		delete state.goccRuns[jid];
	}
};

client.on("channelDelete", async (channel) => {
	if (channel.id === state.settings.ControlChannelID) {
		controlChannel = await utils.discord.getControlChannel();
	} else {
		removeDeletedLinkedChannel(channel);
		state.settings.Categories = state.settings.Categories.filter(
			(id) => channel.id !== id,
		);
	}
});

client.on("threadDelete", (thread) => {
	removeDeletedLinkedChannel(thread);
});

const WA_TYPING_IDLE_MS = 12_000;
const WA_TYPING_REFRESH_MS = 8_000;
const WA_TYPING_MIN_SEND_GAP_MS = 3_000;

const typingPresenceSessions = new Map();

const endTypingPresenceSession = (channelId) => {
	const session = typingPresenceSessions.get(channelId);
	if (!session) return;
	typingPresenceSessions.delete(channelId);

	if (session.idleTimer) clearTimeout(session.idleTimer);
	if (session.refreshTimer) clearInterval(session.refreshTimer);

	state.waClient?.sendPresenceUpdate?.("paused", session.jid).catch(() => {});
};

const maybeSendComposingPresence = (channelId) => {
	const session = typingPresenceSessions.get(channelId);
	if (!session || !session.jid) return;
	if (!state.waClient?.sendPresenceUpdate) return;

	const now = Date.now();
	if (now - session.lastComposingSentAt < WA_TYPING_MIN_SEND_GAP_MS) return;
	session.lastComposingSentAt = now;

	state.waClient.sendPresenceUpdate("composing", session.jid).catch(() => {});
};

const noteDiscordTypingInChannel = (channelId, jid) => {
	const now = Date.now();
	let session = typingPresenceSessions.get(channelId);
	if (!session) {
		session = {
			jid,
			lastActivityAt: now,
			lastComposingSentAt: 0,
			idleTimer: null,
			refreshTimer: null,
		};
		typingPresenceSessions.set(channelId, session);
	} else {
		session.jid = jid;
		session.lastActivityAt = now;
	}

	maybeSendComposingPresence(channelId);

	if (session.idleTimer) clearTimeout(session.idleTimer);
	session.idleTimer = setTimeout(
		() => endTypingPresenceSession(channelId),
		WA_TYPING_IDLE_MS,
	);
	session.idleTimer?.unref?.();

	if (session.refreshTimer) return;
	session.refreshTimer = setInterval(() => {
		const current = typingPresenceSessions.get(channelId);
		if (!current) {
			clearInterval(session.refreshTimer);
			return;
		}

		const age = Date.now() - current.lastActivityAt;
		if (age >= WA_TYPING_IDLE_MS) {
			endTypingPresenceSession(channelId);
			return;
		}
		if (Date.now() - current.lastComposingSentAt >= WA_TYPING_REFRESH_MS) {
			maybeSendComposingPresence(channelId);
		}
	}, WA_TYPING_REFRESH_MS);
	session.refreshTimer?.unref?.();
};

client.on("typingStart", async (typing) => {
	if (!allowsDiscordToWhatsApp()) return;

	const user = typing?.user;
	if (user?.bot) return;
	if (user?.id && client.user?.id && user.id === client.user.id) return;

	const channelId = typing?.channel?.id;
	const jid = channelId ? utils.discord.channelIdToJid(channelId) : null;
	if (!jid || !state.waClient?.sendPresenceUpdate) return;

	noteDiscordTypingInChannel(channelId, jid);
});

client.on("whatsappMessage", async (message) => {
	if (!allowsWhatsAppToDiscord()) {
		return;
	}
	try {
		const key = `${message.channelJid}:${message.name}`;

		if (message.file && !message.isEdit) {
			if (pendingAlbums[key]) {
				pendingAlbums[key].files.push(message.file);
				pendingAlbums[key].ids.push(message.id);
				clearTimeout(pendingAlbums[key].timer);
				pendingAlbums[key].timer = setTimeout(() => flushAlbum(key), 500);
				return;
			}
			pendingAlbums[key] = {
				message,
				files: [message.file],
				ids: [message.id],
				timer: setTimeout(() => flushAlbum(key), 500),
			};
			return;
		}

		if (pendingAlbums[key]) {
			await flushAlbum(key);
		}

		await sendWhatsappMessage(message, message.file ? [message.file] : []);
	} catch (err) {
		state.logger?.error({ err }, "Failed to process incoming WhatsApp message");
	}
});

client.on("whatsappReaction", async (reaction) => {
	if (!allowsWhatsAppToDiscord()) {
		state.logger?.debug?.(
			{
				jid: reaction?.jid,
				id: normalizeBridgeMessageId(reaction?.id),
				oneWay: state.settings?.oneWay,
			},
			"Skipping WhatsApp reaction mirror due to one-way settings",
		);
		return;
	}

	const normalizedReactionId = normalizeBridgeMessageId(reaction?.id);
	const normalizedReactionJid = utils.whatsapp.formatJid(reaction?.jid);
	const channelId = resolveChannelIdForJid(normalizedReactionJid);
	const messageId = resolveDiscordMessageIdForWhatsAppId(normalizedReactionId);
	if (channelId == null || messageId == null) {
		state.logger?.debug?.(
			{
				jid: normalizedReactionJid,
				id: normalizedReactionId,
				channelId: channelId || null,
				messageId: messageId || null,
			},
			"Skipping WhatsApp reaction mirror due to missing channel/message mapping",
		);
		return;
	}

	try {
		const channel = await utils.discord.getChannel(channelId);
		if (!channel?.messages?.fetch) {
			state.logger?.warn?.(
				{
					jid: normalizedReactionJid,
					id: normalizedReactionId,
					channelId,
				},
				"Skipping WhatsApp reaction mirror because Discord channel is unavailable",
			);
			return;
		}
		const cachedMessage =
			typeof channel?.messages?.cache?.get === "function"
				? channel.messages.cache.get(messageId)
				: null;
		const message =
			cachedMessage ||
			(await channel.messages.fetch(messageId).catch(() => null));
		if (!message) {
			state.logger?.debug?.(
				{
					jid: normalizedReactionJid,
					id: normalizedReactionId,
					channelId,
					messageId,
				},
				"Skipping WhatsApp reaction mirror because Discord message lookup failed",
			);
			return;
		}
		if (!state.reactions[messageId]) {
			state.reactions[messageId] = {};
		}
		const msgReactions = state.reactions[messageId];
		const isNewsletterSynthetic =
			typeof reaction.author === "string" &&
			reaction.author.startsWith("newsletter:");
		if (
			isNewsletterSynthetic &&
			!reaction.text &&
			reaction.author.split(":").length < 3
		) {
			const prefix = `${reaction.author}:`;
			for (const [authorKey, emoji] of Object.entries(msgReactions)) {
				if (!authorKey.startsWith(prefix)) continue;
				await message.reactions.cache
					.get(emoji)
					?.remove()
					.catch(() => {});
				delete msgReactions[authorKey];
			}
		}
		const prev = msgReactions[reaction.author];
		if (prev) {
			await message.reactions.cache
				.get(prev)
				?.remove()
				.catch(() => {});
			delete msgReactions[reaction.author];
		}
		if (reaction.text) {
			await message.react(reaction.text).catch(async (err) => {
				if (err.code === 10014) {
					await channel.send(
						`Unknown emoji reaction (${reaction.text}) received. Check WhatsApp app to see it.`,
					);
				}
			});
			msgReactions[reaction.author] = reaction.text;
		}
		if (!Object.keys(msgReactions).length) {
			delete state.reactions[messageId];
		}
	} catch (err) {
		state.logger?.error?.(
			{
				err,
				jid: normalizedReactionJid,
				id: normalizedReactionId,
				channelId,
				messageId,
			},
			"Failed to mirror WhatsApp reaction to Discord",
		);
	}
});

client.on("whatsappRead", async ({ id, jid }) => {
	if (!allowsWhatsAppToDiscord() || !state.settings.ReadReceipts) {
		return;
	}
	const channelId = getChatTargetChannelId(state.chats[jid]);
	const messageId = state.lastMessages[id];
	if (!channelId || !messageId || deliveredMessages.has(messageId)) {
		return;
	}
	deliveredMessages.add(messageId);
	const channel = await utils.discord.getChannel(channelId);
	const message = await channel.messages.fetch(messageId).catch(() => null);
	if (!message) {
		return;
	}
	const receiptMode = state.settings.ReadReceiptMode;

	if (message.webhookId) {
		await message.react("☑️").catch(() => {});
		return;
	}

	if (receiptMode === "dm") {
		const name = utils.whatsapp.jidToName(jid);
		const messageContent = (
			message.cleanContent ??
			message.content ??
			""
		).trim();
		let quote = null;

		if (messageContent) {
			const truncated =
				messageContent.length > 1800
					? `${messageContent.slice(0, 1797)}...`
					: messageContent;
			quote = truncated
				.split("\n")
				.map((line) => `> ${line || " "}`)
				.join("\n");
		} else if (message.attachments?.size) {
			const attachments = [...message.attachments.values()].map(
				(attachment) => attachment.name || attachment.url,
			);
			const [firstAttachment, ...restAttachments] = attachments;
			quote = `> [Attachment] ${firstAttachment}`;
			if (restAttachments.length) {
				quote += `\n> ... (${restAttachments.length} more attachment${restAttachments.length === 1 ? "" : "s"})`;
			}
		} else {
			quote = "> *(No text content)*";
		}

		const receiptLines = [`✅ Your message to ${name} was read.`];
		if (quote) {
			receiptLines.push("", quote);
		}
		if (message.url) {
			receiptLines.push("", message.url);
		}

		message.author.send(receiptLines.join("\n")).catch(() => {});
		return;
	}

	if (receiptMode === "reaction") {
		await message.react("☑️").catch(() => {});
		return;
	}

	const receipt = await channel
		.send({ content: "✅ Read", reply: { messageReference: messageId } })
		.catch(() => null);
	if (receipt) {
		setTimeout(() => receipt.delete().catch(() => {}), 5000);
	}
});

client.on("whatsappDelete", async ({ id, jid }) => {
	if (!state.settings.DeleteMessages || !allowsWhatsAppToDiscord()) {
		return;
	}

	const messageId = state.lastMessages[id];
	if (state.chats[jid] == null || messageId == null) {
		return;
	}

	const webhook = await utils.discord.getOrCreateChannel(jid);
	try {
		await utils.discord.safeWebhookDelete(webhook, messageId, jid);
	} catch {
		try {
			await utils.discord.safeWebhookEdit(
				webhook,
				messageId,
				{ content: "Message Deleted" },
				jid,
			);
		} catch (err) {
			state.logger?.error(err);
		}
	}
	delete state.lastMessages[id];
	delete state.lastMessages[messageId];
	clearTimedCacheEntry(
		quotedWhatsAppMessageLocationCache,
		quotedWhatsAppMessageLocationTimers,
		id,
	);
	clearTimedCacheEntry(
		quotedWhatsAppMessageLocationCache,
		quotedWhatsAppMessageLocationTimers,
		messageId,
	);
	clearTimedCacheEntry(
		discordMessageLocationCache,
		discordMessageLocationTimers,
		messageId,
	);
	clearTimedCacheEntry(
		discordMessageLocationMissCache,
		discordMessageLocationMissTimers,
		messageId,
	);
});

client.on("whatsappCall", async ({ call, jid }) => {
	if (!allowsWhatsAppToDiscord()) {
		return;
	}

	const webhook = await utils.discord.getOrCreateChannel(jid);

	const name = utils.whatsapp.jidToName(jid);
	const callType = call.isVideo ? "video" : "voice";
	let content = "";

	switch (call.status) {
		case "offer":
			content = `${name} is ${callType} calling you! Check your phone to respond.`;
			break;
		case "timeout":
			content = `Missed a ${callType} call from ${name}!`;
			break;
	}

	if (content !== "") {
		const avatarURL =
			(await utils.whatsapp.getProfilePic(call)) || DEFAULT_AVATAR_URL;
		await utils.discord.safeWebhookSend(
			webhook,
			{
				content,
				username: name,
				avatarURL,
			},
			jid,
		);
	}
});

client.on("whatsappPin", async ({ jid, key, pinned }) => {
	if (!allowsWhatsAppToDiscord()) {
		return;
	}
	const channelId = getChatTargetChannelId(state.chats[jid]);
	const dcMessageId = state.lastMessages[key.id];
	if (!channelId || !dcMessageId) {
		return;
	}
	const channel = await utils.discord.getChannel(channelId);
	const message = await channel.messages.fetch(dcMessageId).catch(() => null);
	if (!message) {
		return;
	}
	bridgePinnedMessages.add(message.id);
	try {
		if (pinned) {
			await message.pin();
			schedulePinExpiryNotice(message, getPinDurationSeconds());
		} else {
			await message.unpin();
			clearPinExpiryNotice(message.id);
		}
	} catch (err) {
		state.logger?.warn({ err }, "Failed to sync WhatsApp pin to Discord");
	} finally {
		setTimeout(() => bridgePinnedMessages.delete(message.id), 5000);
	}
});

const isNewsletterJid = (jid = "") =>
	typeof jid === "string" && jid.endsWith("@newsletter");
const NEWSLETTER_CREATE_QUERY_ID =
	baileys.QueryIds?.CREATE || "8823471724422422";
const NEWSLETTER_CREATE_DATA_PATH =
	baileys.XWAPaths?.xwa2_newsletter_create || "xwa2_newsletter_create";
const WMEX_SERVER_JID = baileys.S_WHATSAPP_NET || "s.whatsapp.net";

const parseNewsletterTextValue = (value) => {
	if (typeof value === "string") {
		return value;
	}
	if (value && typeof value === "object" && typeof value.text === "string") {
		return value.text;
	}
	return undefined;
};

const toFiniteInteger = (value) => {
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : undefined;
};

const normalizeNewsletterCreateResult = (
	rawResult,
	{ fallbackName = "", fallbackDescription = "" } = {},
) => {
	const result =
		rawResult && typeof rawResult === "object"
			? rawResult.result && typeof rawResult.result === "object"
				? rawResult.result
				: rawResult
			: {};
	const thread =
		result.thread_metadata && typeof result.thread_metadata === "object"
			? result.thread_metadata
			: {};
	const viewer =
		result.viewer_metadata && typeof result.viewer_metadata === "object"
			? result.viewer_metadata
			: {};
	const name =
		parseNewsletterTextValue(thread.name) ||
		parseNewsletterTextValue(result.name) ||
		fallbackName;
	const description =
		parseNewsletterTextValue(thread.description) ??
		parseNewsletterTextValue(result.description) ??
		(fallbackDescription || undefined);
	const pictureRaw =
		thread.picture && typeof thread.picture === "object"
			? thread.picture
			: null;
	const picture = pictureRaw
		? {
				...(typeof pictureRaw.id === "string" ? { id: pictureRaw.id } : {}),
				...(typeof pictureRaw.direct_path === "string"
					? { directPath: pictureRaw.direct_path }
					: {}),
			}
		: undefined;

	return {
		...result,
		...(name ? { name } : {}),
		...(typeof description === "string" ? { description } : {}),
		...(typeof thread.creation_time !== "undefined"
			? { creation_time: toFiniteInteger(thread.creation_time) }
			: {}),
		...(typeof thread.subscribers_count !== "undefined"
			? { subscribers: toFiniteInteger(thread.subscribers_count) }
			: {}),
		...(typeof thread.invite === "string" ? { invite: thread.invite } : {}),
		...(typeof thread.verification === "string"
			? { verification: thread.verification }
			: {}),
		...(picture && Object.keys(picture).length ? { picture } : {}),
		...(typeof viewer.mute === "string" ? { mute_state: viewer.mute } : {}),
		...(Object.keys(thread).length
			? { thread_metadata: thread, threadMetadata: thread }
			: {}),
		...(Object.keys(viewer).length
			? { viewer_metadata: viewer, viewerMetadata: viewer }
			: {}),
	};
};

const executeWMexQueryCompat = async (
	waClient,
	variables,
	queryId,
	dataPath,
) => {
	if (
		typeof waClient?.query !== "function" ||
		typeof waClient?.generateMessageTag !== "function"
	) {
		throw new Error("Raw w:mex query is unavailable on this WhatsApp client.");
	}
	const resultNode = await waClient.query({
		tag: "iq",
		attrs: {
			id: waClient.generateMessageTag(),
			type: "get",
			to: WMEX_SERVER_JID,
			xmlns: "w:mex",
		},
		content: [
			{
				tag: "query",
				attrs: { query_id: queryId },
				content: Buffer.from(JSON.stringify({ variables }), "utf-8"),
			},
		],
	});
	const child =
		typeof baileys.getBinaryNodeChild === "function"
			? baileys.getBinaryNodeChild(resultNode, "result")
			: Array.isArray(resultNode?.content)
				? resultNode.content.find((entry) => entry?.tag === "result")
				: null;
	const rawPayload = child?.content;
	if (typeof rawPayload === "undefined") {
		throw new Error(
			"Failed to run newsletter create query: missing result payload.",
		);
	}
	const payloadBuffer = Buffer.isBuffer(rawPayload)
		? rawPayload
		: rawPayload instanceof Uint8Array
			? Buffer.from(rawPayload)
			: Buffer.from(String(rawPayload), "utf-8");
	let payload;
	try {
		payload = JSON.parse(payloadBuffer.toString());
	} catch (err) {
		throw new Error("Failed to parse newsletter create query payload.", {
			cause: err,
		});
	}

	const errors = Array.isArray(payload?.errors) ? payload.errors : [];
	if (errors.length > 0) {
		const errorMessages = errors
			.map((entry) => entry?.message || "Unknown error")
			.join(", ");
		throw new Error(
			`GraphQL server error: ${errorMessages || "Unknown error"}`,
		);
	}

	const response = dataPath ? payload?.data?.[dataPath] : payload?.data;
	if (typeof response === "undefined") {
		throw new Error(
			"Failed to run newsletter create query: unexpected response structure.",
		);
	}
	return response;
};

const createNewsletterCompat = async (createNewsletter, name, description) => {
	const hasRawQuerySupport =
		typeof state.waClient?.query === "function" &&
		typeof state.waClient?.generateMessageTag === "function";
	if (!hasRawQuerySupport) {
		return createNewsletter(name, description);
	}
	const rawResponse = await executeWMexQueryCompat(
		state.waClient,
		{
			input: {
				name,
				description: description || null,
			},
		},
		NEWSLETTER_CREATE_QUERY_ID,
		NEWSLETTER_CREATE_DATA_PATH,
	);
	return normalizeNewsletterCreateResult(rawResponse, {
		fallbackName: name,
		fallbackDescription: description,
	});
};

const formatJsonForReply = (value) => {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
};

const formatNewsletterJidForReply = (jid) =>
	utils.whatsapp.formatJidForDisplay(jid) || jid;

const parseNewsletterInvite = (value) => {
	const trimmed = typeof value === "string" ? value.trim() : "";
	if (!trimmed) return null;

	const tryParseUrl = (raw) => {
		try {
			return new URL(raw);
		} catch {
			return null;
		}
	};

	const parsed = tryParseUrl(trimmed);
	if (parsed) {
		const rawPath = parsed.pathname || "";
		const parts = rawPath.split("/").filter(Boolean);
		const channelIdx = parts.findIndex(
			(part) => part.toLowerCase() === "channel",
		);
		const codeFromPath = channelIdx >= 0 ? parts[channelIdx + 1] || "" : "";
		const code = (parsed.searchParams.get("code") || codeFromPath || "").trim();
		return {
			code: code || null,
			link: trimmed,
			raw: trimmed,
		};
	}

	return {
		code: trimmed,
		link: `https://whatsapp.com/channel/${encodeURIComponent(trimmed)}`,
		raw: trimmed,
	};
};

const extractNewsletterInviteFromMetadata = (metadata = {}) => {
	const candidates = [
		metadata?.invite,
		metadata?.inviteLink,
		metadata?.invite_link,
		metadata?.threadMetadata?.invite,
		metadata?.threadMetadata?.inviteLink,
		metadata?.threadMetadata?.invite_link,
		metadata?.thread_metadata?.invite,
		metadata?.thread_metadata?.inviteLink,
		metadata?.thread_metadata?.invite_link,
	];
	for (const candidate of candidates) {
		const parsed = parseNewsletterInvite(candidate);
		if (parsed) return parsed;
	}
	return null;
};

const extractNewsletterJid = (result) => {
	const candidates = [
		result?.jid,
		result?.id,
		result?.newsletterJid,
		result?.newsletter_jid,
		result?.newsletterId,
		result?.newsletter?.jid,
		result?.newsletter?.id,
		result?.newsletterMetadata?.id,
		result?.newsletter_metadata?.id,
		result?.threadMetadata?.id,
		result?.thread_metadata?.id,
	];
	for (const candidate of candidates) {
		const normalized = utils.whatsapp.formatJid(candidate);
		if (isNewsletterJid(normalized)) {
			return normalized;
		}
	}
	return null;
};

const resolveNewsletterJidFromCommand = async (
	ctx,
	{ optionName = "jid" } = {},
) => {
	const rawOption = ctx.getStringOption(optionName);
	let jid = null;
	if (rawOption) {
		jid = utils.whatsapp.formatJid(
			utils.whatsapp.toJid(rawOption) || rawOption,
		);
	} else {
		jid = utils.whatsapp.formatJid(
			utils.discord.channelIdToJid(ctx.channel?.id),
		);
	}

	if (!jid) {
		await ctx.reply(
			"This command must run in a channel linked to a newsletter, or include `jid:<...@newsletter>`.",
		);
		return null;
	}
	if (!isNewsletterJid(jid)) {
		await ctx.reply(
			`\`${formatNewsletterJidForReply(jid)}\` is not a WhatsApp newsletter JID.`,
		);
		return null;
	}
	return jid;
};

const resolveNewsletterJidFromInviteOption = async (
	ctx,
	{ optionName = "invite" } = {},
) => {
	const rawOption = ctx.getStringOption(optionName);
	if (!rawOption) {
		return null;
	}

	const invite = parseNewsletterInvite(rawOption);
	const inviteCode = invite?.code?.trim();
	if (!inviteCode) {
		await ctx.reply("Could not parse a newsletter invite code from `invite`.");
		return null;
	}

	const fetchMetadata = await requireNewsletterMethod(
		ctx,
		"newsletterMetadata",
	);
	if (!fetchMetadata) {
		return null;
	}

	let metadata;
	try {
		metadata = await fetchMetadata("invite", inviteCode);
	} catch (err) {
		state.logger?.error(
			{ err, inviteCode },
			"Failed to resolve newsletter invite metadata",
		);
		await ctx.reply(
			"Failed to resolve newsletter metadata from the provided invite.",
		);
		return null;
	}

	const jid = extractNewsletterJid(metadata || {});
	if (!jid) {
		await ctx.replyPartitioned(
			`Could not resolve a newsletter JID from invite \`${invite?.link || inviteCode}\`.\n\`\`\`json\n${formatJsonForReply(metadata)}\n\`\`\``,
		);
		return null;
	}
	return jid;
};

const resolveNewsletterJidForDebug = (ctx, { optionName = "jid" } = {}) => {
	const rawOption = ctx.getStringOption(optionName);
	if (rawOption) {
		const normalized = utils.whatsapp.formatJid(
			utils.whatsapp.toJid(rawOption) || rawOption,
		);
		return isNewsletterJid(normalized) ? normalized : null;
	}
	const channelLinkedJid = utils.whatsapp.formatJid(
		utils.discord.channelIdToJid(ctx.channel?.id),
	);
	return isNewsletterJid(channelLinkedJid) ? channelLinkedJid : null;
};

const collectMappedWhatsAppIdsForDiscordMessage = (discordMessageId) => {
	const normalizedDiscordMessageId = normalizeBridgeMessageId(discordMessageId);
	if (!normalizedDiscordMessageId) {
		return [];
	}
	const mapped = [];
	const direct = normalizeBridgeMessageId(
		state.lastMessages?.[normalizedDiscordMessageId],
	);
	if (direct && direct !== normalizedDiscordMessageId) {
		mapped.push(direct);
	}
	for (const [waIdRaw, dcIdRaw] of Object.entries(state.lastMessages || {})) {
		if (normalizeBridgeMessageId(dcIdRaw) !== normalizedDiscordMessageId)
			continue;
		const waId = normalizeBridgeMessageId(waIdRaw);
		if (!waId || waId === normalizedDiscordMessageId) continue;
		mapped.push(waId);
	}
	return [...new Set(mapped)];
};

const resolveUserJidOption = async (
	ctx,
	{ optionName = "user", description = "user" } = {},
) => {
	const rawOption = ctx.getStringOption(optionName)?.trim();
	if (!rawOption) {
		await ctx.reply(
			`Please provide ${description} via \`${optionName}:<...>\`.`,
		);
		return null;
	}

	const jid = utils.whatsapp.formatJid(
		utils.whatsapp.toJid(rawOption) || rawOption,
	);
	if (!jid) {
		await ctx.reply(`Could not resolve \`${rawOption}\` to a WhatsApp JID.`);
		return null;
	}

	return jid;
};

const requireNewsletterMethod = async (ctx, methodName) => {
	const method = state.waClient?.[methodName];
	if (typeof method !== "function") {
		await ctx.reply(
			`This WA2DC/Baileys build does not expose \`${methodName}()\` for newsletters.`,
		);
		return null;
	}
	return method.bind(state.waClient);
};

const getStringOrNumberOptionValue = (ctx, optionName) => {
	try {
		const stringValue = ctx.getStringOption(optionName);
		if (stringValue !== null && stringValue !== undefined) {
			return stringValue;
		}
	} catch {}

	try {
		const numberValue = ctx.getNumberOption(optionName);
		if (numberValue !== null && numberValue !== undefined) {
			return numberValue;
		}
	} catch {}

	try {
		const integerValue = ctx.getIntegerOption(optionName);
		if (integerValue !== null && integerValue !== undefined) {
			return integerValue;
		}
	} catch {}

	return null;
};

const normalizePairingPhoneNumber = (value) => {
	if (
		typeof value === "number" &&
		(!Number.isFinite(value) || !Number.isInteger(value))
	) {
		return null;
	}

	const raw = String(value ?? "").trim();
	if (!raw || !/^\+?[\d\s().-]+$/.test(raw)) {
		return null;
	}

	const digits = raw.replace(/\D/g, "");
	return /^[1-9]\d{6,14}$/.test(digits) ? digits : null;
};

const commandHandlers = {
	ping: {
		description: "Check the bot latency.",
		async execute(ctx) {
			await ctx.reply(`Pong ${Date.now() - ctx.createdTimestamp}ms!`);
		},
	},
	chatinfo: {
		description: "Show which WhatsApp chat this channel is linked to.",
		async execute(ctx) {
			const jid = utils.discord.channelIdToJid(ctx.channel?.id);
			if (!jid) {
				await ctx.reply("This channel is not linked to a WhatsApp chat.");
				return;
			}

			const name = utils.whatsapp.jidToName(jid);
			const displayJid = utils.whatsapp.formatJidForDisplay(jid) || jid;
			const chatLink = state.chats?.[jid] || {};
			const targetMention = getDiscordTargetMentionForJid(jid);
			const mode = getChatModeLabel(chatLink);
			const type =
				jid === "status@broadcast"
					? "Status"
					: jid.endsWith("@g.us")
						? "Group"
						: isNewsletterJid(jid)
							? "Newsletter"
							: "DM";

			const lines = [
				`Linked chat: **${name}**`,
				`JID: \`${displayJid}\``,
				`Type: ${type}`,
				`Discord target: ${targetMention || "Unknown"}`,
				`Link mode: ${mode}`,
			];
			if (isThreadChatLink(chatLink)) {
				lines.push(`Host forum: <#${getChatHostChannelId(chatLink)}>`);
			}
			await ctx.reply(lines.join("\n"));
		},
	},
	pairwithcode: {
		description: "Request a WhatsApp pairing code.",
		options: [
			{
				name: "phone",
				description: "Phone number with country code, such as +12025550123.",
				type: ApplicationCommandOptionTypes.STRING,
				required: true,
			},
		],
		async execute(ctx) {
			const rawNumber =
				getStringOrNumberOptionValue(ctx, "phone") ??
				getStringOrNumberOptionValue(ctx, "number");
			const number = normalizePairingPhoneNumber(rawNumber);
			if (!number) {
				await ctx.reply(
					"Please enter a phone number with country code, such as `+12025550123` or `12025550123`.",
				);
				return;
			}

			const code = await state.waClient.requestPairingCode(number);
			await ctx.reply(`Your pairing code is: ${code}`);
		},
	},
	start: {
		description: "Start a conversation with a contact or number.",
		options: [
			{
				name: "contact",
				description: "Number with country code or contact name.",
				type: ApplicationCommandOptionTypes.STRING,
				required: true,
			},
		],
		async execute(ctx) {
			const contact = ctx.getStringOption("contact");
			if (!contact) {
				await ctx.reply(
					"Please enter a phone number or name. Usage: `start <number with country code or name>`.",
				);
				return;
			}
			const jid = utils.whatsapp.toJid(contact);
			if (!jid) {
				await ctx.reply(`Couldn't find \`${contact}\`.`);
				return;
			}
			const webhook = await utils.discord.getOrCreateChannel(jid);
			if (!webhook) {
				await ctx.reply("Failed to start the conversation. Please try again.");
				return;
			}

			if (state.settings.Whitelist.length) {
				const normalized = utils.whatsapp.formatJid(jid);
				if (normalized && !state.settings.Whitelist.includes(normalized)) {
					state.settings.Whitelist.push(normalized);
				}
			}

			const channelMention =
				getDiscordTargetMentionForJid(utils.whatsapp.formatJid(jid) || jid) ||
				(webhook?.wa2dcTargetChannelId
					? `<#${webhook.wa2dcTargetChannelId}>`
					: webhook?.channelId
						? `<#${webhook.channelId}>`
						: "the linked channel");
			await ctx.reply(`Started a conversation in ${channelMention}.`);
		},
	},
	newslettercreate: {
		description:
			"Create a WhatsApp newsletter and link it to a Discord channel.",
		options: [
			{
				name: "name",
				description: "Newsletter name/title.",
				type: ApplicationCommandOptionTypes.STRING,
				required: true,
			},
			{
				name: "description",
				description: "Newsletter description.",
				type: ApplicationCommandOptionTypes.STRING,
				required: false,
			},
		],
		async execute(ctx) {
			const createNewsletter = await requireNewsletterMethod(
				ctx,
				"newsletterCreate",
			);
			if (!createNewsletter) {
				return;
			}

			const name = ctx.getStringOption("name")?.trim();
			const description = (ctx.getStringOption("description") || "").trim();
			if (!name) {
				await ctx.reply("Please provide a newsletter name.");
				return;
			}

			let result;
			try {
				result = await createNewsletterCompat(
					createNewsletter,
					name,
					description,
				);
			} catch (err) {
				state.logger?.error({ err }, "Failed to create newsletter");
				await ctx.reply(
					"Failed to create the newsletter. Please check logs and try again.",
				);
				return;
			}

			const newsletterJid = extractNewsletterJid(result);
			if (!newsletterJid) {
				await ctx.replyPartitioned(
					`Newsletter was created, but WA2DC could not detect the JID from the API response:\n\`\`\`json\n${formatJsonForReply(result)}\n\`\`\``,
				);
				return;
			}
			const newsletterName =
				result?.name ||
				result?.threadMetadata?.name ||
				result?.thread_metadata?.name ||
				name;
			if (newsletterName) {
				state.contacts[newsletterJid] = newsletterName;
				if (state.waClient?.contacts) {
					state.waClient.contacts[newsletterJid] = newsletterName;
				}
			}

			const webhook = await utils.discord.getOrCreateChannel(newsletterJid);
			if (!webhook) {
				await ctx.reply(
					`Newsletter created as \`${formatNewsletterJidForReply(newsletterJid)}\`, but channel linking failed.`,
				);
				return;
			}

			if (
				state.settings.Whitelist.length &&
				!state.settings.Whitelist.includes(newsletterJid)
			) {
				state.settings.Whitelist.push(newsletterJid);
			}

			const channelMention =
				getDiscordTargetMentionForJid(newsletterJid) ||
				(webhook?.wa2dcTargetChannelId
					? `<#${webhook.wa2dcTargetChannelId}>`
					: webhook?.channelId
						? `<#${webhook.channelId}>`
						: "the linked channel");
			await ctx.reply(
				`Created newsletter \`${formatNewsletterJidForReply(newsletterJid)}\` and linked it to ${channelMention}.`,
			);
		},
	},
	newsletterupdate: {
		description: "Update newsletter name/description.",
		options: [
			{
				name: "jid",
				description:
					"Target newsletter JID (optional if this channel is linked).",
				type: ApplicationCommandOptionTypes.STRING,
				required: false,
			},
			{
				name: "name",
				description: "New newsletter name.",
				type: ApplicationCommandOptionTypes.STRING,
				required: false,
			},
			{
				name: "description",
				description: "New newsletter description.",
				type: ApplicationCommandOptionTypes.STRING,
				required: false,
			},
		],
		async execute(ctx) {
			const updateNewsletter = await requireNewsletterMethod(
				ctx,
				"newsletterUpdate",
			);
			if (!updateNewsletter) {
				return;
			}
			const jid = await resolveNewsletterJidFromCommand(ctx);
			if (!jid) {
				return;
			}

			const name = ctx.getStringOption("name")?.trim();
			const description = ctx.getStringOption("description");
			const payload = {};
			if (name) {
				payload.name = name;
			}
			if (typeof description === "string") {
				payload.description = description.trim();
			}
			if (!Object.keys(payload).length) {
				await ctx.reply(
					"Provide at least one field to update: `name` and/or `description`.",
				);
				return;
			}

			try {
				await updateNewsletter(jid, payload);
			} catch (err) {
				state.logger?.error(
					{ err, jid, payload },
					"Failed to update newsletter",
				);
				await ctx.reply(
					`Failed to update newsletter \`${formatNewsletterJidForReply(jid)}\`.`,
				);
				return;
			}
			if (payload.name) {
				state.contacts[jid] = payload.name;
				if (state.waClient?.contacts) {
					state.waClient.contacts[jid] = payload.name;
				}
			}
			await ctx.reply(
				`Updated newsletter \`${formatNewsletterJidForReply(jid)}\`.`,
			);
		},
	},
	newsletterpicture: {
		description: "Set or remove a newsletter picture.",
		options: [
			{
				name: "mode",
				description: "Set a new picture or remove the current one.",
				type: ApplicationCommandOptionTypes.STRING,
				required: true,
				choices: [
					{ name: "set", value: "set" },
					{ name: "remove", value: "remove" },
				],
			},
			{
				name: "url",
				description: "Image URL (required for mode:set).",
				type: ApplicationCommandOptionTypes.STRING,
				required: false,
			},
			{
				name: "jid",
				description:
					"Target newsletter JID (optional if this channel is linked).",
				type: ApplicationCommandOptionTypes.STRING,
				required: false,
			},
		],
		async execute(ctx) {
			const jid = await resolveNewsletterJidFromCommand(ctx);
			if (!jid) {
				return;
			}
			const mode = ctx.getStringOption("mode");
			if (mode === "set") {
				const setPicture = await requireNewsletterMethod(
					ctx,
					"newsletterUpdatePicture",
				);
				if (!setPicture) {
					return;
				}
				const url = ctx.getStringOption("url")?.trim();
				if (!url) {
					await ctx.reply("`url` is required when `mode` is `set`.");
					return;
				}
				try {
					await setPicture(jid, { url });
				} catch (err) {
					state.logger?.error(
						{ err, jid },
						"Failed to update newsletter picture",
					);
					await ctx.reply(
						`Failed to update picture for \`${formatNewsletterJidForReply(jid)}\`.`,
					);
					return;
				}
				await ctx.reply(
					`Updated picture for \`${formatNewsletterJidForReply(jid)}\`.`,
				);
				return;
			}

			const removePicture = await requireNewsletterMethod(
				ctx,
				"newsletterRemovePicture",
			);
			if (!removePicture) {
				return;
			}
			try {
				await removePicture(jid);
			} catch (err) {
				state.logger?.error(
					{ err, jid },
					"Failed to remove newsletter picture",
				);
				await ctx.reply(
					`Failed to remove picture for \`${formatNewsletterJidForReply(jid)}\`.`,
				);
				return;
			}
			await ctx.reply(
				`Removed picture for \`${formatNewsletterJidForReply(jid)}\`.`,
			);
		},
	},
	newsletteradmincount: {
		description: "Get the admin count for a newsletter.",
		options: [
			{
				name: "jid",
				description:
					"Target newsletter JID (optional if this channel is linked).",
				type: ApplicationCommandOptionTypes.STRING,
				required: false,
			},
		],
		async execute(ctx) {
			const getAdminCount = await requireNewsletterMethod(
				ctx,
				"newsletterAdminCount",
			);
			if (!getAdminCount) {
				return;
			}
			const jid = await resolveNewsletterJidFromCommand(ctx);
			if (!jid) {
				return;
			}
			let result;
			try {
				result = await getAdminCount(jid);
			} catch (err) {
				state.logger?.error(
					{ err, jid },
					"Failed to fetch newsletter admin count",
				);
				await ctx.reply(
					`Failed to fetch admin count for \`${formatNewsletterJidForReply(jid)}\`.`,
				);
				return;
			}
			const count = Number(
				result?.count ?? result?.adminCount ?? result?.admins ?? result,
			);
			if (Number.isFinite(count)) {
				await ctx.reply(
					`Admin count for \`${formatNewsletterJidForReply(jid)}\`: ${count}`,
				);
				return;
			}
			await ctx.replyPartitioned(
				`Admin count response for \`${formatNewsletterJidForReply(jid)}\`:\n\`\`\`json\n${formatJsonForReply(result)}\n\`\`\``,
			);
		},
	},
	newslettersubscribers: {
		description: "Get subscriber count for a newsletter.",
		options: [
			{
				name: "jid",
				description:
					"Target newsletter JID (optional if this channel is linked).",
				type: ApplicationCommandOptionTypes.STRING,
				required: false,
			},
		],
		async execute(ctx) {
			const getSubscribers = await requireNewsletterMethod(
				ctx,
				"newsletterSubscribers",
			);
			if (!getSubscribers) {
				return;
			}
			const jid = await resolveNewsletterJidFromCommand(ctx);
			if (!jid) {
				return;
			}

			let result;
			try {
				result = await getSubscribers(jid);
			} catch (err) {
				state.logger?.error(
					{ err, jid },
					"Failed to fetch newsletter subscriber count",
				);
				await ctx.reply(
					`Failed to fetch subscribers for \`${formatNewsletterJidForReply(jid)}\`.`,
				);
				return;
			}

			const count = Number(result?.subscribers ?? result?.count ?? result);
			if (Number.isFinite(count)) {
				await ctx.reply(
					`Subscribers for \`${formatNewsletterJidForReply(jid)}\`: ${count}`,
				);
				return;
			}
			await ctx.replyPartitioned(
				`Subscriber response for \`${formatNewsletterJidForReply(jid)}\`:\n\`\`\`json\n${formatJsonForReply(result)}\n\`\`\``,
			);
		},
	},
	newsletterfollow: {
		description: "Follow a newsletter.",
		options: [
			{
				name: "jid",
				description:
					"Target newsletter JID (optional if this channel is linked).",
				type: ApplicationCommandOptionTypes.STRING,
				required: false,
			},
			{
				name: "invite",
				description:
					"Newsletter invite code or link (optional alternative to jid).",
				type: ApplicationCommandOptionTypes.STRING,
				required: false,
			},
		],
		async execute(ctx) {
			const followNewsletter = await requireNewsletterMethod(
				ctx,
				"newsletterFollow",
			);
			if (!followNewsletter) {
				return;
			}

			const rawJidOption = ctx.getStringOption("jid");
			const rawInviteOption = ctx.getStringOption("invite");
			const jid =
				rawJidOption || !rawInviteOption
					? await resolveNewsletterJidFromCommand(ctx)
					: await resolveNewsletterJidFromInviteOption(ctx);
			if (!jid) {
				return;
			}

			try {
				await followNewsletter(jid);
			} catch (err) {
				state.logger?.error({ err, jid }, "Failed to follow newsletter");
				await ctx.reply(
					`Failed to follow \`${formatNewsletterJidForReply(jid)}\`.`,
				);
				return;
			}
			await ctx.reply(`Followed \`${formatNewsletterJidForReply(jid)}\`.`);
		},
	},
	newsletterunfollow: {
		description: "Unfollow a newsletter.",
		options: [
			{
				name: "jid",
				description:
					"Target newsletter JID (optional if this channel is linked).",
				type: ApplicationCommandOptionTypes.STRING,
				required: false,
			},
		],
		async execute(ctx) {
			const unfollowNewsletter = await requireNewsletterMethod(
				ctx,
				"newsletterUnfollow",
			);
			if (!unfollowNewsletter) {
				return;
			}
			const jid = await resolveNewsletterJidFromCommand(ctx);
			if (!jid) {
				return;
			}

			try {
				await unfollowNewsletter(jid);
			} catch (err) {
				state.logger?.error({ err, jid }, "Failed to unfollow newsletter");
				await ctx.reply(
					`Failed to unfollow \`${formatNewsletterJidForReply(jid)}\`.`,
				);
				return;
			}
			await ctx.reply(`Unfollowed \`${formatNewsletterJidForReply(jid)}\`.`);
		},
	},
	newslettermute: {
		description: "Mute a newsletter.",
		options: [
			{
				name: "jid",
				description:
					"Target newsletter JID (optional if this channel is linked).",
				type: ApplicationCommandOptionTypes.STRING,
				required: false,
			},
		],
		async execute(ctx) {
			const muteNewsletter = await requireNewsletterMethod(
				ctx,
				"newsletterMute",
			);
			if (!muteNewsletter) {
				return;
			}
			const jid = await resolveNewsletterJidFromCommand(ctx);
			if (!jid) {
				return;
			}
			try {
				await muteNewsletter(jid);
			} catch (err) {
				state.logger?.error({ err, jid }, "Failed to mute newsletter");
				await ctx.reply(
					`Failed to mute \`${formatNewsletterJidForReply(jid)}\`.`,
				);
				return;
			}
			await ctx.reply(`Muted \`${formatNewsletterJidForReply(jid)}\`.`);
		},
	},
	newsletterunmute: {
		description: "Unmute a newsletter.",
		options: [
			{
				name: "jid",
				description:
					"Target newsletter JID (optional if this channel is linked).",
				type: ApplicationCommandOptionTypes.STRING,
				required: false,
			},
		],
		async execute(ctx) {
			const unmuteNewsletter = await requireNewsletterMethod(
				ctx,
				"newsletterUnmute",
			);
			if (!unmuteNewsletter) {
				return;
			}
			const jid = await resolveNewsletterJidFromCommand(ctx);
			if (!jid) {
				return;
			}
			try {
				await unmuteNewsletter(jid);
			} catch (err) {
				state.logger?.error({ err, jid }, "Failed to unmute newsletter");
				await ctx.reply(
					`Failed to unmute \`${formatNewsletterJidForReply(jid)}\`.`,
				);
				return;
			}
			await ctx.reply(`Unmuted \`${formatNewsletterJidForReply(jid)}\`.`);
		},
	},
	newsletterupdatename: {
		description: "Update newsletter name.",
		options: [
			{
				name: "name",
				description: "New newsletter name.",
				type: ApplicationCommandOptionTypes.STRING,
				required: true,
			},
			{
				name: "jid",
				description:
					"Target newsletter JID (optional if this channel is linked).",
				type: ApplicationCommandOptionTypes.STRING,
				required: false,
			},
		],
		async execute(ctx) {
			const updateName = await requireNewsletterMethod(
				ctx,
				"newsletterUpdateName",
			);
			if (!updateName) {
				return;
			}
			const jid = await resolveNewsletterJidFromCommand(ctx);
			if (!jid) {
				return;
			}

			const name = ctx.getStringOption("name")?.trim();
			if (!name) {
				await ctx.reply("Please provide a newsletter name.");
				return;
			}

			try {
				await updateName(jid, name);
			} catch (err) {
				state.logger?.error({ err, jid }, "Failed to update newsletter name");
				await ctx.reply(
					`Failed to update name for \`${formatNewsletterJidForReply(jid)}\`.`,
				);
				return;
			}
			state.contacts[jid] = name;
			if (state.waClient?.contacts) {
				state.waClient.contacts[jid] = name;
			}
			await ctx.reply(
				`Updated name for \`${formatNewsletterJidForReply(jid)}\`.`,
			);
		},
	},
	newsletterupdatedescription: {
		description: "Update newsletter description.",
		options: [
			{
				name: "description",
				description: "New newsletter description.",
				type: ApplicationCommandOptionTypes.STRING,
				required: true,
			},
			{
				name: "jid",
				description:
					"Target newsletter JID (optional if this channel is linked).",
				type: ApplicationCommandOptionTypes.STRING,
				required: false,
			},
		],
		async execute(ctx) {
			const updateDescription = await requireNewsletterMethod(
				ctx,
				"newsletterUpdateDescription",
			);
			if (!updateDescription) {
				return;
			}
			const jid = await resolveNewsletterJidFromCommand(ctx);
			if (!jid) {
				return;
			}

			const description = ctx.getStringOption("description");
			if (typeof description !== "string") {
				await ctx.reply("Please provide a newsletter description.");
				return;
			}

			try {
				await updateDescription(jid, description.trim());
			} catch (err) {
				state.logger?.error(
					{ err, jid },
					"Failed to update newsletter description",
				);
				await ctx.reply(
					`Failed to update description for \`${formatNewsletterJidForReply(jid)}\`.`,
				);
				return;
			}
			await ctx.reply(
				`Updated description for \`${formatNewsletterJidForReply(jid)}\`.`,
			);
		},
	},
	newslettermessages: {
		description: "Fetch recent messages from a newsletter.",
		options: [
			{
				name: "jid",
				description:
					"Target newsletter JID (optional if this channel is linked).",
				type: ApplicationCommandOptionTypes.STRING,
				required: false,
			},
			{
				name: "count",
				description: "How many messages to fetch (1-50, default 10).",
				type: ApplicationCommandOptionTypes.INTEGER,
				required: false,
			},
			{
				name: "before",
				description: "Optional upper timestamp bound (unix seconds).",
				type: ApplicationCommandOptionTypes.NUMBER,
				required: false,
			},
			{
				name: "after",
				description: "Optional lower timestamp bound (unix seconds).",
				type: ApplicationCommandOptionTypes.NUMBER,
				required: false,
			},
		],
		async execute(ctx) {
			const fetchMessages = await requireNewsletterMethod(
				ctx,
				"newsletterFetchMessages",
			);
			if (!fetchMessages) {
				return;
			}
			const jid = await resolveNewsletterJidFromCommand(ctx);
			if (!jid) {
				return;
			}

			const rawCount = ctx.getIntegerOption("count");
			const count = Math.max(
				1,
				Math.min(50, Number.isFinite(rawCount) ? rawCount : 10),
			);
			const beforeRaw = ctx.getNumberOption("before");
			const afterRaw = ctx.getNumberOption("after");
			const before = Number.isFinite(beforeRaw)
				? Math.trunc(beforeRaw)
				: undefined;
			const after = Number.isFinite(afterRaw)
				? Math.trunc(afterRaw)
				: undefined;

			let result;
			try {
				result = await fetchMessages(jid, count, before, after);
			} catch (err) {
				state.logger?.error(
					{ err, jid, count, before, after },
					"Failed to fetch newsletter messages",
				);
				await ctx.reply(
					`Failed to fetch messages for \`${formatNewsletterJidForReply(jid)}\`.`,
				);
				return;
			}

			const messages = Array.isArray(result)
				? result
				: Array.isArray(result?.messages)
					? result.messages
					: [];
			if (!messages.length) {
				await ctx.reply(
					`Fetched 0 messages for \`${formatNewsletterJidForReply(jid)}\` (count=${count}${before ? `, before=${before}` : ""}${after ? `, after=${after}` : ""}).`,
				);
				return;
			}

			const lines = [
				`Fetched ${messages.length} message(s) for \`${formatNewsletterJidForReply(jid)}\`.`,
			];
			messages.slice(0, 10).forEach((entry, idx) => {
				const id =
					entry?.id ||
					entry?.messageServerID ||
					entry?.server_id ||
					entry?.key?.id ||
					"unknown-id";
				const ts =
					entry?.timestamp || entry?.messageTimestamp || entry?.ts || null;
				lines.push(`${idx + 1}. id=${id}${ts ? ` ts=${ts}` : ""}`);
			});
			if (messages.length > 10) {
				lines.push(`...and ${messages.length - 10} more.`);
			}
			await ctx.replyPartitioned(lines.join("\n"));
		},
	},
	newslettermessagedebug: {
		description:
			"Inspect WA2DC mapping/debug data for a newsletter Discord message ID.",
		options: [
			{
				name: "messageid",
				description: "Discord message ID to inspect.",
				type: ApplicationCommandOptionTypes.STRING,
				required: true,
			},
			{
				name: "jid",
				description:
					"Target newsletter JID (optional if this channel is linked).",
				type: ApplicationCommandOptionTypes.STRING,
				required: false,
			},
		],
		async execute(ctx) {
			const rawMessageId = ctx.getStringOption("messageid")?.trim();
			if (!rawMessageId) {
				await ctx.reply("Please provide `messageid`.");
				return;
			}
			const normalizedDiscordMessageId = normalizeBridgeMessageId(rawMessageId);
			if (!normalizedDiscordMessageId) {
				await ctx.reply("Invalid `messageid`.");
				return;
			}

			const explicitJid = ctx.getStringOption("jid");
			const targetJid = resolveNewsletterJidForDebug(ctx);
			if (explicitJid && !targetJid) {
				await ctx.reply(
					"`jid` must be a valid newsletter JID (`...@newsletter`).",
				);
				return;
			}

			const waIds = collectMappedWhatsAppIdsForDiscordMessage(
				normalizedDiscordMessageId,
			);
			const directMappedId = normalizeBridgeMessageId(
				state.lastMessages?.[normalizedDiscordMessageId],
			);
			const resolvedServerId = resolveNewsletterServerIdForDiscordMessage(
				normalizedDiscordMessageId,
				directMappedId,
				state.lastMessages,
			);
			const linkedChannelId = targetJid
				? getChatTargetChannelId(state.chats?.[targetJid]) || null
				: null;
			const pendingByDiscordId = getPendingNewsletterSend({
				jid: targetJid || null,
				discordMessageId: normalizedDiscordMessageId,
			});
			const pendingByOutboundId =
				!pendingByDiscordId && directMappedId
					? getPendingNewsletterSend({
							jid: targetJid || null,
							outboundId: directMappedId,
						})
					: null;
			const pending = pendingByDiscordId || pendingByOutboundId || null;

			const ackErrors = {};
			const reverseMap = {};
			const sentMessageFlags = {};
			const idsToInspect = [
				...new Set([directMappedId, ...waIds].filter(Boolean)),
			];
			idsToInspect.forEach((id) => {
				reverseMap[id] =
					normalizeBridgeMessageId(state.lastMessages?.[id]) || null;
				sentMessageFlags[id] = state.sentMessages.has(id);
				const errorCode = getNewsletterAckError(id);
				if (errorCode) {
					ackErrors[id] = errorCode;
				}
			});

			const messageStoreEntries = [];
			if (targetJid) {
				idsToInspect.forEach((id) => {
					const stored = messageStore.get({ remoteJid: targetJid, id });
					if (!stored) return;
					messageStoreEntries.push({
						id,
						key: {
							id: normalizeBridgeMessageId(stored?.key?.id) || null,
							server_id:
								normalizeBridgeMessageId(
									stored?.key?.server_id || stored?.key?.serverId,
								) || null,
							remoteJid:
								utils.whatsapp.formatJid(stored?.key?.remoteJid) || null,
							fromMe:
								typeof stored?.key?.fromMe === "boolean"
									? stored.key.fromMe
									: null,
						},
						messageTimestamp: stored?.messageTimestamp ?? null,
						hasMessage: Boolean(stored?.message),
					});
				});
			}
			const operationHistory = getNewsletterMessageDebug({
				discordMessageId: normalizedDiscordMessageId,
				jid: targetJid || null,
				limit: 30,
			});

			const debugPayload = {
				discordMessageId: normalizedDiscordMessageId,
				newsletterJid: targetJid || null,
				linkedChannelId,
				directMappedId: directMappedId || null,
				directMappedIdLooksServer: isLikelyNewsletterServerId(directMappedId),
				resolvedServerId: isLikelyNewsletterServerId(resolvedServerId)
					? resolvedServerId
					: null,
				mappedWaIds: waIds,
				reverseMap,
				sentMessageFlags,
				ackErrors,
				pendingSend: pending
					? {
							jid: pending.jid || null,
							discordMessageId: pending.discordMessageId || null,
							outboundId: pending.outboundId || null,
							type: pending.type || "",
							text: pending.text || "",
							timestamp: pending.timestamp || null,
						}
					: null,
				messageStoreEntries,
				operationHistory,
			};

			const lines = [
				`Discord message ID: \`${normalizedDiscordMessageId}\``,
				`Newsletter JID: ${targetJid ? `\`${formatNewsletterJidForReply(targetJid)}\`` : "`(not provided / not linked channel)`"}`,
				`Direct map: \`${directMappedId || "(none)"}\``,
				`Resolved server ID: \`${isLikelyNewsletterServerId(resolvedServerId) ? resolvedServerId : "(none)"}\``,
				`Mapped WA IDs: ${waIds.length ? waIds.map((id) => `\`${id}\``).join(", ") : "(none)"}`,
			];
			if (Object.keys(ackErrors).length) {
				lines.push(
					`Ack errors: ${Object.entries(ackErrors)
						.map(([id, code]) => `\`${id}\` -> ${code}`)
						.join(", ")}`,
				);
			}
			if (pending) {
				lines.push(
					`Pending send: outbound=\`${pending.outboundId || "(none)"}\`, type=${pending.type || "(none)"}`,
				);
			}
			if (operationHistory.length) {
				const historyLine = operationHistory
					.slice(-5)
					.map(
						(entry) => `${entry.operation || "op"}:${entry.phase || "phase"}`,
					)
					.join(", ");
				lines.push(`Recent ops: ${historyLine}`);
			}
			lines.push(
				"",
				"Raw debug payload:",
				`\`\`\`json\n${formatJsonForReply(debugPayload)}\n\`\`\``,
			);
			await ctx.replyPartitioned(lines.join("\n"));
		},
	},
	newslettersubscribeupdates: {
		description: "Subscribe to newsletter live updates.",
		options: [
			{
				name: "jid",
				description:
					"Target newsletter JID (optional if this channel is linked).",
				type: ApplicationCommandOptionTypes.STRING,
				required: false,
			},
		],
		async execute(ctx) {
			const subscribeUpdates = await requireNewsletterMethod(
				ctx,
				"subscribeNewsletterUpdates",
			);
			if (!subscribeUpdates) {
				return;
			}
			const jid = await resolveNewsletterJidFromCommand(ctx);
			if (!jid) {
				return;
			}

			let result;
			try {
				result = await subscribeUpdates(jid);
			} catch (err) {
				state.logger?.error(
					{ err, jid },
					"Failed to subscribe to newsletter updates",
				);
				await ctx.reply(
					`Failed to subscribe to updates for \`${formatNewsletterJidForReply(jid)}\`.`,
				);
				return;
			}

			const duration = result?.duration;
			if (duration) {
				await ctx.reply(
					`Subscribed to live updates for \`${formatNewsletterJidForReply(jid)}\` (duration=${duration}).`,
				);
				return;
			}
			await ctx.reply(
				`Subscribed to live updates for \`${formatNewsletterJidForReply(jid)}\`.`,
			);
		},
	},
	newslettermetadata: {
		description: "Fetch newsletter metadata.",
		options: [
			{
				name: "jid",
				description:
					"Target newsletter JID (optional if this channel is linked).",
				type: ApplicationCommandOptionTypes.STRING,
				required: false,
			},
		],
		async execute(ctx) {
			const fetchMetadata = await requireNewsletterMethod(
				ctx,
				"newsletterMetadata",
			);
			if (!fetchMetadata) {
				return;
			}
			const jid = await resolveNewsletterJidFromCommand(ctx);
			if (!jid) {
				return;
			}

			let metadata;
			try {
				metadata = await fetchMetadata("jid", jid);
			} catch (err) {
				state.logger?.error(
					{ err, jid },
					"Failed to fetch newsletter metadata",
				);
				await ctx.reply(
					`Failed to fetch metadata for \`${formatNewsletterJidForReply(jid)}\`.`,
				);
				return;
			}

			const name =
				parseNewsletterTextValue(metadata?.name) ||
				parseNewsletterTextValue(metadata?.threadMetadata?.name) ||
				parseNewsletterTextValue(metadata?.thread_metadata?.name) ||
				utils.whatsapp.jidToName(jid);
			const description =
				parseNewsletterTextValue(metadata?.description) ||
				parseNewsletterTextValue(metadata?.threadMetadata?.description) ||
				parseNewsletterTextValue(metadata?.thread_metadata?.description) ||
				"";
			const viewerRole =
				metadata?.viewerMetadata?.role ||
				metadata?.viewer_metadata?.role ||
				"UNKNOWN";
			const lines = [
				`Newsletter: **${name || "Unknown"}**`,
				`JID: \`${formatNewsletterJidForReply(jid)}\``,
				`Viewer role: ${viewerRole}`,
			];
			if (description) {
				lines.push(`Description: ${description}`);
			}
			lines.push(
				"",
				"Raw metadata:",
				`\`\`\`json\n${formatJsonForReply(metadata)}\n\`\`\``,
			);
			await ctx.replyPartitioned(lines.join("\n"));
		},
	},
	newsletterinviteinfo: {
		description: "Show invite link/code for a newsletter.",
		options: [
			{
				name: "jid",
				description:
					"Target newsletter JID (optional if this channel is linked).",
				type: ApplicationCommandOptionTypes.STRING,
				required: false,
			},
		],
		async execute(ctx) {
			const fetchMetadata = await requireNewsletterMethod(
				ctx,
				"newsletterMetadata",
			);
			if (!fetchMetadata) {
				return;
			}
			const jid = await resolveNewsletterJidFromCommand(ctx);
			if (!jid) {
				return;
			}

			let metadata;
			try {
				metadata = await fetchMetadata("jid", jid);
			} catch (err) {
				state.logger?.error(
					{ err, jid },
					"Failed to fetch newsletter metadata for invite info",
				);
				await ctx.reply(
					`Failed to fetch invite info for \`${formatNewsletterJidForReply(jid)}\`.`,
				);
				return;
			}

			const inviteInfo = extractNewsletterInviteFromMetadata(metadata || {});
			if (!inviteInfo) {
				await ctx.reply(
					`No invite code/link is exposed for \`${formatNewsletterJidForReply(jid)}\` in the current metadata response.`,
				);
				return;
			}

			const lines = [`Newsletter: \`${formatNewsletterJidForReply(jid)}\``];
			if (inviteInfo.code) {
				lines.push(`Invite code: \`${inviteInfo.code}\``);
			}
			lines.push(`Invite link: ${inviteInfo.link}`);
			await ctx.replyPartitioned(lines.join("\n"));
		},
	},
	newsletterchangeowner: {
		description: "Change newsletter owner.",
		options: [
			{
				name: "user",
				description: "New owner WhatsApp JID/number.",
				type: ApplicationCommandOptionTypes.STRING,
				required: true,
			},
			{
				name: "jid",
				description:
					"Target newsletter JID (optional if this channel is linked).",
				type: ApplicationCommandOptionTypes.STRING,
				required: false,
			},
		],
		async execute(ctx) {
			const changeOwner = await requireNewsletterMethod(
				ctx,
				"newsletterChangeOwner",
			);
			if (!changeOwner) {
				return;
			}
			const jid = await resolveNewsletterJidFromCommand(ctx);
			if (!jid) {
				return;
			}
			const newOwnerJid = await resolveUserJidOption(ctx, {
				optionName: "user",
				description: "the new owner",
			});
			if (!newOwnerJid) {
				return;
			}

			try {
				await changeOwner(jid, newOwnerJid);
			} catch (err) {
				state.logger?.error(
					{ err, jid, newOwnerJid },
					"Failed to change newsletter owner",
				);
				await ctx.reply(
					`Failed to change owner for \`${formatNewsletterJidForReply(jid)}\`.`,
				);
				return;
			}
			await ctx.reply(
				`Changed owner for \`${formatNewsletterJidForReply(jid)}\` to \`${formatNewsletterJidForReply(newOwnerJid)}\`.`,
			);
		},
	},
	newsletterdemote: {
		description: "Demote a newsletter admin.",
		options: [
			{
				name: "user",
				description: "Admin WhatsApp JID/number to demote.",
				type: ApplicationCommandOptionTypes.STRING,
				required: true,
			},
			{
				name: "jid",
				description:
					"Target newsletter JID (optional if this channel is linked).",
				type: ApplicationCommandOptionTypes.STRING,
				required: false,
			},
		],
		async execute(ctx) {
			const demoteUser = await requireNewsletterMethod(ctx, "newsletterDemote");
			if (!demoteUser) {
				return;
			}
			const jid = await resolveNewsletterJidFromCommand(ctx);
			if (!jid) {
				return;
			}
			const userJid = await resolveUserJidOption(ctx, {
				optionName: "user",
				description: "the user to demote",
			});
			if (!userJid) {
				return;
			}

			try {
				await demoteUser(jid, userJid);
			} catch (err) {
				state.logger?.error(
					{ err, jid, userJid },
					"Failed to demote newsletter user",
				);
				await ctx.reply(
					`Failed to demote \`${formatNewsletterJidForReply(userJid)}\` for \`${formatNewsletterJidForReply(jid)}\`.`,
				);
				return;
			}
			await ctx.reply(
				`Demoted \`${formatNewsletterJidForReply(userJid)}\` for \`${formatNewsletterJidForReply(jid)}\`.`,
			);
		},
	},
	newsletterdelete: {
		description: "Delete a newsletter (irreversible).",
		options: [
			{
				name: "confirm",
				description: "Set to true to confirm deletion.",
				type: ApplicationCommandOptionTypes.BOOLEAN,
				required: true,
			},
			{
				name: "jid",
				description:
					"Target newsletter JID (optional if this channel is linked).",
				type: ApplicationCommandOptionTypes.STRING,
				required: false,
			},
		],
		async execute(ctx) {
			const deleteNewsletter = await requireNewsletterMethod(
				ctx,
				"newsletterDelete",
			);
			if (!deleteNewsletter) {
				return;
			}
			const confirmed = Boolean(ctx.getBooleanOption("confirm"));
			if (!confirmed) {
				await ctx.reply(
					"Deletion aborted. Re-run with `confirm:true` to delete the newsletter.",
				);
				return;
			}

			const jid = await resolveNewsletterJidFromCommand(ctx);
			if (!jid) {
				return;
			}

			try {
				await deleteNewsletter(jid);
			} catch (err) {
				state.logger?.error({ err, jid }, "Failed to delete newsletter");
				await ctx.reply(
					`Failed to delete \`${formatNewsletterJidForReply(jid)}\`.`,
				);
				return;
			}

			state.settings.Whitelist = state.settings.Whitelist.filter(
				(entry) => utils.whatsapp.formatJid(entry) !== jid,
			);
			delete state.chats[jid];
			delete state.goccRuns[jid];
			await ctx.reply(
				`Deleted newsletter \`${formatNewsletterJidForReply(jid)}\` and removed local bridge mapping.`,
			);
		},
	},
	poll: {
		description: "Create a WhatsApp poll in this channel.",
		options: [
			{
				name: "question",
				description: "Poll question/title.",
				type: ApplicationCommandOptionTypes.STRING,
				required: true,
			},
			{
				name: "options",
				description: "Comma-separated options (min 2).",
				type: ApplicationCommandOptionTypes.STRING,
				required: true,
			},
			{
				name: "select",
				description: "How many options can be selected.",
				type: ApplicationCommandOptionTypes.INTEGER,
				required: false,
			},
			{
				name: "announcement",
				description: "Send as an announcement-group poll.",
				type: ApplicationCommandOptionTypes.BOOLEAN,
				required: false,
			},
		],
		async execute(ctx) {
			const jid = utils.discord.channelIdToJid(ctx.channel?.id);
			if (!jid) {
				await ctx.reply(
					"This command only works in channels linked to WhatsApp chats.",
				);
				return;
			}
			const normalizedJid = utils.whatsapp.formatJid(jid) || jid;
			const question = ctx.getStringOption("question")?.trim();
			const rawOptions = ctx.getStringOption("options") || "";
			const values = rawOptions
				.split(",")
				.map((opt) => opt.trim())
				.filter(Boolean);
			if (!question) {
				await ctx.reply("Please provide a poll question.");
				return;
			}
			if (values.length < 2) {
				await ctx.reply(
					"Please provide at least two poll options (comma-separated).",
				);
				return;
			}
			const selectableCount = ctx.getIntegerOption("select") || 1;
			if (selectableCount < 1 || selectableCount > values.length) {
				await ctx.reply(
					"Selectable count must be at least 1 and no more than the number of options.",
				);
				return;
			}
			const toAnnouncementGroup = Boolean(ctx.getBooleanOption("announcement"));
			const pollPayload = {
				poll: {
					name: question,
					values,
					selectableCount,
					toAnnouncementGroup,
				},
			};
			if (isNewsletterJid(normalizedJid)) {
				let interactiveError = null;
				let ackErrorCode = null;
				try {
					const sentInteractive = await state.waClient.sendMessage(
						normalizedJid,
						pollPayload,
					);
					messageStore.set(sentInteractive);
					const ackWaitMs = newsletterAckWaitMsForSentMessage(sentInteractive);
					ackErrorCode = await waitForNewsletterAckError(
						sentInteractive?.key?.id,
						ackWaitMs,
					);
					if (!ackErrorCode) {
						await ctx.reply("Interactive newsletter poll sent to WhatsApp!");
						return;
					}
				} catch (err) {
					interactiveError = err;
				}

				if (interactiveError) {
					state.logger?.warn?.(
						{ err: interactiveError, jid: normalizedJid },
						"Interactive newsletter poll failed; falling back to text poll",
					);
				} else {
					state.logger?.warn?.(
						{
							jid: normalizedJid,
							error: ackErrorCode,
						},
						"Interactive newsletter poll rejected by WhatsApp ack; falling back to text poll",
					);
				}
				const pollLines = [
					`📊 Poll: ${question}`,
					...values.map((value, index) => `${index + 1}. ${value}`),
					"",
					"(Newsletter fallback: interactive poll payload was not accepted by WhatsApp.)",
				];
				try {
					const sentFallback = await state.waClient.sendMessage(normalizedJid, {
						text: pollLines.join("\n"),
					});
					messageStore.set(sentFallback);
					if (interactiveError) {
						await ctx.reply(
							"Interactive newsletter poll failed, so WA2DC sent a text fallback poll.",
						);
					} else {
						await ctx.reply(
							`Interactive newsletter poll was rejected (ack ${ackErrorCode || "unknown"}), so WA2DC sent a text fallback poll.`,
						);
					}
				} catch (err) {
					state.logger?.error(
						{ err },
						"Failed to send newsletter poll fallback to WhatsApp",
					);
					await ctx.reply(
						"Interactive newsletter poll failed, and text fallback also failed. Please try again.",
					);
				}
				return;
			}
			try {
				const sent = await state.waClient.sendMessage(
					normalizedJid,
					pollPayload,
				);
				messageStore.set(sent);
				await ctx.reply("Poll sent to WhatsApp!");
			} catch (err) {
				state.logger?.error({ err }, "Failed to send poll to WhatsApp");
				await ctx.reply(
					"Failed to send the poll to WhatsApp. Please try again.",
				);
			}
		},
	},
	setpinduration: {
		description: "Set the default pin duration for WhatsApp pins.",
		options: [
			{
				name: "duration",
				description: "How long pins last by default.",
				type: ApplicationCommandOptionTypes.STRING,
				required: true,
				choices: [
					{ name: "24 hours", value: "24h" },
					{ name: "7 days", value: "7d" },
					{ name: "30 days", value: "30d" },
				],
			},
		],
		async execute(ctx) {
			const choice = ctx.getStringOption("duration");
			const seconds = PIN_DURATION_PRESETS[choice];
			if (!seconds) {
				await ctx.reply("Invalid duration. Choose 24h, 7d, or 30d.");
				return;
			}
			state.settings.PinDurationSeconds = seconds;
			await ctx.reply(`Default pin duration set to ${choice}.`);
		},
	},
	defaultchat: {
		description:
			"Choose whether new WhatsApp chats are created as channels or threads.",
		options: [
			{
				name: "mode",
				description: "Default Discord target type for new WhatsApp chats.",
				type: ApplicationCommandOptionTypes.STRING,
				required: true,
				choices: [
					{ name: "Channel", value: "channel" },
					{ name: "Thread", value: "thread" },
				],
			},
		],
		async execute(ctx) {
			const mode = ctx.getStringOption("mode");
			if (!["channel", "thread"].includes(mode || "")) {
				await ctx.reply("Choose either `channel` or `thread`.");
				return;
			}
			state.settings.DefaultChatType = mode;
			await storage.saveSettings().catch(() => {});
			await ctx.reply(
				mode === "thread"
					? "Default chat mode set to `thread`. New WhatsApp chats will be created as forum threads under managed `whatsapp-threads` channels."
					: "Default chat mode set to `channel`. New WhatsApp chats will keep using regular Discord channels.",
			);
		},
	},
	threadnotifications: {
		description:
			"Toggle the one-time notification post when WA2DC creates a new WhatsApp thread.",
		options: [
			{
				name: "enabled",
				description:
					"Whether new WA-created threads should ping configured users/roles.",
				type: ApplicationCommandOptionTypes.BOOLEAN,
				required: true,
			},
		],
		async execute(ctx) {
			const enabled = Boolean(ctx.getBooleanOption("enabled"));
			state.settings.ThreadNotificationsEnabled = enabled;
			await storage.saveSettings().catch(() => {});
			await ctx.reply(
				`Thread creation notifications are ${enabled ? "enabled" : "disabled"}.`,
			);
		},
	},
	threadtargets: {
		description:
			"Manage which Discord users/roles are pinged when WA2DC creates a new WhatsApp thread.",
		options: [
			{
				name: "action",
				description:
					"Add, remove, or list configured thread-notification targets.",
				type: ApplicationCommandOptionTypes.STRING,
				required: true,
				choices: [
					{ name: "Add", value: "add" },
					{ name: "Remove", value: "remove" },
					{ name: "List", value: "list" },
				],
			},
			{
				name: "user",
				description: "Discord user to notify on new thread creation.",
				type: ApplicationCommandOptionTypes.USER,
				required: false,
			},
			{
				name: "role",
				description: "Discord role to notify on new thread creation.",
				type: ApplicationCommandOptionTypes.ROLE,
				required: false,
			},
		],
		async execute(ctx) {
			const action = ctx.getStringOption("action");
			const user = ctx.getUserOption("user");
			const role = ctx.getRoleOption("role");

			if (action === "list") {
				const roleTargets = [
					...new Set(state.settings.ThreadNotificationRoles || []),
				];
				const userTargets = [
					...new Set(state.settings.ThreadNotificationUsers || []),
				];
				await ctx.reply(
					[
						`Thread notifications: ${state.settings.ThreadNotificationsEnabled ? "enabled" : "disabled"}`,
						`Roles: ${roleTargets.length ? roleTargets.map((id) => `<@&${id}>`).join(", ") : "(none)"}`,
						`Users: ${userTargets.length ? userTargets.map((id) => `<@${id}>`).join(", ") : "(none)"}`,
					].join("\n"),
				);
				return;
			}

			if (!["add", "remove"].includes(action || "")) {
				await ctx.reply("Choose `add`, `remove`, or `list`.");
				return;
			}
			if (Boolean(user) === Boolean(role)) {
				await ctx.reply("Choose exactly one target: either `user` or `role`.");
				return;
			}

			const isRoleTarget = Boolean(role);
			const targetId = String(role?.id || user?.id || "");
			const targetLabel = isRoleTarget ? `<@&${targetId}>` : `<@${targetId}>`;
			const list = isRoleTarget
				? (state.settings.ThreadNotificationRoles ??= [])
				: (state.settings.ThreadNotificationUsers ??= []);
			const alreadyConfigured = list.includes(targetId);

			if (action === "add") {
				if (alreadyConfigured) {
					await ctx.reply(`${targetLabel} is already configured.`);
					return;
				}
				list.push(targetId);
				await storage.saveSettings().catch(() => {});
				await ctx.reply(`Added ${targetLabel} to thread notifications.`);
				return;
			}

			if (!alreadyConfigured) {
				await ctx.reply(`${targetLabel} is not configured.`);
				return;
			}
			if (isRoleTarget) {
				state.settings.ThreadNotificationRoles =
					state.settings.ThreadNotificationRoles.filter(
						(id) => id !== targetId,
					);
			} else {
				state.settings.ThreadNotificationUsers =
					state.settings.ThreadNotificationUsers.filter(
						(id) => id !== targetId,
					);
			}
			await storage.saveSettings().catch(() => {});
			await ctx.reply(`Removed ${targetLabel} from thread notifications.`);
		},
	},
	link: {
		description: "Link a WhatsApp chat to an existing channel.",
		options: [
			{
				name: "contact",
				description: "Number with country code or contact name.",
				type: ApplicationCommandOptionTypes.STRING,
				required: true,
			},
			{
				name: "channel",
				description: "Target Discord channel.",
				type: ApplicationCommandOptionTypes.CHANNEL,
				required: true,
			},
			{
				name: "force",
				description: "Override an existing link.",
				type: ApplicationCommandOptionTypes.BOOLEAN,
				required: false,
			},
		],
		async execute(ctx) {
			const force = Boolean(ctx.getBooleanOption("force"));
			const channel = ctx.getChannelOption("channel");
			const contactQuery = ctx.getStringOption("contact");

			if (!channel || !contactQuery) {
				await ctx.reply(
					"Please provide a contact and a channel. Usage: `link <number with country code or name> #<channel>`",
				);
				return;
			}

			if (channel.id === state.settings.ControlChannelID) {
				await ctx.reply(
					"The control channel cannot be linked. Please choose another channel.",
				);
				return;
			}

			if (channel.guildId !== state.settings.GuildID) {
				await ctx.reply(
					"Please choose a channel from the configured Discord server.",
				);
				return;
			}
			const targetInfo = await resolveManualLinkTarget(channel);
			if (!targetInfo.ok) {
				await ctx.reply(targetInfo.error);
				return;
			}

			const jid = utils.whatsapp.toJid(contactQuery);
			const normalizedJid = utils.whatsapp.formatJid(jid);
			if (!normalizedJid) {
				await ctx.reply(`Couldn't find \`${contactQuery}\`.`);
				return;
			}

			const existingJid = utils.discord.channelIdToJid(
				targetInfo.targetChannelId,
			);
			const forcedTakeover = Boolean(
				existingJid && existingJid !== normalizedJid && force,
			);
			let displacedChat;
			let displacedRun;
			if (existingJid && existingJid !== normalizedJid) {
				if (!force) {
					await ctx.reply(
						"That channel is already linked to another WhatsApp conversation. Enable the force option (or use the move command) to override it.",
					);
					return;
				}
				displacedChat = state.chats[existingJid];
				displacedRun = state.goccRuns[existingJid];
				delete state.chats[existingJid];
				delete state.goccRuns[existingJid];
			}

			let webhook;
			try {
				webhook = await utils.discord.getOrCreateOwnedWebhook(
					targetInfo.hostChannel,
				);
			} catch (err) {
				state.logger?.error(err);
				await ctx.reply(
					"Failed to access or create a webhook for that channel. Check the bot's permissions.",
				);
				return;
			}

			const previousChat = state.chats[normalizedJid];
			const previousHostChannelId = getChatHostChannelId(previousChat);
			const previousRun = state.goccRuns[normalizedJid];
			state.chats[normalizedJid] = buildChatLinkFromWebhook(webhook, {
				threadId: targetInfo.threadId,
			});
			delete state.goccRuns[normalizedJid];

			try {
				await storage.save();
			} catch (err) {
				state.logger?.error(err);
				if (previousChat) {
					state.chats[normalizedJid] = previousChat;
				} else {
					delete state.chats[normalizedJid];
				}
				if (previousRun) {
					state.goccRuns[normalizedJid] = previousRun;
				} else {
					delete state.goccRuns[normalizedJid];
				}
				if (forcedTakeover) {
					if (displacedChat) {
						state.chats[existingJid] = displacedChat;
					}
					if (displacedRun) {
						state.goccRuns[existingJid] = displacedRun;
					}
				}
				await ctx.reply(
					"Linked the channel, but failed to finalize the setup. Please try again.",
				);
				return;
			}

			if (
				previousHostChannelId &&
				previousHostChannelId !== webhook.channelId &&
				previousChat?.id &&
				!isWebhookSharedAcrossChats(previousChat.id, normalizedJid)
			) {
				try {
					const previousChannel = await utils.discord.getChannel(
						previousHostChannelId,
					);
					const previousWebhooks = await previousChannel?.fetchWebhooks();
					const previousWebhook =
						previousWebhooks?.get(previousChat.id) ||
						previousWebhooks?.find((hook) => hook.id === previousChat.id);
					await previousWebhook?.delete("WA2DC channel relinked");
				} catch (err) {
					state.logger?.warn(err);
				}
			}

			const forcedSuffix = forcedTakeover
				? ` (overrode the previous link to \`${utils.whatsapp.jidToName(existingJid)}\`).`
				: ".";
			await ctx.reply(
				`Linked <#${targetInfo.targetChannelId}> with \`${utils.whatsapp.jidToName(normalizedJid)}\`${forcedSuffix}`,
			);
		},
	},
	move: {
		description: "Move a WhatsApp link from one channel to another.",
		options: [
			{
				name: "from",
				description: "Current channel.",
				type: ApplicationCommandOptionTypes.CHANNEL,
				required: true,
			},
			{
				name: "to",
				description: "Destination channel.",
				type: ApplicationCommandOptionTypes.CHANNEL,
				required: true,
			},
			{
				name: "force",
				description: "Override any existing link on the destination.",
				type: ApplicationCommandOptionTypes.BOOLEAN,
				required: false,
			},
		],
		async execute(ctx) {
			const source = ctx.getChannelOption("from");
			const target = ctx.getChannelOption("to");
			const force = Boolean(ctx.getBooleanOption("force"));

			if (!source || !target) {
				await ctx.reply(
					"Please mention the current channel and the new channel. Usage: `move #old-channel #new-channel` (enable the force option to override existing links)",
				);
				return;
			}

			if (source.id === target.id) {
				await ctx.reply(
					"Please mention two different channels to move between.",
				);
				return;
			}

			if (
				source.id === state.settings.ControlChannelID ||
				target.id === state.settings.ControlChannelID
			) {
				await ctx.reply(
					"The control channel cannot participate in moves. Choose two regular text channels.",
				);
				return;
			}

			if (
				source.guildId !== state.settings.GuildID ||
				target.guildId !== state.settings.GuildID
			) {
				await ctx.reply(
					"Please choose channels from the configured Discord server.",
				);
				return;
			}

			const targetInfo = await resolveManualLinkTarget(target);
			if (!targetInfo.ok) {
				await ctx.reply(targetInfo.error);
				return;
			}

			const sourceJidRaw = utils.discord.channelIdToJid(source.id);
			const normalizedJid = utils.whatsapp.formatJid(sourceJidRaw);
			if (!normalizedJid) {
				await ctx.reply(
					"The source channel is not linked to any WhatsApp conversation.",
				);
				return;
			}

			const existingTargetJid = utils.discord.channelIdToJid(
				targetInfo.targetChannelId,
			);
			const forcedTakeover = Boolean(
				existingTargetJid && existingTargetJid !== normalizedJid && force,
			);
			let displacedChat;
			let displacedRun;
			if (existingTargetJid && existingTargetJid !== normalizedJid) {
				if (!force) {
					await ctx.reply(
						"That destination channel is already linked to another conversation. Enable the force option to override it.",
					);
					return;
				}
				displacedChat = state.chats[existingTargetJid];
				displacedRun = state.goccRuns[existingTargetJid];
				delete state.chats[existingTargetJid];
				delete state.goccRuns[existingTargetJid];
			}

			let webhook;
			try {
				webhook = await utils.discord.getOrCreateOwnedWebhook(
					targetInfo.hostChannel,
				);
			} catch (err) {
				state.logger?.error(err);
				if (forcedTakeover) {
					if (displacedChat) {
						state.chats[existingTargetJid] = displacedChat;
					}
					if (displacedRun) {
						state.goccRuns[existingTargetJid] = displacedRun;
					}
				}
				await ctx.reply(
					"Failed to access or create a webhook for the destination channel. Check the bot's permissions.",
				);
				return;
			}

			const previousChat = state.chats[normalizedJid];
			const previousHostChannelId = getChatHostChannelId(previousChat);
			const previousRun = state.goccRuns[normalizedJid];
			state.chats[normalizedJid] = buildChatLinkFromWebhook(webhook, {
				threadId: targetInfo.threadId,
			});
			delete state.goccRuns[normalizedJid];

			try {
				await storage.save();
			} catch (err) {
				state.logger?.error(err);
				if (previousChat) {
					state.chats[normalizedJid] = previousChat;
				} else {
					delete state.chats[normalizedJid];
				}
				if (previousRun) {
					state.goccRuns[normalizedJid] = previousRun;
				} else {
					delete state.goccRuns[normalizedJid];
				}
				if (forcedTakeover) {
					if (displacedChat) {
						state.chats[existingTargetJid] = displacedChat;
					}
					if (displacedRun) {
						state.goccRuns[existingTargetJid] = displacedRun;
					}
				}
				await ctx.reply(
					"Moved the channel, but failed to finalize the setup. Please try again.",
				);
				return;
			}

			if (
				previousHostChannelId &&
				previousHostChannelId !== webhook.channelId &&
				previousChat?.id &&
				!isWebhookSharedAcrossChats(previousChat.id, normalizedJid)
			) {
				try {
					const previousChannel = await utils.discord.getChannel(
						previousHostChannelId,
					);
					const previousWebhooks = await previousChannel?.fetchWebhooks();
					const previousWebhook =
						previousWebhooks?.get(previousChat.id) ||
						previousWebhooks?.find((hook) => hook.id === previousChat.id);
					await previousWebhook?.delete("WA2DC channel moved");
				} catch (err) {
					state.logger?.warn(err);
				}
			}

			const forcedSuffix = forcedTakeover
				? ` (overrode the previous link to \`${utils.whatsapp.jidToName(existingTargetJid)}\`).`
				: ".";
			await ctx.reply(
				`Moved \`${utils.whatsapp.jidToName(normalizedJid)}\` from <#${source.id}> to <#${targetInfo.targetChannelId}>${forcedSuffix}`,
			);
		},
	},
	list: {
		description: "List contacts and groups.",
		options: [
			{
				name: "query",
				description: "Optional search text.",
				type: ApplicationCommandOptionTypes.STRING,
				required: false,
			},
		],
		async execute(ctx) {
			let contacts = utils.whatsapp.contacts();
			const query = ctx.getStringOption("query")?.toLowerCase();
			if (query) {
				contacts = contacts.filter((name) =>
					name.toLowerCase().includes(query),
				);
			}
			contacts = contacts.sort((a, b) => a.localeCompare(b)).join("\n");
			const message = utils.discord.partitionText(
				contacts.length
					? `${contacts}\n\nNot the whole list? You can refresh your contacts by typing \`resync\``
					: "No results were found.",
			);
			while (message.length !== 0) {
				await ctx.reply(message.shift());
			}
		},
	},
	linkmention: {
		description:
			"Link a WhatsApp contact to a Discord user so WhatsApp @mentions ping them in Discord.",
		options: [
			{
				name: "contact",
				description: "Number with country code or contact name.",
				type: ApplicationCommandOptionTypes.STRING,
				required: true,
			},
			{
				name: "user",
				description: "Target Discord user to mention.",
				type: ApplicationCommandOptionTypes.USER,
				required: true,
			},
		],
		async execute(ctx) {
			const contact = ctx.getStringOption("contact");
			const user = ctx.getUserOption("user");
			if (!contact || !user?.id) {
				await ctx.reply(
					"Usage: `/linkmention contact:<name or number> user:<@user>`.",
				);
				return;
			}

			const jid = utils.whatsapp.toJid(contact);
			if (!jid) {
				await ctx.reply(`Couldn't find \`${contact}\`.`);
				return;
			}

			const formatted = utils.whatsapp.formatJid(jid);

			if (
				!state.settings.WhatsAppDiscordMentionLinks ||
				typeof state.settings.WhatsAppDiscordMentionLinks !== "object"
			) {
				state.settings.WhatsAppDiscordMentionLinks = {};
			}
			state.settings.WhatsAppDiscordMentionLinks[formatted] = user.id;

			await storage.saveSettings().catch(() => {});

			const name = utils.whatsapp.jidToName(formatted);
			const displayJid = utils.whatsapp.formatJidForDisplay(formatted);
			await ctx.reply(
				`Linked WhatsApp contact **${name}** (${displayJid}) to <@${user.id}>.`,
			);
		},
	},
	unlinkmention: {
		description: "Remove a WhatsApp→Discord mention link for a contact.",
		options: [
			{
				name: "contact",
				description: "Number with country code or contact name.",
				type: ApplicationCommandOptionTypes.STRING,
				required: true,
			},
		],
		async execute(ctx) {
			const contact = ctx.getStringOption("contact");
			if (!contact) {
				await ctx.reply("Usage: `/unlinkmention contact:<name or number>`.");
				return;
			}

			const jid = utils.whatsapp.toJid(contact);
			if (!jid) {
				await ctx.reply(`Couldn't find \`${contact}\`.`);
				return;
			}

			const formatted = utils.whatsapp.formatJid(jid);

			const links = state.settings?.WhatsAppDiscordMentionLinks;
			if (!links || typeof links !== "object") {
				await ctx.reply("No mention links are currently configured.");
				return;
			}

			let removed = 0;
			for (const key of Object.keys(links)) {
				if (utils.whatsapp.formatJid(key) !== formatted) continue;
				if (Object.hasOwn(links, key)) {
					delete links[key];
					removed += 1;
				}
			}

			await storage.saveSettings().catch(() => {});

			const name = utils.whatsapp.jidToName(formatted);
			const displayJid = utils.whatsapp.formatJidForDisplay(formatted);
			if (!removed) {
				await ctx.reply(
					`No mention link found for **${name}** (${displayJid}).`,
				);
				return;
			}
			await ctx.reply(`Removed mention link for **${name}** (${displayJid}).`);
		},
	},
	mentionlinks: {
		description: "List WhatsApp contacts linked to Discord mentions.",
		async execute(ctx) {
			const links = state.settings?.WhatsAppDiscordMentionLinks;
			if (!links || typeof links !== "object" || !Object.keys(links).length) {
				await ctx.reply("No mention links are currently configured.");
				return;
			}

			const byDiscordId = new Map();
			const isDiscordId = (value) =>
				typeof value === "string" && /^\d+$/.test(value.trim());

			for (const [jid, discordIdRaw] of Object.entries(links)) {
				const discordId =
					typeof discordIdRaw === "string" ? discordIdRaw.trim() : "";
				if (!jid || !isDiscordId(discordId)) continue;
				const normalizedJid = utils.whatsapp.formatJid(jid) || jid;
				const existing = byDiscordId.get(discordId) || new Set();
				existing.add(normalizedJid);
				byDiscordId.set(discordId, existing);
			}

			if (!byDiscordId.size) {
				await ctx.reply("No valid mention links are currently configured.");
				return;
			}

			const lines = [];
			for (const [discordId, jids] of byDiscordId.entries()) {
				const jidList = [...jids].filter(Boolean);
				const preferred = state.settings?.HidePhoneNumbers
					? jidList.find((jid) => !utils.whatsapp.isPhoneJid(jid)) || jidList[0]
					: jidList.find((jid) => utils.whatsapp.isPhoneJid(jid)) || jidList[0];
				const name = preferred
					? utils.whatsapp.jidToName(preferred)
					: "Unknown";
				const displayJid = preferred
					? utils.whatsapp.formatJidForDisplay(preferred)
					: "Unknown";
				const suffix =
					jidList.length > 1 ? ` (aliases: ${jidList.length})` : "";
				lines.push(`- **${name}** (${displayJid})${suffix} -> <@${discordId}>`);
			}

			await ctx.replyPartitioned(lines.join("\n"));
		},
	},
	jidinfo: {
		description:
			"Show known WhatsApp JID variants (PN/LID) for a contact and whether they are linked for mentions.",
		options: [
			{
				name: "contact",
				description: "Number with country code or contact name.",
				type: ApplicationCommandOptionTypes.STRING,
				required: true,
			},
		],
		async execute(ctx) {
			const contact = ctx.getStringOption("contact");
			if (!contact) {
				await ctx.reply("Usage: `/jidinfo contact:<name or number>`.");
				return;
			}

			const jid = utils.whatsapp.toJid(contact);
			if (!jid) {
				await ctx.reply(`Couldn't find \`${contact}\`.`);
				return;
			}

			const formatted = utils.whatsapp.formatJid(jid);
			const name = utils.whatsapp.jidToName(formatted);
			const normalizedName = String(name || "")
				.trim()
				.normalize("NFKC")
				.toLowerCase()
				.replace(/\s+/g, " ");

			const isSameName = (value) => {
				if (typeof value !== "string") return false;
				const normalized = value
					.trim()
					.normalize("NFKC")
					.toLowerCase()
					.replace(/\s+/g, " ");
				return normalized && normalized === normalizedName;
			};

			const candidates = new Set([formatted]);
			const addIfMatch = (jidCandidate, storedName) => {
				if (!jidCandidate) return;
				if (!isSameName(storedName)) return;
				const normalized = utils.whatsapp.formatJid(jidCandidate);
				if (normalized) candidates.add(normalized);
			};

			for (const [jidCandidate, storedName] of Object.entries(
				state.contacts || {},
			)) {
				addIfMatch(jidCandidate, storedName);
			}
			for (const [jidCandidate, storedName] of Object.entries(
				state.waClient?.contacts || {},
			)) {
				addIfMatch(jidCandidate, storedName);
			}

			const links = state.settings?.WhatsAppDiscordMentionLinks;
			const linkEntries = [];
			if (links && typeof links === "object") {
				for (const [linkJid, discordIdRaw] of Object.entries(links)) {
					const normalizedLinkJid = utils.whatsapp.formatJid(linkJid);
					if (!normalizedLinkJid) continue;
					if (!candidates.has(normalizedLinkJid)) continue;
					linkEntries.push({
						key: linkJid,
						jid: normalizedLinkJid,
						discordId:
							typeof discordIdRaw === "string" ? discordIdRaw.trim() : "",
					});
				}
			}

			const classify = (jidValue) => {
				if (utils.whatsapp.isPhoneJid(jidValue)) return "PN";
				if (utils.whatsapp.isLidJid(jidValue)) return "LID";
				if (typeof jidValue === "string" && jidValue.endsWith("@g.us"))
					return "GROUP";
				return "OTHER";
			};

			const jidList = [...candidates]
				.filter(Boolean)
				.sort((a, b) => a.localeCompare(b));
			const lines = [];
			lines.push(`Contact: **${name}**`);
			lines.push(
				`Resolved: \`${utils.whatsapp.formatJidForDisplay(formatted)}\` (${classify(formatted)})`,
			);
			lines.push("Known JIDs:");
			for (const jidValue of jidList) {
				const linked = linkEntries.filter(
					(entry) => entry.jid === jidValue && /^\d+$/.test(entry.discordId),
				);
				const linkSuffix = linked.length
					? ` -> ${linked.map((entry) => `<@${entry.discordId}>`).join(", ")}`
					: "";
				lines.push(
					`- \`${utils.whatsapp.formatJidForDisplay(jidValue)}\` (${classify(jidValue)})${linkSuffix}`,
				);
			}
			if (linkEntries.length) {
				lines.push("Raw mention-link keys:");
				for (const entry of linkEntries) {
					const suffix = /^\d+$/.test(entry.discordId)
						? ` -> <@${entry.discordId}>`
						: "";
					lines.push(
						`- \`${utils.whatsapp.formatJidForDisplay(entry.key)}\`${suffix}`,
					);
				}
			}

			await ctx.replyPartitioned(lines.join("\n"));
		},
	},
	addtowhitelist: {
		description: "Add a channel to the whitelist.",
		options: [
			{
				name: "channel",
				description: "Channel linked to a WhatsApp chat.",
				type: ApplicationCommandOptionTypes.CHANNEL,
				required: true,
			},
		],
		async execute(ctx) {
			const channel = ctx.getChannelOption("channel");
			if (!channel) {
				await ctx.reply(
					"Please enter a valid channel name. Usage: `addToWhitelist #<target channel>`.",
				);
				return;
			}

			const jid = utils.discord.channelIdToJid(channel.id);
			if (!jid) {
				await ctx.reply("Couldn't find a chat with the given channel.");
				return;
			}

			const normalized = utils.whatsapp.formatJid(jid);
			if (normalized && !state.settings.Whitelist.includes(normalized)) {
				state.settings.Whitelist.push(normalized);
			}
			await ctx.reply("Added to the whitelist!");
		},
	},
	removefromwhitelist: {
		description: "Remove a channel from the whitelist.",
		options: [
			{
				name: "channel",
				description: "Channel linked to a WhatsApp chat.",
				type: ApplicationCommandOptionTypes.CHANNEL,
				required: true,
			},
		],
		async execute(ctx) {
			const channel = ctx.getChannelOption("channel");
			if (!channel) {
				await ctx.reply(
					"Please enter a valid channel name. Usage: `removeFromWhitelist #<target channel>`.",
				);
				return;
			}

			const jid = utils.discord.channelIdToJid(channel.id);
			if (!jid) {
				await ctx.reply("Couldn't find a chat with the given channel.");
				return;
			}

			const normalized = utils.whatsapp.formatJid(jid);
			state.settings.Whitelist = state.settings.Whitelist.filter(
				(el) => el !== normalized,
			);
			await ctx.reply("Removed from the whitelist!");
		},
	},
	listwhitelist: {
		description: "List whitelisted channels.",
		async execute(ctx) {
			await ctx.reply(
				state.settings.Whitelist.length
					? `\`\`\`${state.settings.Whitelist.map((jid) => utils.whatsapp.jidToName(jid)).join("\n")}\`\`\``
					: "Whitelist is empty/inactive.",
			);
		},
	},
	setdcprefix: {
		description: "Set a static prefix for Discord messages.",
		options: [
			{
				name: "prefix",
				description: "Prefix text. Leave empty to reset to username.",
				type: ApplicationCommandOptionTypes.STRING,
				required: false,
			},
		],
		async execute(ctx) {
			const prefix = ctx.getStringOption("prefix");
			if (prefix) {
				state.settings.DiscordPrefixText = prefix;
				await ctx.reply(`Discord prefix is set to ${prefix}!`);
			} else {
				state.settings.DiscordPrefixText = null;
				await ctx.reply("Discord prefix is set to your discord username!");
			}
		},
	},
	dcprefix: {
		description: "Toggle Discord username prefixes.",
		options: [
			{
				name: "enabled",
				description: "Whether Discord username prefixes should be used.",
				type: ApplicationCommandOptionTypes.BOOLEAN,
				required: true,
			},
		],
		async execute(ctx) {
			const enabled = Boolean(ctx.getBooleanOption("enabled"));
			state.settings.DiscordPrefix = enabled;
			await ctx.reply(
				`Discord username prefix is set to ${state.settings.DiscordPrefix}.`,
			);
		},
	},
	waprefix: {
		description: "Toggle WhatsApp name prefixes on Discord.",
		options: [
			{
				name: "enabled",
				description:
					"Whether WhatsApp sender names should be prepended inside Discord messages.",
				type: ApplicationCommandOptionTypes.BOOLEAN,
				required: true,
			},
		],
		async execute(ctx) {
			const enabled = Boolean(ctx.getBooleanOption("enabled"));
			state.settings.WAGroupPrefix = enabled;
			await ctx.reply(
				`WhatsApp name prefix is set to ${state.settings.WAGroupPrefix}.`,
			);
		},
	},
	waplatformsuffix: {
		description: "Toggle WhatsApp sender platform suffix on Discord.",
		options: [
			{
				name: "enabled",
				description:
					"Whether WhatsApp messages mirrored to Discord should include a sender platform suffix.",
				type: ApplicationCommandOptionTypes.BOOLEAN,
				required: true,
			},
		],
		async execute(ctx) {
			const enabled = Boolean(ctx.getBooleanOption("enabled"));
			state.settings.WASenderPlatformSuffix = enabled;
			await ctx.reply(
				`WhatsApp sender platform suffix is set to ${state.settings.WASenderPlatformSuffix}.`,
			);
		},
	},
	hidephonenumbers: {
		description:
			"Hide WhatsApp phone numbers on Discord (use pseudonyms when needed).",
		options: [
			{
				name: "enabled",
				description: "Whether phone numbers should be hidden on Discord.",
				type: ApplicationCommandOptionTypes.BOOLEAN,
				required: true,
			},
		],
		async execute(ctx) {
			const enabled = Boolean(ctx.getBooleanOption("enabled"));
			state.settings.HidePhoneNumbers = enabled;
			if (enabled) {
				utils.whatsapp.ensurePrivacySalt();
			}
			await ctx.reply(
				`Hide phone numbers is set to ${state.settings.HidePhoneNumbers}.`,
			);
		},
	},
	waupload: {
		description: "Toggle uploading attachments to WhatsApp.",
		options: [
			{
				name: "enabled",
				description:
					"Whether Discord attachments should be uploaded to WhatsApp (vs sending as links).",
				type: ApplicationCommandOptionTypes.BOOLEAN,
				required: true,
			},
		],
		async execute(ctx) {
			const enabled = Boolean(ctx.getBooleanOption("enabled"));
			state.settings.UploadAttachments = enabled;
			await ctx.reply(
				`Uploading attachments to WhatsApp is set to ${state.settings.UploadAttachments}.`,
			);
		},
	},
	newsletterurlfallback: {
		description:
			"Toggle temporary URL fallback for newsletter image/video attachments.",
		options: [
			{
				name: "enabled",
				description:
					"Temporary Baileys workaround: send newsletter image/video attachments as plain links.",
				type: ApplicationCommandOptionTypes.BOOLEAN,
				required: true,
			},
		],
		async execute(ctx) {
			const enabled = Boolean(ctx.getBooleanOption("enabled"));
			state.settings.NewsletterMediaUrlFallback = enabled;
			await ctx.reply(
				enabled
					? "Newsletter media URL fallback is enabled. This is a temporary workaround until upstream Baileys newsletter media posting is fixed. Image/video attachments will be sent as plain links."
					: "Newsletter media URL fallback is disabled. Until upstream Baileys newsletter media posting is fixed, image/video attachments will not be sent to newsletters.",
			);
		},
	},
	waembeds: {
		description: "Toggle mirroring Discord embeds to WhatsApp.",
		options: [
			{
				name: "enabled",
				description:
					"Whether Discord embed text/media should be mirrored to WhatsApp.",
				type: ApplicationCommandOptionTypes.BOOLEAN,
				required: true,
			},
		],
		async execute(ctx) {
			const enabled = Boolean(ctx.getBooleanOption("enabled"));
			state.settings.DiscordEmbedsToWhatsApp = enabled;
			await ctx.reply(
				`Mirroring Discord embeds to WhatsApp is set to ${state.settings.DiscordEmbedsToWhatsApp}.`,
			);
		},
	},
	deletes: {
		description: "Toggle mirrored message deletions.",
		options: [
			{
				name: "enabled",
				description:
					"Whether message deletions should be mirrored between Discord and WhatsApp.",
				type: ApplicationCommandOptionTypes.BOOLEAN,
				required: true,
			},
		],
		async execute(ctx) {
			const enabled = Boolean(ctx.getBooleanOption("enabled"));
			state.settings.DeleteMessages = enabled;
			await ctx.reply(
				`Mirrored message deletions are set to ${state.settings.DeleteMessages}.`,
			);
		},
	},
	readreceipts: {
		description: "Toggle read receipts.",
		options: [
			{
				name: "enabled",
				description: "Whether read receipts are enabled.",
				type: ApplicationCommandOptionTypes.BOOLEAN,
				required: true,
			},
		],
		async execute(ctx) {
			const enabled = Boolean(ctx.getBooleanOption("enabled"));
			state.settings.ReadReceipts = enabled;
			await ctx.reply(
				`Read receipts are set to ${state.settings.ReadReceipts}.`,
			);
		},
	},
	dmreadreceipts: {
		description: "Send read receipts via DM.",
		async execute(ctx) {
			state.settings.ReadReceiptMode = "dm";
			await ctx.reply("Read receipts will be sent via DM.");
		},
	},
	publicreadreceipts: {
		description: "Send read receipts as channel replies.",
		async execute(ctx) {
			state.settings.ReadReceiptMode = "public";
			await ctx.reply("Read receipts will be posted publicly.");
		},
	},
	reactionreadreceipts: {
		description: "Send read receipts as reactions.",
		async execute(ctx) {
			state.settings.ReadReceiptMode = "reaction";
			await ctx.reply("Read receipts will be added as ☑️ reactions.");
		},
	},
	help: {
		description: "Show help link.",
		async execute(ctx) {
			await ctx.reply(
				"See all the available commands at https://arespawn.github.io/WhatsAppToDiscord/#/commands",
			);
		},
	},
	resync: {
		description: "Re-sync WhatsApp contacts and groups.",
		options: [
			{
				name: "rename",
				description: "Rename channels to match WhatsApp names.",
				type: ApplicationCommandOptionTypes.BOOLEAN,
				required: false,
			},
		],
		async execute(ctx) {
			await ctx.defer();
			await state.waClient.authState.keys.set({
				"app-state-sync-version": { critical_unblock_low: null },
			});
			await state.waClient.resyncAppState(["critical_unblock_low"]);
			const participatingGroups =
				await state.waClient.groupFetchAllParticipating();
			groupMetadataCache.prime(participatingGroups);
			for (const [jid, attributes] of Object.entries(participatingGroups)) {
				state.waClient.contacts[jid] = attributes.subject;
			}
			const shouldRename = Boolean(ctx.getBooleanOption("rename"));
			if (shouldRename) {
				try {
					await utils.discord.renameChannels();
				} catch (err) {
					state.logger?.error(err);
				}
			}
			await ctx.reply("Re-synced!");
		},
	},
	localdownloads: {
		description: "Toggle local downloads for large files.",
		options: [
			{
				name: "enabled",
				description:
					"Whether large WhatsApp attachments should be downloaded locally.",
				type: ApplicationCommandOptionTypes.BOOLEAN,
				required: true,
			},
		],
		async execute(ctx) {
			const enabled = Boolean(ctx.getBooleanOption("enabled"));
			state.settings.LocalDownloads = enabled;
			await ctx.reply(
				`Local downloads are set to ${state.settings.LocalDownloads}.`,
			);
		},
	},
	getdownloadmessage: {
		description: "Show the current download message template.",
		async execute(ctx) {
			await ctx.reply(
				`Download message format is set to "${state.settings.LocalDownloadMessage}"`,
			);
		},
	},
	setdownloadmessage: {
		description: "Update the download message template.",
		options: [
			{
				name: "message",
				description: "Template text.",
				type: ApplicationCommandOptionTypes.STRING,
				required: true,
			},
		],
		async execute(ctx) {
			const message = ctx.getStringOption("message");
			state.settings.LocalDownloadMessage = message;
			await ctx.reply(
				`Set download message format to "${state.settings.LocalDownloadMessage}"`,
			);
		},
	},
	getdownloaddir: {
		description: "Show the download directory.",
		async execute(ctx) {
			await ctx.reply(
				`Download path is set to "${state.settings.DownloadDir}"`,
			);
		},
	},
	setdownloaddir: {
		description: "Set the download directory.",
		options: [
			{
				name: "path",
				description: "Directory path for downloads.",
				type: ApplicationCommandOptionTypes.STRING,
				required: true,
			},
		],
		async execute(ctx) {
			const dir = ctx.getStringOption("path");
			state.settings.DownloadDir = dir;
			await ctx.reply(`Set download path to "${state.settings.DownloadDir}"`);
		},
	},
	setdownloadlimit: {
		description: "Set the local download directory size limit in GB.",
		options: [
			{
				name: "size",
				description: "Size limit in gigabytes.",
				type: ApplicationCommandOptionTypes.NUMBER,
				required: true,
			},
		],
		async execute(ctx) {
			const gb = ctx.getNumberOption("size");
			if (!Number.isNaN(gb) && gb >= 0) {
				state.settings.DownloadDirLimitGB = gb;
				await ctx.reply(`Set download directory size limit to ${gb} GB.`);
			} else {
				await ctx.reply("Please provide a valid size in gigabytes.");
			}
		},
	},
	setfilesizelimit: {
		description: "Set the Discord upload size limit used by the bot.",
		options: [
			{
				name: "bytes",
				description: "Maximum size in bytes.",
				type: ApplicationCommandOptionTypes.INTEGER,
				required: true,
			},
		],
		async execute(ctx) {
			const size = ctx.getIntegerOption("bytes");
			if (!Number.isNaN(size) && size > 0) {
				state.settings.DiscordFileSizeLimit = size;
				await ctx.reply(`Set Discord file size limit to ${size} bytes.`);
			} else {
				await ctx.reply("Please provide a valid size in bytes.");
			}
		},
	},
	setwamediaburstsize: {
		description:
			"Set how many WhatsApp attachments are uploaded to Discord per batch.",
		options: [
			{
				name: "count",
				description:
					"Attachment count per Discord upload batch for WhatsApp media bursts (1-10).",
				type: ApplicationCommandOptionTypes.INTEGER,
				required: true,
			},
		],
		async execute(ctx) {
			const count = ctx.getIntegerOption("count");
			if (!Number.isInteger(count) || count < 1 || count > 10) {
				await ctx.reply(
					"Please provide a valid attachment count between 1 and 10.",
				);
				return;
			}
			state.settings.WhatsAppDiscordMediaBurstSize = count;
			await ctx.reply(
				`WhatsApp to Discord media burst size is set to ${count} attachment${count === 1 ? "" : "s"} per batch.`,
			);
		},
	},
	localdownloadserver: {
		description: "Toggle the local download server.",
		options: [
			{
				name: "enabled",
				description: "Whether the local download server should be running.",
				type: ApplicationCommandOptionTypes.BOOLEAN,
				required: true,
			},
		],
		async execute(ctx) {
			const enabled = Boolean(ctx.getBooleanOption("enabled"));
			state.settings.LocalDownloadServer = enabled;
			if (enabled) {
				utils.ensureDownloadServer();
				await ctx.reply(
					`Local download server is set to true (port ${state.settings.LocalDownloadServerPort}).`,
				);
				return;
			}

			utils.stopDownloadServer();
			await ctx.reply("Local download server is set to false.");
		},
	},
	setlocaldownloadserverport: {
		description: "Set the download server port.",
		options: [
			{
				name: "port",
				description: "Port number.",
				type: ApplicationCommandOptionTypes.INTEGER,
				required: true,
			},
		],
		async execute(ctx) {
			const port = ctx.getIntegerOption("port");
			if (!Number.isNaN(port) && port > 0 && port <= 65535) {
				state.settings.LocalDownloadServerPort = port;
				utils.stopDownloadServer();
				utils.ensureDownloadServer();
				await ctx.reply(`Set local download server port to ${port}.`);
			} else {
				await ctx.reply("Please provide a valid port.");
			}
		},
	},
	setlocaldownloadserverhost: {
		description: "Set the download server host.",
		options: [
			{
				name: "host",
				description: "Hostname or IP for the download server.",
				type: ApplicationCommandOptionTypes.STRING,
				required: true,
			},
		],
		async execute(ctx) {
			const host = ctx.getStringOption("host");
			state.settings.LocalDownloadServerHost = host;
			utils.stopDownloadServer();
			utils.ensureDownloadServer();
			await ctx.reply(`Set local download server host to ${host}.`);
		},
	},
	setlocaldownloadserverbindhost: {
		description: "Set the download server bind/listen host.",
		options: [
			{
				name: "host",
				description: "Bind host (e.g., 127.0.0.1 or 0.0.0.0).",
				type: ApplicationCommandOptionTypes.STRING,
				required: true,
			},
		],
		async execute(ctx) {
			const host = ctx.getStringOption("host");
			state.settings.LocalDownloadServerBindHost = host;
			utils.stopDownloadServer();
			utils.ensureDownloadServer();
			await ctx.reply(`Set local download server bind host to ${host}.`);
		},
	},
	setdownloadlinkttl: {
		description: "Set local download link expiry in seconds (0 = never).",
		options: [
			{
				name: "seconds",
				description: "Seconds until links expire.",
				type: ApplicationCommandOptionTypes.INTEGER,
				required: true,
			},
		],
		async execute(ctx) {
			const seconds = ctx.getIntegerOption("seconds");
			if (!Number.isNaN(seconds) && seconds >= 0) {
				state.settings.LocalDownloadLinkTTLSeconds = seconds;
				await ctx.reply(`Set local download link TTL to ${seconds} seconds.`);
			} else {
				await ctx.reply(
					"Please provide a valid number of seconds (0 or higher).",
				);
			}
		},
	},
	setdownloadmaxage: {
		description:
			"Set max age (days) for files in the download directory (0 = keep forever).",
		options: [
			{
				name: "days",
				description: "Maximum age in days.",
				type: ApplicationCommandOptionTypes.NUMBER,
				required: true,
			},
		],
		async execute(ctx) {
			const days = ctx.getNumberOption("days");
			if (!Number.isNaN(days) && days >= 0) {
				state.settings.DownloadDirMaxAgeDays = days;
				await ctx.reply(`Set download directory max age to ${days} day(s).`);
			} else {
				await ctx.reply("Please provide a valid number of days (0 or higher).");
			}
		},
	},
	setdownloadminfree: {
		description:
			"Set minimum free disk space (GB) to keep by pruning downloads (0 = disabled).",
		options: [
			{
				name: "gb",
				description: "Minimum free space in gigabytes.",
				type: ApplicationCommandOptionTypes.NUMBER,
				required: true,
			},
		],
		async execute(ctx) {
			const gb = ctx.getNumberOption("gb");
			if (!Number.isNaN(gb) && gb >= 0) {
				state.settings.DownloadDirMinFreeGB = gb;
				await ctx.reply(
					`Set download directory minimum free space to ${gb} GB.`,
				);
			} else {
				await ctx.reply(
					"Please provide a valid size in gigabytes (0 or higher).",
				);
			}
		},
	},
	httpsdownloadserver: {
		description: "Toggle HTTPS for the local download server.",
		options: [
			{
				name: "enabled",
				description:
					"Whether HTTPS should be enabled for the local download server.",
				type: ApplicationCommandOptionTypes.BOOLEAN,
				required: true,
			},
		],
		async execute(ctx) {
			const enabled = Boolean(ctx.getBooleanOption("enabled"));
			state.settings.UseHttps = enabled;
			utils.stopDownloadServer();
			utils.ensureDownloadServer();
			await ctx.reply(
				`HTTPS for local download server is set to ${state.settings.UseHttps}.`,
			);
		},
	},
	sethttpscert: {
		description: "Set HTTPS certificate paths for the download server.",
		options: [
			{
				name: "key_path",
				description: "Path to the TLS key.",
				type: ApplicationCommandOptionTypes.STRING,
				required: true,
			},
			{
				name: "cert_path",
				description: "Path to the TLS certificate.",
				type: ApplicationCommandOptionTypes.STRING,
				required: true,
			},
		],
		async execute(ctx) {
			const key = ctx.getStringOption("key_path");
			const cert = ctx.getStringOption("cert_path");
			[state.settings.HttpsKeyPath, state.settings.HttpsCertPath] = [key, cert];
			utils.stopDownloadServer();
			utils.ensureDownloadServer();
			await ctx.reply(`Set HTTPS key path to ${key} and cert path to ${cert}.`);
		},
	},
	publishing: {
		description: "Toggle publishing messages in news channels automatically.",
		options: [
			{
				name: "enabled",
				description:
					"Whether messages sent to news channels should be cross-posted automatically.",
				type: ApplicationCommandOptionTypes.BOOLEAN,
				required: true,
			},
		],
		async execute(ctx) {
			const enabled = Boolean(ctx.getBooleanOption("enabled"));
			state.settings.Publish = enabled;
			await ctx.reply(
				`Publishing messages in news channels is set to ${state.settings.Publish}.`,
			);
		},
	},
	changenotifications: {
		description:
			"Toggle profile/status change notifications (and WhatsApp Status mirroring).",
		options: [
			{
				name: "enabled",
				description:
					"Whether change notifications and WhatsApp Status mirroring are enabled.",
				type: ApplicationCommandOptionTypes.BOOLEAN,
				required: true,
			},
		],
		async execute(ctx) {
			const enabled = Boolean(ctx.getBooleanOption("enabled"));
			state.settings.ChangeNotifications = enabled;
			state.settings.MirrorWAStatuses = enabled;
			await ctx.reply(
				`Change notifications are set to ${state.settings.ChangeNotifications}.`,
			);
		},
	},
	autosaveinterval: {
		description: "Set the auto-save interval (seconds).",
		options: [
			{
				name: "seconds",
				description: "Number of seconds between saves.",
				type: ApplicationCommandOptionTypes.INTEGER,
				required: true,
			},
		],
		async execute(ctx) {
			const seconds = ctx.getIntegerOption("seconds");
			state.settings.autoSaveInterval = seconds;
			await ctx.reply(`Changed auto save interval to ${seconds}.`);
		},
	},
	lastmessagestorage: {
		description: "Set how many recent messages can be edited/deleted.",
		options: [
			{
				name: "size",
				description: "Number of messages to keep.",
				type: ApplicationCommandOptionTypes.INTEGER,
				required: true,
			},
		],
		async execute(ctx) {
			const size = ctx.getIntegerOption("size");
			state.settings.lastMessageStorage = size;
			await ctx.reply(`Changed last message storage size to ${size}.`);
		},
	},
	oneway: {
		description: "Set one-way communication mode.",
		options: [
			{
				name: "direction",
				description: "Choose direction or disable one-way.",
				type: ApplicationCommandOptionTypes.STRING,
				required: true,
				choices: [
					{ name: "discord", value: "discord" },
					{ name: "whatsapp", value: "whatsapp" },
					{ name: "disabled", value: "disabled" },
				],
			},
		],
		async execute(ctx) {
			const direction = ctx.getStringOption("direction");

			if (direction === "disabled") {
				state.settings.oneWay = ONE_WAY_MODES.TWO_WAY;
				await ctx.reply("Two way communication is enabled.");
			} else if (direction === "whatsapp") {
				state.settings.oneWay = ONE_WAY_MODES.TO_WHATSAPP_ONLY;
				await ctx.reply("Messages will be only sent to WhatsApp.");
			} else if (direction === "discord") {
				state.settings.oneWay = ONE_WAY_MODES.TO_DISCORD_ONLY;
				await ctx.reply("Messages will be only sent to Discord.");
			}
		},
	},
	redirectbots: {
		description: "Toggle redirecting bot messages to WhatsApp.",
		options: [
			{
				name: "enabled",
				description: "Whether bot messages should be redirected.",
				type: ApplicationCommandOptionTypes.BOOLEAN,
				required: true,
			},
		],
		async execute(ctx) {
			const enabled = Boolean(ctx.getBooleanOption("enabled"));
			state.settings.redirectBots = enabled;
			await ctx.reply(
				`Redirecting bots is set to ${state.settings.redirectBots}.`,
			);
		},
	},
	redirectwebhooks: {
		description: "Toggle redirecting webhook messages to WhatsApp.",
		options: [
			{
				name: "enabled",
				description: "Whether webhook messages should be redirected.",
				type: ApplicationCommandOptionTypes.BOOLEAN,
				required: true,
			},
		],
		async execute(ctx) {
			const enabled = Boolean(ctx.getBooleanOption("enabled"));
			state.settings.redirectWebhooks = enabled;
			await ctx.reply(
				`Redirecting webhooks is set to ${state.settings.redirectWebhooks}.`,
			);
		},
	},
	redirectannouncements: {
		description:
			"Toggle redirecting announcement/crosspost webhook messages to WhatsApp.",
		options: [
			{
				name: "enabled",
				description:
					"Whether announcement/crosspost webhook messages should be redirected.",
				type: ApplicationCommandOptionTypes.BOOLEAN,
				required: true,
			},
		],
		async execute(ctx) {
			const enabled = Boolean(ctx.getBooleanOption("enabled"));
			state.settings.redirectAnnouncementWebhooks = enabled;
			await ctx.reply(
				`Redirecting announcement webhooks is set to ${state.settings.redirectAnnouncementWebhooks}.`,
			);
		},
	},
	restart: {
		description: "Restart the bot safely.",
		async execute(ctx) {
			if (!ctx.isControlChannel) {
				await ctx.reply(
					"For safety, `/restart` can only be used in the control channel.",
				);
				return;
			}

			await requestSafeRestart(ctx, {
				message: "Saved state. Restarting...",
				reason: "manual",
			});
		},
	},
	updatechannel: {
		description: "Switch update channel between stable and unstable.",
		options: [
			{
				name: "channel",
				description: "Release channel.",
				type: ApplicationCommandOptionTypes.STRING,
				required: true,
				choices: [
					{ name: "stable", value: "stable" },
					{ name: "unstable", value: "unstable" },
				],
			},
		],
		async execute(ctx) {
			const channel = ctx.getStringOption("channel");

			state.settings.UpdateChannel = channel;
			await ctx.reply(
				`Update channel set to ${channel}. Checking for new releases...`,
			);
			await utils.updater.run(state.version, { prompt: false });
			await utils.discord.syncUpdatePrompt();
			await utils.discord.syncRollbackPrompt();
			if (state.updateInfo) {
				if (ctx.isControlChannel) {
					await ctx.reply(
						"Update available. The persistent update prompt in this channel has been refreshed.",
					);
				} else {
					const message = utils.updater.formatUpdateMessage(state.updateInfo);
					await ctx.replyPartitioned(message);
				}
			} else {
				await ctx.reply("No updates are available on that channel right now.");
			}
		},
	},
	update: {
		description: "Install the available update.",
		async execute(ctx) {
			await ctx.defer();
			if (!state.updateInfo) {
				await ctx.reply("No update available.");
				return;
			}
			if (!state.updateInfo.canSelfUpdate) {
				await ctx.replyPartitioned(
					`A new ${state.updateInfo.channel || "stable"} release (${state.updateInfo.version}) is available, but this installation cannot self-update.\n` +
						"Pull the new image or binary for the requested release and restart the bot.",
				);
				return;
			}

			const targetVersion = state.updateInfo.version;
			await ctx.reply("Updating...");
			const success = await utils.updater.update(state.updateInfo.version);
			if (!success) {
				await ctx.reply("Update failed. Check logs.");
				return;
			}

			state.updateInfo = null;
			await utils.discord.syncUpdatePrompt();
			await utils.discord.syncRollbackPrompt();
			await requestSafeRestart(ctx, {
				message: "Update downloaded. Restarting...",
				reason: "update",
				targetVersion,
			});
		},
	},
	checkupdate: {
		description: "Check for updates now.",
		async execute(ctx) {
			await ctx.defer();
			await utils.updater.run(state.version, { prompt: false });
			await utils.discord.syncUpdatePrompt();
			await utils.discord.syncRollbackPrompt();
			if (state.updateInfo) {
				if (ctx.isControlChannel) {
					await ctx.reply(
						"Update available. The persistent update prompt in this channel has been refreshed.",
					);
				} else {
					const message = utils.updater.formatUpdateMessage(state.updateInfo);
					const components = [
						new ActionRowBuilder().addComponents(
							new ButtonBuilder()
								.setCustomId(UPDATE_BUTTON_IDS.APPLY)
								.setLabel("Update")
								.setStyle(ButtonStyle.Primary)
								.setDisabled(!state.updateInfo.canSelfUpdate),
							new ButtonBuilder()
								.setCustomId(UPDATE_BUTTON_IDS.SKIP)
								.setLabel("Skip update")
								.setStyle(ButtonStyle.Secondary),
						),
					];
					await ctx.reply({ content: message, components });
				}
			} else {
				await ctx.reply("No update available.");
			}
		},
	},
	skipupdate: {
		description: "Clear the current update notification.",
		async execute(ctx) {
			state.updateInfo = null;
			await utils.discord.syncUpdatePrompt();
			await utils.discord.syncRollbackPrompt();
			await ctx.reply("Update skipped.");
		},
	},
	rollback: {
		description: "Roll back to the previous packaged binary.",
		async execute(ctx) {
			await ctx.defer();
			const result = await utils.updater.rollback();
			if (result.success) {
				await utils.discord.syncRollbackPrompt();
				await requestSafeRestart(ctx, {
					message: "Rolled back to the previous packaged binary. Restarting...",
					reason: "rollback",
				});
				return;
			}

			if (result.reason === "node") {
				await ctx.replyPartitioned(
					"Rollback is only available for packaged binaries. To roll back a Docker or source install, pull the previous image/tag and restart.",
				);
				return;
			}

			if (result.reason === "no-backup") {
				await ctx.reply(
					"No previous packaged binary is available to roll back to.",
				);
				return;
			}

			await ctx.reply("Rollback failed. Check logs for details.");
		},
	},
	unknown: {
		register: false,
		async execute(ctx) {
			await ctx.reply("Unknown command.");
		},
	},
};

const slashCommands = Object.entries(commandHandlers)
	.filter(([, def]) => def.register !== false)
	.map(([name, def]) => ({
		name,
		description: def.description || "No description provided.",
		options: def.options || [],
	}));

const buildInviteLink = () =>
	client?.user?.id
		? `https://discord.com/oauth2/authorize?client_id=${client.user.id}&scope=bot%20applications.commands&permissions=${BOT_PERMISSIONS}`
		: null;

const registerSlashCommands = async () => {
	try {
		const guild = await utils.discord.getGuild();
		if (!guild) {
			state.logger?.error("Failed to load guild while registering commands.");
			return;
		}
		await guild.commands.set(slashCommands);
	} catch (err) {
		state.logger?.error({ err }, "Failed to register slash commands");
		const missingAccess =
			err?.code === 50001 || /Missing Access/i.test(err?.message || "");
		if (missingAccess && !slashRegisterWarned) {
			slashRegisterWarned = true;
			const link = buildInviteLink();
			const warning = link
				? `Slash commands could not be registered (missing applications.commands scope). Re-invite the bot with this link:\n${link}`
				: "Slash commands could not be registered (missing applications.commands scope). Re-invite the bot with both bot and applications.commands scopes.";
			controlChannel?.send(warning).catch(() => {});
		}
	}
};

const executeCommand = async (name, ctx) => {
	const handler = commandHandlers[name] || commandHandlers.unknown;
	await handler.execute(ctx);
};

const handleInteractionCommand = async (interaction, commandName) => {
	const responder = new CommandResponder({
		interaction,
		channel: interaction.channel,
	});
	await responder.defer();
	const ctx = new CommandContext({ interaction, responder });
	await executeCommand(commandName, ctx);
};

const isUnknownInteractionError = (err) =>
	Number(err?.code) === 10062 ||
	Number(err?.rawError?.code) === 10062 ||
	String(err?.message || "")
		.toLowerCase()
		.includes("unknown interaction");

const handleInteractionCommandFailure = async ({
	interaction,
	commandName,
	err,
}) => {
	const logContext = {
		err,
		commandName,
		interactionId: interaction?.id,
		channelId: interaction?.channelId,
		customId: interaction?.customId,
	};
	if (isUnknownInteractionError(err)) {
		state.logger?.warn?.(
			logContext,
			"Discord rejected the interaction callback before WA2DC could acknowledge it",
		);
		return;
	}

	state.logger?.error?.(logContext, "Slash command handling failed");
	if (!interaction || interaction.deferred || interaction.replied) {
		return;
	}

	try {
		await interaction.reply({
			content: "Command failed. Check logs.",
			ephemeral: interaction.channelId !== state.settings.ControlChannelID,
		});
	} catch (replyErr) {
		state.logger?.warn?.(
			{ err: replyErr, commandName },
			"Failed to send interaction error reply",
		);
	}
};

client.on("interactionCreate", async (interaction) => {
	try {
		if (interaction.isButton()) {
			if (interaction.customId === UPDATE_BUTTON_IDS.APPLY) {
				await handleInteractionCommand(interaction, "update");
				return;
			}
			if (interaction.customId === UPDATE_BUTTON_IDS.SKIP) {
				await handleInteractionCommand(interaction, "skipupdate");
				return;
			}
			if (interaction.customId === ROLLBACK_BUTTON_ID) {
				await handleInteractionCommand(interaction, "rollback");
				return;
			}
			return;
		}

		if (!interaction.isCommand?.() && !interaction.isChatInputCommand?.()) {
			return;
		}

		const commandName = interaction.commandName?.toLowerCase();
		await handleInteractionCommand(interaction, commandName);
	} catch (err) {
		await handleInteractionCommandFailure({
			interaction,
			commandName:
				interaction.commandName?.toLowerCase() || interaction.customId,
			err,
		});
	}
});

client.on("raw", (packet = {}) => {
	if (packet.t !== "MESSAGE_CREATE") {
		return;
	}

	const rawData = packet.d || {};
	const messageId = rawData.id ? String(rawData.id) : null;
	if (!messageId) {
		return;
	}

	const snapshots = Array.isArray(rawData.message_snapshots)
		? rawData.message_snapshots
		: Array.isArray(rawData.messageSnapshots)
			? rawData.messageSnapshots
			: [];
	const reference = rawData.message_reference || rawData.messageReference || {};
	const sourceChannelId = reference.channel_id || reference.channelId || null;
	const sourceMessageId = reference.message_id || reference.messageId || null;
	const sourceGuildId = reference.guild_id || reference.guildId || null;
	const hasForwardSignal = snapshots.length > 0;
	const hasSourceReference = Boolean(
		sourceChannelId || sourceMessageId || sourceGuildId,
	);
	const snapshot = extractForwardSnapshot(rawData);

	if (!hasForwardSignal && !hasSourceReference && !snapshot) {
		return;
	}

	setTimedCacheEntry(
		discordForwardContextCache,
		discordForwardContextTimers,
		messageId,
		{
			isForwarded: hasForwardSignal,
			sourceChannelId,
			sourceMessageId,
			sourceGuildId,
			snapshot,
		},
		DISCORD_FORWARD_CONTEXT_TTL_MS,
	);
});

client.on("messageCreate", async (message) => {
	const isWebhookMessage = message.webhookId != null;

	if (
		message.author === client.user ||
		message.applicationId === client.user.id
	) {
		return;
	}

	if (isWebhookMessage) {
		if (isBridgeWebhookId(message.webhookId)) {
			return;
		}
		const isAnnouncementWebhook = isBroadcastWebhookMessage(message);
		if (isAnnouncementWebhook) {
			if (
				!state.settings.redirectWebhooks &&
				!state.settings.redirectAnnouncementWebhooks
			) {
				return;
			}
		} else if (!state.settings.redirectWebhooks) {
			return;
		}
	} else if (message.author?.bot && !state.settings.redirectBots) {
		return;
	}

	if (
		message.type === MessageType.ChannelPinnedMessage ||
		message.type === "CHANNEL_PINNED_MESSAGE"
	) {
		return;
	}

	if (message.channel.id === state.settings.ControlChannelID) {
		await message.channel.send(
			"Regular commands have been removed. Please use Discord slash commands (/) instead.",
		);
		return;
	}

	const jid = utils.discord.channelIdToJid(message.channel.id);
	if (jid == null) {
		return;
	}

	const rawForwardContext = consumeForwardContext(message.id);
	const forwardContext = buildForwardContext(message, rawForwardContext);
	const snapshot = rawForwardContext?.snapshot;
	if (snapshot) {
		message.wa2dcForwardSnapshot = snapshot;
	}
	state.waClient.ev.emit("discordMessage", { jid, message, forwardContext });
});

client.on("messageUpdate", async (oldMessage, message) => {
	const isWebhookMessage = message.webhookId != null;

	if (message.partial) {
		try {
			await message.fetch();
		} catch (err) {
			state.logger?.warn(err);
			return;
		}
	}

	const jid = utils.discord.channelIdToJid(message.channelId);
	if (jid == null) {
		return;
	}
	const newsletterChat = isNewsletterJid(jid);

	const oldPinned =
		typeof oldMessage?.pinned === "boolean" ? oldMessage.pinned : undefined;
	const newPinned = Boolean(message.pinned);
	const pinChanged =
		typeof oldPinned === "boolean"
			? oldPinned !== newPinned
			: newPinned === true;

	if (pinChanged) {
		const waId = state.lastMessages[message.id];
		if (waId == null) {
			await message.channel.send(
				`Couldn't ${newPinned ? "pin" : "unpin"} on WhatsApp. You can only pin messages synced with WhatsApp.`,
			);
		} else if (bridgePinnedMessages.has(message.id)) {
			bridgePinnedMessages.delete(message.id);
		} else {
			const stored = messageStore.get({ id: waId, remoteJid: jid });
			const key = stored?.key || {
				id: waId,
				remoteJid: jid,
				fromMe: stored?.key?.fromMe || false,
			};
			const pinType = newPinned ? 1 : 0;
			try {
				state.sentPins.add(key.id);
				const sentPinMsg = await state.waClient.sendMessage(jid, {
					pin: key,
					type: pinType,
					...(pinType === 1 ? { time: getPinDurationSeconds() } : {}),
				});
				const pinNoticeKey = sentPinMsg?.key
					? {
							...sentPinMsg.key,
							remoteJid: utils.whatsapp.formatJid(
								sentPinMsg.key.remoteJid || jid,
							),
							participant: utils.whatsapp.formatJid(
								sentPinMsg.key.participant || sentPinMsg.key.participantAlt,
							),
						}
					: null;
				if (pinNoticeKey?.id) {
					state.sentPins.add(pinNoticeKey.id);
				}
				if (newPinned) {
					schedulePinExpiryNotice(message, getPinDurationSeconds());
				} else {
					clearPinExpiryNotice(message.id);
				}
				setTimeout(() => state.sentPins.delete(key.id), 5 * 60 * 1000);
				if (pinNoticeKey?.id) {
					setTimeout(
						() => state.sentPins.delete(pinNoticeKey.id),
						5 * 60 * 1000,
					);
					try {
						await state.waClient.sendMessage(pinNoticeKey.remoteJid, {
							delete: pinNoticeKey,
						});
					} catch (err) {
						state.logger?.debug?.({ err }, "Failed to delete local pin notice");
					}
				}
			} catch (err) {
				state.logger?.error({ err }, "Failed to sync Discord pin to WhatsApp");
			}
		}
	}

	if (message.editedTimestamp == null || isWebhookMessage) {
		return;
	}

	if (newsletterChat) {
		await message.channel.send(
			"Newsletter message editing isn't supported by Baileys yet. Please edit the message directly in WhatsApp on your phone.",
		);
		return;
	}

	const messageId = state.lastMessages[message.id];
	if (messageId == null) {
		if (message.author?.bot && !state.settings.redirectBots) {
			return;
		}
		const reason = newsletterChat
			? "Couldn't edit this newsletter message yet because a server message ID is not available."
			: `Couldn't edit the message. You can only edit the last ${state.settings.lastMessageStorage} messages.`;
		await message.channel.send(reason);
		return;
	}

	if ((message.content || "").trim() === "") {
		await message.channel.send(
			"Edited message has no text to send to WhatsApp.",
		);
		return;
	}

	state.waClient.ev.emit("discordEdit", { jid, message });
});

client.on("messageDelete", async (message) => {
	if (!state.settings.DeleteMessages) {
		return;
	}

	clearTimedCacheEntry(
		discordMessageLocationCache,
		discordMessageLocationTimers,
		message?.id,
	);
	clearTimedCacheEntry(
		discordMessageLocationMissCache,
		discordMessageLocationMissTimers,
		message?.id,
	);
	clearTimedCacheEntry(
		quotedWhatsAppMessageLocationCache,
		quotedWhatsAppMessageLocationTimers,
		message?.id,
	);
	clearTimedCacheEntry(
		discordForwardContextCache,
		discordForwardContextTimers,
		message?.id,
	);

	const jid = utils.discord.channelIdToJid(message.channelId);
	if (jid == null) {
		return;
	}

	const waIds = [];
	for (const [waId, dcId] of Object.entries(state.lastMessages)) {
		if (dcId === message.id && waId !== message.id) {
			waIds.push(waId);
		}
	}
	const normalizedWaIds = [
		...new Set(waIds.map((id) => normalizeBridgeMessageId(id)).filter(Boolean)),
	];
	const newsletterChat = isNewsletterJid(jid);
	if (newsletterChat) {
		if (
			message.webhookId == null &&
			!(message.author?.bot && !state.settings.redirectBots) &&
			message.author?.id !== client.user.id
		) {
			await message.channel.send(
				"Newsletter message deletion isn't supported by Baileys yet. Please delete the message directly in WhatsApp on your phone.",
			);
		}
		for (const waId of normalizedWaIds) {
			delete state.lastMessages[waId];
			clearTimedCacheEntry(
				quotedWhatsAppMessageLocationCache,
				quotedWhatsAppMessageLocationTimers,
				waId,
			);
		}
		delete state.lastMessages[message.id];
		clearPinExpiryNotice(message.id);
		return;
	}
	const newsletterServerId = newsletterChat
		? resolveNewsletterServerIdForDiscordMessage(
				message.id,
				state.lastMessages[message.id] || normalizedWaIds[0] || null,
			)
		: null;
	let waIdsToDelete = newsletterChat
		? [
				...new Set([
					...(newsletterServerId &&
					isLikelyNewsletterServerId(newsletterServerId)
						? [newsletterServerId]
						: []),
					...normalizedWaIds.filter((id) => isLikelyNewsletterServerId(id)),
				]),
			]
		: normalizedWaIds;

	if (newsletterChat && waIdsToDelete.length === 0) {
		const delayedServerId = await waitForNewsletterServerId({
			discordMessageId: message.id,
			candidateId: state.lastMessages[message.id] || normalizedWaIds[0] || null,
			timeoutMs: NEWSLETTER_SERVER_ID_WAIT_TIMEOUT_MS,
			pollMs: NEWSLETTER_SERVER_ID_WAIT_POLL_MS,
		});
		if (delayedServerId) {
			waIdsToDelete = [delayedServerId];
			state.lastMessages[message.id] = delayedServerId;
			state.lastMessages[delayedServerId] = message.id;
		}
	}
	if (newsletterChat && waIdsToDelete.length === 0) {
		// Some Baileys builds do not expose newsletter server_id; fall back to mapped outbound ids.
		waIdsToDelete = normalizedWaIds;
	}

	if (message.webhookId != null && waIdsToDelete.length === 0) {
		return;
	}

	if (
		message.author?.bot &&
		!state.settings.redirectBots &&
		waIdsToDelete.length === 0
	) {
		return;
	}

	if (message.author?.id === client.user.id) {
		return;
	}

	if (waIdsToDelete.length === 0) {
		const reason = newsletterChat
			? "Couldn't delete this newsletter message because a server message ID is still unavailable."
			: `Couldn't delete the message. You can only delete the last ${state.settings.lastMessageStorage} messages.`;
		await message.channel.send(reason);
		return;
	}

	for (const waId of waIdsToDelete) {
		state.waClient.ev.emit("discordDelete", {
			jid,
			id: waId,
			discordMessageId: message.id,
		});
	}
	for (const waId of [...new Set([...normalizedWaIds, ...waIdsToDelete])]) {
		delete state.lastMessages[waId];
		clearTimedCacheEntry(
			quotedWhatsAppMessageLocationCache,
			quotedWhatsAppMessageLocationTimers,
			waId,
		);
	}
	delete state.lastMessages[message.id];
	clearPinExpiryNotice(message.id);
});

client.on("messageReactionAdd", async (reaction, user) => {
	const jid = utils.discord.channelIdToJid(reaction.message.channel.id);
	if (jid == null) {
		return;
	}
	const newsletterChat = isNewsletterJid(jid);
	const isBotUser = user?.id === state.dcClient?.user?.id;
	if (
		isBotUser &&
		reaction.emoji?.name === "☑️" &&
		(reaction.message.webhookId != null ||
			deliveredMessages.has(reaction.message.id))
	) {
		return;
	}
	const mappedMessageIds = collectMappedWhatsAppIdsForDiscordMessage(
		reaction.message.id,
	);
	let messageId =
		normalizeBridgeMessageId(state.lastMessages?.[reaction.message.id]) ||
		mappedMessageIds[0] ||
		null;
	if (messageId) {
		state.lastMessages[reaction.message.id] = messageId;
		state.lastMessages[messageId] = reaction.message.id;
	}
	if (newsletterChat) {
		const resolvedServerId = await waitForNewsletterServerId({
			discordMessageId: reaction.message.id,
			candidateId: messageId,
			timeoutMs: NEWSLETTER_SERVER_ID_WAIT_TIMEOUT_MS,
			pollMs: NEWSLETTER_SERVER_ID_WAIT_POLL_MS,
		});
		if (resolvedServerId) {
			messageId = resolvedServerId;
			state.lastMessages[reaction.message.id] = resolvedServerId;
			state.lastMessages[resolvedServerId] = reaction.message.id;
		}
	}
	if (messageId == null) {
		if (
			reaction.message.webhookId == null &&
			reaction.message.author?.bot &&
			!state.settings.redirectBots
		) {
			return;
		}
		const reason = newsletterChat
			? "Couldn't send the reaction because the newsletter server message ID is still unavailable."
			: `Couldn't send the reaction. You can only react to last ${state.settings.lastMessageStorage} messages.`;
		await reaction.message.channel.send(reason);
		return;
	}
	if (isBotUser) {
		return;
	}
	const selfJid =
		state.waClient?.user?.id &&
		utils.whatsapp.formatJid(state.waClient.user.id);
	if (selfJid && state.reactions[reaction.message.id]?.[selfJid]) {
		const prev = state.reactions[reaction.message.id][selfJid];
		await reaction.message.reactions.cache
			.get(prev)
			?.remove()
			.catch(() => {});
		delete state.reactions[reaction.message.id][selfJid];
		if (!Object.keys(state.reactions[reaction.message.id]).length) {
			delete state.reactions[reaction.message.id];
		}
	}
	state.waClient.ev.emit("discordReaction", {
		jid,
		reaction,
		removed: false,
		messageId,
	});
});

client.on("messageReactionRemove", async (reaction, user) => {
	const jid = utils.discord.channelIdToJid(reaction.message.channel.id);
	if (jid == null) {
		return;
	}
	const newsletterChat = isNewsletterJid(jid);
	const isBotUser = user?.id === state.dcClient?.user?.id;
	if (
		isBotUser &&
		reaction.emoji?.name === "☑️" &&
		(reaction.message.webhookId != null ||
			deliveredMessages.has(reaction.message.id))
	) {
		return;
	}
	const mappedMessageIds = collectMappedWhatsAppIdsForDiscordMessage(
		reaction.message.id,
	);
	let messageId =
		normalizeBridgeMessageId(state.lastMessages?.[reaction.message.id]) ||
		mappedMessageIds[0] ||
		null;
	if (messageId) {
		state.lastMessages[reaction.message.id] = messageId;
		state.lastMessages[messageId] = reaction.message.id;
	}
	if (newsletterChat) {
		const resolvedServerId = await waitForNewsletterServerId({
			discordMessageId: reaction.message.id,
			candidateId: messageId,
			timeoutMs: NEWSLETTER_SERVER_ID_WAIT_TIMEOUT_MS,
			pollMs: NEWSLETTER_SERVER_ID_WAIT_POLL_MS,
		});
		if (resolvedServerId) {
			messageId = resolvedServerId;
			state.lastMessages[reaction.message.id] = resolvedServerId;
			state.lastMessages[resolvedServerId] = reaction.message.id;
		}
	}
	if (messageId == null) {
		if (
			reaction.message.webhookId == null &&
			reaction.message.author?.bot &&
			!state.settings.redirectBots
		) {
			return;
		}
		const reason = newsletterChat
			? "Couldn't remove the reaction because the newsletter server message ID is still unavailable."
			: `Couldn't remove the reaction. You can only react to last ${state.settings.lastMessageStorage} messages.`;
		await reaction.message.channel.send(reason);
		return;
	}
	if (isBotUser) {
		return;
	}
	const selfJid =
		state.waClient?.user?.id &&
		utils.whatsapp.formatJid(state.waClient.user.id);
	if (selfJid && state.reactions[reaction.message.id]?.[selfJid]) {
		const prev = state.reactions[reaction.message.id][selfJid];
		await reaction.message.reactions.cache
			.get(prev)
			?.remove()
			.catch(() => {});
		delete state.reactions[reaction.message.id][selfJid];
		if (!Object.keys(state.reactions[reaction.message.id]).length) {
			delete state.reactions[reaction.message.id];
		}
	}
	state.waClient.ev.emit("discordReaction", {
		jid,
		reaction,
		removed: true,
		messageId,
	});
});

const discordHandler = {
	start: async () => {
		await client.login(state.settings.Token);
		return client;
	},
	setControlChannel,
};

export default discordHandler;
