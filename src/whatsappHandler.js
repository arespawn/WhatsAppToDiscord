import {
	Browsers,
	DisconnectReason,
	generateWAMessageFromContent,
	getAggregateVotesInPollMessage,
	prepareWAMessageMedia,
	proto,
	updateMessageWithPollUpdate,
	WAMessageStatus,
	WAMessageStubType,
} from "@whiskeysockets/baileys";
import {
	generateMessageIDV2,
	getKeyAuthor,
} from "@whiskeysockets/baileys/lib/Utils/generics.js";
import { decryptPollVote } from "@whiskeysockets/baileys/lib/Utils/process-message.js";
import useSQLiteAuthState from "./auth/sqliteAuthState.js";
import { getChatTargetChannelId } from "./chatLinks.js";
import { createWhatsAppClient, getBaileysVersion } from "./clientFactories.js";
import groupMetadataCache from "./groupMetadataCache.js";
import { createGroupRefreshScheduler } from "./groupMetadataRefresh.js";
import { getImageSharp } from "./imageLibs.js";
import { createAudioSendContentNormalizer } from "./internal/audioSendNormalization.js";
import { createStickerSendContentNormalizer } from "./internal/stickerSendNormalization.js";
import messageStore from "./messageStore.js";
import {
	clearPendingNewsletterSends,
	getNewsletterAckError,
	getNewsletterServerIdFromMessage,
	getPendingNewsletterSend,
	isLikelyNewsletterServerId,
	normalizeBridgeMessageId,
	noteNewsletterAckError,
	noteNewsletterMessageDebug,
	notePendingNewsletterSend,
	resolvePendingNewsletterSend,
	waitForNewsletterAckError,
	waitForNewsletterServerId,
} from "./newsletterBridge.js";
import {
	oneWayAllowsDiscordToWhatsApp,
	oneWayAllowsWhatsAppToDiscord,
} from "./oneWay.js";
import { getPollEncKey, getPollOptions } from "./pollUtils.js";
import state from "./state.js";
import utils from "./utils.js";

let authState;
let saveState;
let groupCachePruneInterval = null;
const allowsDiscordToWhatsApp = () =>
	oneWayAllowsDiscordToWhatsApp(state.settings.oneWay);
const allowsWhatsAppToDiscord = () =>
	oneWayAllowsWhatsAppToDiscord(state.settings.oneWay);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const formatDisconnectReason = (statusCode) => {
	if (typeof statusCode !== "number") return "unknown";
	const label = DisconnectReason[statusCode];
	return label ? `${label} (${statusCode})` : `code ${statusCode}`;
};
const getReconnectDelayMs = (retry) => {
	if (retry <= 3) {
		return 0;
	}
	const slowAttempt = retry - 3;
	const baseDelay = 5000;
	const maxDelay = 60000;
	return Math.min(baseDelay * 2 ** (slowAttempt - 1), maxDelay);
};

const getPollCreation = (message = {}) =>
	message.pollCreationMessage ||
	message.pollCreationMessageV2 ||
	message.pollCreationMessageV3 ||
	message.pollCreationMessageV4;

const aggregatePoll = (pollMessage) => {
	if (!pollMessage) return [];
	const message = pollMessage.message || pollMessage;
	const pollUpdates = pollMessage.pollUpdates || [];
	return getAggregateVotesInPollMessage(
		{ message, pollUpdates },
		state.waClient?.user?.id,
	);
};

const formatPollForDiscord = (pollMessage) => {
	const poll = getPollCreation(pollMessage?.message || pollMessage);
	if (!poll) return null;
	const aggregates = aggregatePoll(pollMessage);
	const selectable = poll.selectableOptionsCount || poll.selectableCount;
	const lines = [`📊 Poll: ${poll.name || "Untitled poll"}`];
	if (selectable && selectable > 1) {
		lines.push(`Select up to ${selectable} options.`);
	}
	aggregates.forEach((entry, idx) => {
		const voters = (entry.voters || [])
			.map((jid) => utils.whatsapp.jidToName(utils.whatsapp.formatJid(jid)))
			.filter(Boolean);
		const voteLabel = voters.length
			? `${voters.length} vote${voters.length === 1 ? "" : "s"}: ${voters.join(", ")}`
			: "0 votes";
		lines.push(`${idx + 1}. ${entry.name || "Unknown"} — ${voteLabel}`);
	});
	if (!aggregates.length && Array.isArray(poll.options)) {
		poll.options.forEach((opt, idx) => {
			lines.push(`${idx + 1}. ${opt.optionName || "Option"}`);
		});
	}
	return lines.join("\n");
};

const isPinInChatMessage = (message = {}) => !!message?.pinInChatMessage;

const toBuffer = (val) => {
	if (!val) return null;
	if (Buffer.isBuffer(val)) return val;
	if (val instanceof Uint8Array) return Buffer.from(val);
	if (
		typeof val === "object" &&
		val?.type === "Buffer" &&
		Array.isArray(val?.data)
	) {
		return Buffer.from(val.data);
	}
	if (typeof val === "string") {
		try {
			return Buffer.from(val, "base64");
		} catch {
			return Buffer.from(val);
		}
	}
	return null;
};
const normalizeAudioSendContentForWhatsApp = createAudioSendContentNormalizer({
	getLogger: () => state.logger,
	normalizeBridgeMessageId,
});
const normalizeStickerSendContentForWhatsApp =
	createStickerSendContentNormalizer({
		getLogger: () => state.logger,
		normalizeBridgeMessageId,
		getImageSharp,
		fetchBuffer: (...args) => utils.requests.fetchPublicBuffer(...args),
	});

const selectPnJid = (list = []) =>
	list.find(
		(jid) => typeof jid === "string" && jid.endsWith("@s.whatsapp.net"),
	) || null;

const expandJidVariants = async (jid) => {
	const variants = new Set();
	const formatted = utils.whatsapp.formatJid(jid);
	if (formatted) variants.add(formatted);
	try {
		const [primary, alternate] = await utils.whatsapp.hydrateJidPair(formatted);
		[primary, alternate].map(utils.whatsapp.formatJid).forEach((entry) => {
			if (entry) variants.add(entry);
		});
	} catch (err) {
		state.logger?.debug?.({ err }, "Failed to expand JID variants");
	}
	return Array.from(variants);
};

const getStoredMessageWithJidFallback = async (key = {}) => {
	const formattedRemote = utils.whatsapp.formatJid(key?.remoteJid);
	const formattedAlt = utils.whatsapp.formatJid(
		key?.participant || key?.participantAlt || key?.remoteJidAlt,
	);
	const [primary, fallback] = await utils.whatsapp.hydrateJidPair(
		formattedRemote,
		formattedAlt,
	);
	const candidates = new Set(
		[formattedRemote, formattedAlt, primary, fallback].filter(Boolean),
	);
	for (const remote of candidates) {
		const found = messageStore.get({ ...key, remoteJid: remote });
		if (found) {
			if (formattedRemote && remote && formattedRemote !== remote) {
				utils.whatsapp.migrateLegacyJid(formattedRemote, remote);
			}
			return found;
		}
	}
	return null;
};

const escapeRegex = (value) =>
	String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isBroadcastJid = (jid = "") =>
	typeof jid === "string" && jid.endsWith("@broadcast");
const isNewsletterJid = (jid = "") =>
	typeof jid === "string" && jid.endsWith("@newsletter");
const NEWSLETTER_SPECIAL_FLOW_ENABLED =
	process.env.WA2DC_NEWSLETTER_SPECIAL_FLOW === "1";
const useNewsletterSpecialFlowForJid = (jid = "") =>
	NEWSLETTER_SPECIAL_FLOW_ENABLED && isNewsletterJid(jid);
const normalizeSendJid = (jid) => utils.whatsapp.formatJid(jid) || jid;
const NEWSLETTER_SERVER_ID_WAIT_TIMEOUT_MS = 8000;
const NEWSLETTER_SERVER_ID_WAIT_POLL_MS = 150;
const NEWSLETTER_SERVER_ID_WAIT_WITHOUT_PENDING_MS = 300;
const NEWSLETTER_ACK_WAIT_WITH_SERVER_ID_MS = 2500;
const NEWSLETTER_ACK_WAIT_WITHOUT_SERVER_ID_MS = 8000;
const NEWSLETTER_SERVER_ID_FETCH_FALLBACK_COUNT = 30;
const NEWSLETTER_SERVER_ID_FETCH_WINDOW_SECONDS = 12 * 60;
const NEWSLETTER_SERVER_ID_FETCH_FALLBACK_WINDOW_SECONDS = 3 * 60;
const NEWSLETTER_SUBSCRIPTION_DEFAULT_TTL_MS = 15 * 60 * 1000;
const NEWSLETTER_SUBSCRIPTION_RETRY_TTL_MS = 2 * 60 * 1000;
const NEWSLETTER_MEDIA_STANZA_DEBUG_TTL_MS = 5 * 60 * 1000;
const NEWSLETTER_MEDIA_STANZA_DEBUG_MAX = 256;
const NEWSLETTER_MEDIA_STANZA_DEBUG_ENABLED =
	process.env.WA2DC_NEWSLETTER_MEDIA_DEBUG !== "0";
const NEWSLETTER_IMAGE_NORMALIZATION_MAX_BYTES = 25 * 1024 * 1024;
const NEWSLETTER_IMAGE_JPEG_MIME_TYPES = new Set(["image/jpeg", "image/jpg"]);
const WHATSAPP_MEDIA_ALBUM_MAX_ITEMS = 10;
const WHATSAPP_OUTBOUND_JPEG_THUMB_WIDTH = 192;
const WHATSAPP_OUTBOUND_JPEG_THUMB_QUALITY = 50;
const WHATSAPP_SAFE_IMAGE_MIME_TYPES = new Set([
	"image/jpeg",
	"image/jpg",
	"image/png",
]);
const WHATSAPP_PRESERVE_SOURCE_IMAGE_MIME_TYPES = new Set(["image/gif"]);
const WHATSAPP_PREFER_PNG_NORMALIZATION_MIME_TYPES = new Set([
	"image/png",
	"image/webp",
	"image/avif",
	"image/heic",
	"image/heif",
	"image/bmp",
	"image/tiff",
]);
const newsletterLiveUpdatesExpiresAt = new Map();
const newsletterMediaStanzaDebug = new Map();
const DISCORD_ATTACHMENT_MIME_BY_EXTENSION = {
	gif: "image/gif",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	jpe: "image/jpeg",
	png: "image/png",
	webp: "image/webp",
	bmp: "image/bmp",
	tif: "image/tiff",
	tiff: "image/tiff",
	mp4: "video/mp4",
	webm: "video/webm",
	mov: "video/quicktime",
	mp3: "audio/mpeg",
	wav: "audio/wav",
	ogg: "audio/ogg",
	oga: "audio/ogg",
	opus: "audio/opus",
	m4a: "audio/mp4",
	flac: "audio/flac",
	aac: "audio/aac",
	pdf: "application/pdf",
	txt: "text/plain; charset=utf-8",
	log: "text/plain; charset=utf-8",
	json: "application/json; charset=utf-8",
	csv: "text/csv; charset=utf-8",
	zip: "application/zip",
	"7z": "application/x-7z-compressed",
	gz: "application/gzip",
	tar: "application/x-tar",
};
const newsletterAckWaitMsForSentMessage = (sentMessage) =>
	getNewsletterServerIdFromMessage(sentMessage)
		? NEWSLETTER_ACK_WAIT_WITH_SERVER_ID_MS
		: NEWSLETTER_ACK_WAIT_WITHOUT_SERVER_ID_MS;

const normalizeNewsletterSignatureText = (value) => {
	if (typeof value !== "string") return "";
	return value.replace(/\s+/g, " ").trim().slice(0, 512);
};

const getNewsletterSignatureFromMessagePayload = (message = {}) => {
	if (!message || typeof message !== "object") {
		return { type: "", text: "" };
	}
	if (typeof message.conversation === "string") {
		return {
			type: "text",
			text: normalizeNewsletterSignatureText(message.conversation),
		};
	}
	if (typeof message.extendedTextMessage?.text === "string") {
		return {
			type: "text",
			text: normalizeNewsletterSignatureText(message.extendedTextMessage.text),
		};
	}
	if (message.imageMessage) {
		return {
			type: "image",
			text: normalizeNewsletterSignatureText(
				message.imageMessage.caption || "",
			),
		};
	}
	if (message.videoMessage) {
		return {
			type: "video",
			text: normalizeNewsletterSignatureText(
				message.videoMessage.caption || "",
			),
		};
	}
	if (message.audioMessage) {
		return { type: "audio", text: "" };
	}
	if (message.documentMessage) {
		return {
			type: "document",
			text: normalizeNewsletterSignatureText(
				message.documentMessage.caption || "",
			),
		};
	}
	return { type: "", text: "" };
};

const toIntegerOrNull = (value) => {
	if (typeof value === "number" && Number.isFinite(value)) {
		return Math.trunc(value);
	}
	if (typeof value === "bigint") {
		return Number(value);
	}
	if (typeof value === "string" && value.trim()) {
		const parsed = Number.parseInt(value, 10);
		if (Number.isFinite(parsed)) {
			return parsed;
		}
	}
	if (value && typeof value === "object") {
		if (typeof value.toNumber === "function") {
			try {
				const parsed = value.toNumber();
				if (Number.isFinite(parsed)) {
					return Math.trunc(parsed);
				}
			} catch {
				return null;
			}
		}
		if (typeof value.low === "number" && Number.isFinite(value.low)) {
			return Math.trunc(value.low);
		}
	}
	return null;
};

const getByteLength = (value) => {
	if (!value) return 0;
	if (Buffer.isBuffer(value)) return value.length;
	if (value instanceof Uint8Array) return value.length;
	if (typeof value === "string") return value.length;
	if (
		typeof value === "object" &&
		value?.type === "Buffer" &&
		Array.isArray(value?.data)
	) {
		return value.data.length;
	}
	return 0;
};

const parseUrlHostForDebug = (value = "") => {
	if (typeof value !== "string" || !value) return null;
	try {
		return new URL(value).host || null;
	} catch {
		return null;
	}
};

const truncateForDebug = (value = "", max = 80) => {
	if (typeof value !== "string" || !value) return null;
	if (value.length <= max) return value;
	return `${value.slice(0, max)}...`;
};

const toBufferIfPresent = (value) => {
	if (!value) return null;
	if (Buffer.isBuffer(value)) return value;
	if (value instanceof Uint8Array) return Buffer.from(value);
	if (
		typeof value === "object" &&
		value?.type === "Buffer" &&
		Array.isArray(value?.data)
	) {
		return Buffer.from(value.data);
	}
	if (typeof value === "string") return Buffer.from(value, "binary");
	return null;
};

const getPlaintextNodes = (content = []) => {
	if (!Array.isArray(content)) return [];
	return content.filter((entry) => entry?.tag === "plaintext");
};

const decodeNewsletterPlaintextNode = (node = {}) => {
	const payload = toBufferIfPresent(node?.content);
	if (!payload) return null;
	try {
		const decoded = proto.Message.decode(payload);
		return decoded && typeof decoded.toJSON === "function"
			? decoded.toJSON()
			: decoded;
	} catch {
		return null;
	}
};

const parseNewsletterFetchEntry = (entry = {}) => {
	if (!entry || typeof entry !== "object") return null;
	const serverId = normalizeBridgeMessageId(
		getNewsletterServerIdFromMessage(entry) ||
			entry?.attrs?.message_id ||
			entry?.attrs?.server_id ||
			entry?.id ||
			entry?.message_id ||
			entry?.server_id ||
			entry?.key?.id,
	);
	if (!isLikelyNewsletterServerId(serverId)) return null;

	const messageTimestamp = toIntegerOrNull(
		entry?.messageTimestamp ??
			entry?.timestamp ??
			entry?.ts ??
			entry?.t ??
			entry?.attrs?.t,
	);

	let payload = null;
	if (entry?.message && typeof entry.message === "object") {
		payload = entry.message;
	} else if (entry?.msg && typeof entry.msg === "object") {
		payload = entry.msg;
	}
	if (!payload) {
		const plaintextNode = getPlaintextNodes(entry?.content)[0];
		payload = decodeNewsletterPlaintextNode(plaintextNode);
	}

	const { type, text } = getNewsletterSignatureFromMessagePayload(
		payload || {},
	);
	return {
		id: serverId,
		timestamp: messageTimestamp,
		type,
		text,
	};
};

const parseNewsletterFetchMessagesResult = (result) => {
	const entries = [];
	const visited = new Set();
	const queue = [result];
	const enqueue = (value) => {
		if (value == null) return;
		queue.push(value);
	};

	while (queue.length) {
		const current = queue.shift();
		if (current == null) continue;
		if (Array.isArray(current)) {
			current.forEach(enqueue);
			continue;
		}
		if (typeof current !== "object") continue;
		if (visited.has(current)) continue;
		visited.add(current);

		const parsed = parseNewsletterFetchEntry(current);
		if (parsed) {
			entries.push(parsed);
		}

		if (Array.isArray(current.messages)) {
			current.messages.forEach(enqueue);
		}
		if (Array.isArray(current.content)) {
			current.content.forEach(enqueue);
		}
		if (current.message && typeof current.message === "object") {
			enqueue(current.message);
		}
	}

	const deduped = new Map();
	for (const entry of entries) {
		if (!entry?.id) continue;
		const existing = deduped.get(entry.id);
		const existingTs = toIntegerOrNull(existing?.timestamp) || 0;
		const nextTs = toIntegerOrNull(entry.timestamp) || 0;
		if (!existing || nextTs >= existingTs) {
			deduped.set(entry.id, entry);
		}
	}
	return [...deduped.values()].sort((a, b) => {
		const tsA = toIntegerOrNull(a?.timestamp) || 0;
		const tsB = toIntegerOrNull(b?.timestamp) || 0;
		return tsB - tsA;
	});
};

const findNewsletterServerIdFromFetchedMessages = ({
	messages = [],
	pending = null,
}) => {
	if (!Array.isArray(messages) || !messages.length) return null;
	const pendingText = normalizeNewsletterSignatureText(pending?.text || "");
	const pendingType = typeof pending?.type === "string" ? pending.type : "";
	const pendingTimestamp = toIntegerOrNull(
		Math.floor((pending?.timestamp || 0) / 1000),
	);
	const nowTs = Math.floor(Date.now() / 1000);
	const anchorTs = pendingTimestamp || nowTs;

	const recentMessages = messages.filter((entry) => {
		const ts = toIntegerOrNull(entry?.timestamp);
		if (!ts) return true;
		return Math.abs(ts - anchorTs) <= NEWSLETTER_SERVER_ID_FETCH_WINDOW_SECONDS;
	});
	const pool = recentMessages.length ? recentMessages : messages;

	if (pendingType && pendingText) {
		const exact = pool.find(
			(entry) => entry.type === pendingType && entry.text === pendingText,
		);
		if (exact?.id) return exact.id;
	}
	if (pendingText) {
		const byText = pool.find((entry) => entry.text === pendingText);
		if (byText?.id) return byText.id;
	}
	if (pendingType && pendingTimestamp) {
		const typed = pool
			.filter(
				(entry) =>
					entry.type === pendingType && toIntegerOrNull(entry.timestamp),
			)
			.sort(
				(a, b) =>
					Math.abs(toIntegerOrNull(a.timestamp) - pendingTimestamp) -
					Math.abs(toIntegerOrNull(b.timestamp) - pendingTimestamp),
			);
		const typedBest = typed[0];
		if (
			typedBest?.id &&
			Math.abs(toIntegerOrNull(typedBest.timestamp) - pendingTimestamp) <=
				NEWSLETTER_SERVER_ID_FETCH_FALLBACK_WINDOW_SECONDS
		) {
			return typedBest.id;
		}
	}
	if (pendingTimestamp) {
		const byTime = pool
			.filter((entry) => toIntegerOrNull(entry.timestamp))
			.sort(
				(a, b) =>
					Math.abs(toIntegerOrNull(a.timestamp) - pendingTimestamp) -
					Math.abs(toIntegerOrNull(b.timestamp) - pendingTimestamp),
			);
		const closest = byTime[0];
		if (
			closest?.id &&
			Math.abs(toIntegerOrNull(closest.timestamp) - pendingTimestamp) <=
				NEWSLETTER_SERVER_ID_FETCH_FALLBACK_WINDOW_SECONDS
		) {
			return closest.id;
		}
	}
	return null;
};

const guessAttachmentExtension = (value = "") => {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	const noFragment = trimmed.split("#")[0];
	const noQuery = noFragment.split("?")[0];
	const base = noQuery.split("/").filter(Boolean).pop() || noQuery;
	const match = base.match(/\.([a-z0-9]{1,16})$/i);
	return match ? match[1].toLowerCase() : null;
};
const inferAttachmentMimeType = (attachment = {}) => {
	const rawContentType = attachment?.contentType || attachment?.content_type;
	if (typeof rawContentType === "string") {
		const normalized = rawContentType.split(";")[0].trim().toLowerCase();
		if (
			normalized.includes("/") &&
			normalized !== "application/octet-stream" &&
			normalized !== "binary/octet-stream"
		) {
			return normalized;
		}
	}
	const extension =
		guessAttachmentExtension(attachment?.name) ||
		guessAttachmentExtension(attachment?.url);
	if (extension && DISCORD_ATTACHMENT_MIME_BY_EXTENSION[extension]) {
		return DISCORD_ATTACHMENT_MIME_BY_EXTENSION[extension];
	}
	return "application/octet-stream";
};
const normalizeAttachmentForWhatsAppSend = (attachment = {}) => {
	const normalized = { ...attachment };
	const normalizedName =
		typeof attachment?.name === "string" && attachment.name.trim()
			? attachment.name.trim()
			: "";
	const extensionFromName = guessAttachmentExtension(normalizedName);
	const extensionFromUrl = guessAttachmentExtension(attachment?.url);
	const mimetype = inferAttachmentMimeType(attachment);
	const extFromMime = mimetype.includes("/")
		? mimetype.split("/")[1]?.split("+")?.[0]
		: null;
	const extension =
		extensionFromName || extensionFromUrl || extFromMime || "bin";
	normalized.name = normalizedName || `attachment.${extension}`;
	normalized.contentType = mimetype;
	return normalized;
};

const isNewsletterSupportedMediaAttachment = (attachment = {}) => {
	const normalized = normalizeAttachmentForWhatsAppSend(attachment);
	if (normalized?.isSticker) {
		return false;
	}
	const mimetype = normalizeMimeType(normalized.contentType);
	const majorType = mimetype.split("/")[0];
	return majorType === "image" || majorType === "video";
};

const normalizeMimeType = (value = "") => {
	if (typeof value !== "string") return "";
	return value.split(";")[0].trim().toLowerCase();
};

const isNewsletterImageContent = (content = {}) => {
	if (!content?.image) return false;
	const mimetype = normalizeMimeType(content?.mimetype);
	if (!mimetype) return true;
	return mimetype.startsWith("image/");
};

const loadImageBufferForNormalization = async (source = null) => {
	if (Buffer.isBuffer(source)) {
		return source;
	}
	if (source instanceof Uint8Array) {
		return Buffer.from(source);
	}
	const sourceUrl = typeof source?.url === "string" ? source.url.trim() : "";
	if (sourceUrl.startsWith("data:")) {
		const commaIndex = sourceUrl.indexOf(",");
		if (commaIndex < 0) {
			return null;
		}
		const meta = sourceUrl.slice(0, commaIndex);
		const payload = sourceUrl.slice(commaIndex + 1);
		if (!payload) {
			return null;
		}
		const isBase64 = /;base64$/i.test(meta);
		const decoded = isBase64
			? Buffer.from(payload, "base64")
			: Buffer.from(decodeURIComponent(payload), "utf8");
		if (decoded.length > NEWSLETTER_IMAGE_NORMALIZATION_MAX_BYTES) {
			throw new Error(`buffer_length_exceeded:${decoded.length}`);
		}
		return decoded;
	}
	if (!/^https?:\/\//i.test(sourceUrl)) {
		return null;
	}
	const result = await utils.requests.fetchPublicBuffer(sourceUrl, {
		maxBytes: NEWSLETTER_IMAGE_NORMALIZATION_MAX_BYTES,
		accept: "image/*,*/*;q=0.8",
	});
	return result?.buffer || null;
};

const buildDocumentFallbackContent = ({
	attachment,
	content,
	sourceMime = "",
	documentSource = null,
} = {}) => {
	const fallbackSource = documentSource || content?.image || content?.document;
	if (!fallbackSource) {
		return content;
	}
	return {
		document: fallbackSource,
		mimetype:
			sourceMime ||
			normalizeMimeType(content?.mimetype) ||
			"application/octet-stream",
		fileName:
			attachment?.name ||
			(typeof content?.fileName === "string" && content.fileName.trim()
				? content.fileName.trim()
				: "attachment"),
	};
};

const chooseNormalizedStaticImageMimeType = ({
	sourceMime = "",
	hasAlpha = false,
} = {}) =>
	hasAlpha || WHATSAPP_PREFER_PNG_NORMALIZATION_MIME_TYPES.has(sourceMime)
		? "image/png"
		: "image/jpeg";

const buildNormalizedImageContent = ({
	content,
	outboundBuffer,
	outboundMime,
	width = null,
	height = null,
} = {}) => {
	const normalizedContent = {
		...content,
		image: outboundBuffer,
		mimetype: outboundMime,
	};
	if (width) {
		normalizedContent.width = width;
	} else {
		delete normalizedContent.width;
	}
	if (height) {
		normalizedContent.height = height;
	} else {
		delete normalizedContent.height;
	}
	return normalizedContent;
};

const normalizeImageBufferWithSharp = async ({
	sourceBuffer,
	sourceMime,
} = {}) => {
	const sharp = await getImageSharp();
	if (!sharp) {
		return null;
	}
	const image = sharp(sourceBuffer, { animated: true });
	const metadata = await image.metadata();
	const width = toIntegerOrNull(metadata?.width);
	const height = toIntegerOrNull(metadata?.height);
	const frameCount = toIntegerOrNull(metadata?.pages) || 1;
	if (frameCount > 1) {
		return {
			decoder: "sharp",
			animated: true,
			width,
			height,
		};
	}
	const outboundMime = chooseNormalizedStaticImageMimeType({
		sourceMime,
		hasAlpha: metadata?.hasAlpha === true,
	});
	const outboundBuffer =
		outboundMime === "image/jpeg"
			? await image.rotate().jpeg({ quality: 82 }).toBuffer()
			: await image.rotate().png().toBuffer();
	return {
		decoder: "sharp",
		animated: false,
		outboundBuffer,
		outboundMime,
		width,
		height,
	};
};

const readImageDimensionsWithSharp = async ({ sourceBuffer } = {}) => {
	const sharp = await getImageSharp();
	if (!sharp) {
		return null;
	}
	const metadata = await sharp(sourceBuffer, { animated: true }).metadata();
	return {
		decoder: "sharp",
		width: toIntegerOrNull(metadata?.width),
		height: toIntegerOrNull(metadata?.height),
	};
};

const buildJpegThumbnailWithSharp = async ({ sourceBuffer } = {}) => {
	const sharp = await getImageSharp();
	if (!sharp) {
		return null;
	}
	const image = sharp(sourceBuffer, { animated: true });
	const metadata = await image.metadata();
	return {
		decoder: "sharp",
		jpegThumbnail: await image
			.resize({
				width: WHATSAPP_OUTBOUND_JPEG_THUMB_WIDTH,
				fit: "inside",
				withoutEnlargement: true,
			})
			.jpeg({ quality: WHATSAPP_OUTBOUND_JPEG_THUMB_QUALITY })
			.toBuffer(),
		width: toIntegerOrNull(metadata?.width),
		height: toIntegerOrNull(metadata?.height),
	};
};

const ensureImageThumbForWhatsAppSend = async ({
	content,
	jid,
	discordMessageId,
} = {}) => {
	if (isNewsletterJid(jid) || !content?.image || content?.jpegThumbnail) {
		return content;
	}
	const normalizedSourceMime = normalizeMimeType(content?.mimetype);
	if (normalizedSourceMime && !normalizedSourceMime.startsWith("image/")) {
		return content;
	}
	try {
		const sourceBuffer = await loadImageBufferForNormalization(content?.image);
		if (!sourceBuffer?.length) {
			return content;
		}
		for (const buildThumbnail of [buildJpegThumbnailWithSharp]) {
			try {
				const thumbnailResult = await buildThumbnail({ sourceBuffer });
				if (!thumbnailResult?.jpegThumbnail?.length) {
					continue;
				}
				return {
					...content,
					jpegThumbnail: thumbnailResult.jpegThumbnail,
					width: content.width || thumbnailResult.width || undefined,
					height: content.height || thumbnailResult.height || undefined,
				};
			} catch (err) {
				state.logger?.debug?.(
					{
						err,
						jid,
						discordMessageId: normalizeBridgeMessageId(discordMessageId),
						sourceMime: normalizedSourceMime || null,
					},
					"Failed to generate outbound WhatsApp image thumbnail",
				);
			}
		}
	} catch (err) {
		state.logger?.debug?.(
			{
				err,
				jid,
				discordMessageId: normalizeBridgeMessageId(discordMessageId),
				sourceMime: normalizedSourceMime || null,
			},
			"Failed to load outbound Discord image while preparing WhatsApp thumbnail",
		);
	}
	return content;
};

const getAlbumEligibleMediaKind = (content = {}) => {
	if (content?.image && !content?.document && !content?.audio) {
		return "image";
	}
	if (content?.video && !content?.document && !content?.audio) {
		return "video";
	}
	return "";
};

const buildAttachmentCaptionText = ({
	text,
	hasOnlyCustomEmoji,
	isForwardedFromDiscord,
	useNewsletterSpecialFlow,
	hasReplyReference,
	options,
	ensureNewsletterReplyFallbackContext,
	prependReplyFallbackContext,
} = {}) => {
	let captionText = hasOnlyCustomEmoji ? "" : text;
	if (isForwardedFromDiscord) {
		captionText = captionText ? `Forwarded\n${captionText}` : "Forwarded";
	}
	if (useNewsletterSpecialFlow && hasReplyReference && !options?.quoted) {
		return ensureNewsletterReplyFallbackContext().then((replyContext) =>
			prependReplyFallbackContext(captionText, replyContext),
		);
	}
	return Promise.resolve(captionText);
};

const buildAlbumRelayOptions = ({ client, jid, messageId } = {}) => {
	if (
		!client ||
		typeof client.relayMessage !== "function" ||
		typeof client.waUploadToServer !== "function"
	) {
		return null;
	}
	const userJid =
		client.user?.id ||
		authState?.creds?.me?.id ||
		state.waClient?.user?.id ||
		null;
	if (!userJid) {
		return null;
	}
	return {
		jid,
		userJid,
		messageId,
		logger: state.logger,
		upload: client.waUploadToServer,
		options: undefined,
	};
};

const sendMediaAlbumToWhatsApp = async ({
	client,
	jid,
	discordMessageId,
	contents,
	captionText = "",
	mentionJids = [],
	mentionAll = false,
	quoted = null,
} = {}) => {
	const relayBaseOptions = buildAlbumRelayOptions({
		client,
		jid,
		messageId: discordMessageId,
	});
	if (!relayBaseOptions || !Array.isArray(contents) || contents.length < 2) {
		return null;
	}

	let startedRelay = false;
	let sentChildren = 0;
	try {
		const preparedMedia = [];
		for (const content of contents) {
			const mediaKind = getAlbumEligibleMediaKind(content);
			if (!mediaKind) {
				return null;
			}
			const prepared = await prepareWAMessageMedia(content, relayBaseOptions);
			const messageType =
				mediaKind === "image" ? "imageMessage" : "videoMessage";
			const payload = prepared?.[messageType];
			if (!payload) {
				return null;
			}
			preparedMedia.push({ messageType, payload: { ...payload } });
		}

		const parentMessage = generateWAMessageFromContent(
			jid,
			proto.Message.fromObject({
				albumMessage: {
					expectedImageCount: preparedMedia.filter(
						(entry) => entry.messageType === "imageMessage",
					).length,
					expectedVideoCount: preparedMedia.filter(
						(entry) => entry.messageType === "videoMessage",
					).length,
				},
			}),
			{
				userJid: relayBaseOptions.userJid,
				messageId: generateMessageIDV2(relayBaseOptions.userJid),
			},
		);

		await client.relayMessage(jid, parentMessage.message, {
			messageId: parentMessage.key.id,
		});
		startedRelay = true;
		mapDiscordMessageToWhatsAppMessage({
			discordMessageId,
			sentMessage: parentMessage,
			isNewsletter: false,
		});
		storeMessage(parentMessage);

		for (const [index, entry] of preparedMedia.entries()) {
			const payload = {
				...entry.payload,
				contextInfo: { ...(entry.payload.contextInfo || {}) },
			};
			if (index === 0) {
				if (captionText) {
					payload.caption = captionText;
				}
				if (mentionJids.length) {
					payload.contextInfo.mentionedJid = mentionJids;
				}
				if (mentionAll) {
					payload.contextInfo.nonJidMentions = 1;
				}
			}
			const childMessage = generateWAMessageFromContent(
				jid,
				proto.Message.fromObject({
					[entry.messageType]: payload,
					messageContextInfo: {
						messageAssociation: {
							associationType:
								proto.MessageAssociation.AssociationType.MEDIA_ALBUM,
							parentMessageKey: parentMessage.key,
							messageIndex: index,
						},
					},
				}),
				{
					userJid: relayBaseOptions.userJid,
					messageId: generateMessageIDV2(relayBaseOptions.userJid),
					quoted: index === 0 ? quoted : undefined,
				},
			);
			await client.relayMessage(jid, childMessage.message, {
				messageId: childMessage.key.id,
			});
			storeMessage(childMessage);
			const childId = normalizeBridgeMessageId(childMessage?.key?.id);
			if (childId) {
				state.lastMessages[childId] = discordMessageId;
				state.sentMessages.add(childId);
			}
			sentChildren += 1;
		}

		return {
			parentMessage,
			sentChildren,
			startedRelay: true,
		};
	} catch (err) {
		return {
			error: err,
			sentChildren,
			startedRelay,
		};
	}
};

const chunkList = (list = [], size = 1) => {
	const chunkSize = Number.isInteger(size) && size > 0 ? size : 1;
	const chunks = [];
	for (let index = 0; index < list.length; index += chunkSize) {
		chunks.push(list.slice(index, index + chunkSize));
	}
	return chunks;
};

const normalizeNewsletterImageSendContent = async ({
	content,
	jid,
	discordMessageId,
} = {}) => {
	if (!isNewsletterJid(jid) || !isNewsletterImageContent(content)) {
		return content;
	}
	const normalizedSourceMime = normalizeMimeType(content?.mimetype);
	const shouldForceJpeg =
		!NEWSLETTER_IMAGE_JPEG_MIME_TYPES.has(normalizedSourceMime);
	try {
		const sourceBuffer = await loadImageBufferForNormalization(content?.image);
		if (!sourceBuffer?.length) {
			return content;
		}
		let outboundBuffer = sourceBuffer;
		let outboundMime =
			normalizedSourceMime || content?.mimetype || "image/jpeg";
		let width = null;
		let height = null;
		let lastNormalizationError = null;

		if (shouldForceJpeg) {
			for (const normalizeBuffer of [normalizeImageBufferWithSharp]) {
				try {
					const normalizedResult = await normalizeBuffer({
						sourceBuffer,
						sourceMime: "image/jpeg",
					});
					if (!normalizedResult?.outboundBuffer?.length) {
						continue;
					}
					outboundBuffer = normalizedResult.outboundBuffer;
					outboundMime = normalizedResult.outboundMime || "image/jpeg";
					width = normalizedResult.width;
					height = normalizedResult.height;
					lastNormalizationError = null;
					break;
				} catch (err) {
					lastNormalizationError = err;
				}
			}
			if (!width || !height) {
				for (const readImageDimensions of [readImageDimensionsWithSharp]) {
					try {
						const dimensions = await readImageDimensions({ sourceBuffer });
						if (!dimensions) {
							continue;
						}
						width = dimensions.width;
						height = dimensions.height;
						break;
					} catch {}
				}
			}
			if (outboundMime !== "image/jpeg" && lastNormalizationError) {
				state.logger?.debug?.(
					{
						err: lastNormalizationError,
						jid,
						discordMessageId: normalizeBridgeMessageId(discordMessageId),
						sourceMime: normalizedSourceMime || null,
					},
					"Failed to decode newsletter image for JPEG normalization; falling back to raw buffer send",
				);
				outboundMime = normalizedSourceMime || "image/jpeg";
			}
		} else {
			for (const readImageDimensions of [readImageDimensionsWithSharp]) {
				try {
					const dimensions = await readImageDimensions({ sourceBuffer });
					if (!dimensions) {
						continue;
					}
					width = dimensions.width;
					height = dimensions.height;
					break;
				} catch {}
			}
		}

		const normalizedContent = {
			...content,
			image: outboundBuffer,
			mimetype: outboundMime,
		};
		if (width) normalizedContent.width = width;
		if (height) normalizedContent.height = height;
		state.logger?.debug?.(
			{
				jid,
				discordMessageId: normalizeBridgeMessageId(discordMessageId),
				sourceMime: normalizedSourceMime || null,
				sourceBytes: sourceBuffer.length,
				outboundBytes: outboundBuffer.length,
				outboundMime,
				transformed: shouldForceJpeg && outboundMime === "image/jpeg",
				width,
				height,
			},
			"Prepared newsletter image attachment payload before send",
		);
		return normalizedContent;
	} catch (err) {
		state.logger?.debug?.(
			{
				err,
				jid,
				discordMessageId: normalizeBridgeMessageId(discordMessageId),
				sourceMime: normalizedSourceMime || null,
			},
			"Failed to normalize newsletter image attachment",
		);
		return content;
	}
};

const normalizeRegularImageSendContentForWhatsApp = async ({
	attachment,
	content,
	jid,
	discordMessageId,
} = {}) => {
	if (isNewsletterJid(jid) || !content?.image) {
		return content;
	}
	const normalizedSourceMime = normalizeMimeType(content?.mimetype);
	if (
		!normalizedSourceMime.startsWith("image/") ||
		WHATSAPP_SAFE_IMAGE_MIME_TYPES.has(normalizedSourceMime) ||
		WHATSAPP_PRESERVE_SOURCE_IMAGE_MIME_TYPES.has(normalizedSourceMime)
	) {
		return content;
	}
	const fallbackToDocument = (documentSource = null) =>
		buildDocumentFallbackContent({
			attachment,
			content,
			sourceMime: normalizedSourceMime,
			documentSource,
		});
	try {
		const sourceBuffer = await loadImageBufferForNormalization(content?.image);
		if (!sourceBuffer?.length) {
			state.logger?.debug?.(
				{
					jid,
					discordMessageId: normalizeBridgeMessageId(discordMessageId),
					sourceMime: normalizedSourceMime || null,
				},
				"Could not load unsupported Discord image for normalization; falling back to document send",
			);
			return fallbackToDocument();
		}

		for (const normalizeBuffer of [normalizeImageBufferWithSharp]) {
			try {
				const normalizedResult = await normalizeBuffer({
					sourceBuffer,
					sourceMime: normalizedSourceMime,
				});
				if (!normalizedResult) {
					continue;
				}
				if (normalizedResult.animated) {
					state.logger?.debug?.(
						{
							jid,
							discordMessageId: normalizeBridgeMessageId(discordMessageId),
							sourceMime: normalizedSourceMime || null,
							sourceBytes: sourceBuffer.length,
							decoder: normalizedResult.decoder,
						},
						"Unsupported animated Discord image cannot be safely flattened; falling back to document send",
					);
					return fallbackToDocument(sourceBuffer);
				}
				if (!normalizedResult.outboundBuffer?.length) {
					continue;
				}
				state.logger?.debug?.(
					{
						jid,
						discordMessageId: normalizeBridgeMessageId(discordMessageId),
						sourceMime: normalizedSourceMime || null,
						sourceBytes: sourceBuffer.length,
						outboundBytes: normalizedResult.outboundBuffer.length,
						outboundMime: normalizedResult.outboundMime,
						width: normalizedResult.width,
						height: normalizedResult.height,
						decoder: normalizedResult.decoder,
					},
					"Normalized Discord image attachment before WhatsApp send",
				);
				return buildNormalizedImageContent({
					content,
					outboundBuffer: normalizedResult.outboundBuffer,
					outboundMime: normalizedResult.outboundMime,
					width: normalizedResult.width,
					height: normalizedResult.height,
				});
			} catch (err) {
				state.logger?.debug?.(
					{
						err,
						jid,
						discordMessageId: normalizeBridgeMessageId(discordMessageId),
						sourceMime: normalizedSourceMime || null,
					},
					"Failed to decode unsupported Discord image with normalizer",
				);
			}
		}

		state.logger?.debug?.(
			{
				jid,
				discordMessageId: normalizeBridgeMessageId(discordMessageId),
				sourceMime: normalizedSourceMime || null,
				sourceBytes: sourceBuffer.length,
			},
			"No supported decoder was available for unsupported Discord image; falling back to document send",
		);
		return fallbackToDocument(sourceBuffer);
	} catch (err) {
		state.logger?.debug?.(
			{
				err,
				jid,
				discordMessageId: normalizeBridgeMessageId(discordMessageId),
				sourceMime: normalizedSourceMime || null,
			},
			"Failed to pre-normalize Discord image attachment",
		);
		return fallbackToDocument();
	}
};

const getNewsletterMediaField = (content = {}) => {
	if (content?.image) return ["image", content.image];
	if (content?.video) return ["video", content.video];
	if (content?.audio) return ["audio", content.audio];
	if (content?.document) return ["document", content.document];
	return [null, null];
};

const summarizeNewsletterContentForDebug = (content = {}) => {
	const [kind, media] = getNewsletterMediaField(content);
	const source = Buffer.isBuffer(media)
		? "buffer"
		: media instanceof Uint8Array
			? "uint8array"
			: media && typeof media === "object" && typeof media.url === "string"
				? "url"
				: typeof media === "string"
					? "string"
					: "none";
	return {
		kind: kind || (typeof content?.text === "string" ? "text" : "unknown"),
		source,
		textLength: typeof content?.text === "string" ? content.text.length : 0,
		captionLength:
			typeof content?.caption === "string" ? content.caption.length : 0,
		mimetype: typeof content?.mimetype === "string" ? content.mimetype : null,
		fileName: typeof content?.fileName === "string" ? content.fileName : null,
	};
};

const buildNewsletterActionKey = ({
	remoteJid,
	actionId,
	fromMe = true,
} = {}) => {
	const normalizedRemoteJid = normalizeSendJid(remoteJid);
	const normalizedActionId = normalizeBridgeMessageId(actionId);
	if (!normalizedRemoteJid || !normalizedActionId) {
		return null;
	}
	const key = {
		remoteJid: normalizedRemoteJid,
		fromMe: Boolean(fromMe),
	};
	if (isLikelyNewsletterServerId(normalizedActionId)) {
		key.id = "";
		key.server_id = normalizedActionId;
	} else {
		key.id = normalizedActionId;
	}
	return key;
};

const buildSendOptionsForJid = (jid) => {
	const normalizedJid = normalizeSendJid(jid);
	return isBroadcastJid(normalizedJid) ? { broadcast: true } : {};
};
const mapDiscordMessageToWhatsAppMessage = ({
	discordMessageId,
	sentMessage,
	isNewsletter = false,
}) => {
	const outboundIdRaw = sentMessage?.key?.id;
	const outboundId = normalizeBridgeMessageId(outboundIdRaw);
	const serverId = isNewsletter
		? getNewsletterServerIdFromMessage(sentMessage)
		: null;
	const preferredId = serverId || outboundId || null;
	if (!discordMessageId || !preferredId) return;

	state.lastMessages[discordMessageId] = preferredId;
	state.lastMessages[preferredId] = discordMessageId;

	if (outboundId) {
		state.lastMessages[outboundId] = discordMessageId;
		state.sentMessages.add(outboundId);
	}
	if (serverId && outboundId && serverId !== outboundId) {
		state.lastMessages[discordMessageId] = serverId;
	}
	if (serverId && serverId !== outboundId) {
		state.sentMessages.add(serverId);
	}
};

const clearFailedNewsletterMapping = ({ discordMessageId, sentMessage }) => {
	const normalizedDiscordMessageId = normalizeBridgeMessageId(discordMessageId);
	if (!normalizedDiscordMessageId) return;
	const outboundId = normalizeBridgeMessageId(sentMessage?.key?.id);
	const serverId = normalizeBridgeMessageId(
		getNewsletterServerIdFromMessage(sentMessage),
	);
	clearPendingNewsletterSends({
		jid: sentMessage?.key?.remoteJid,
		discordMessageId: normalizedDiscordMessageId,
		outboundId,
	});
	const removeIfMatches = (key) => {
		if (!key) return;
		if (state.lastMessages[key] === normalizedDiscordMessageId) {
			delete state.lastMessages[key];
		}
	};
	if (
		state.lastMessages[normalizedDiscordMessageId] === outboundId ||
		(serverId && state.lastMessages[normalizedDiscordMessageId] === serverId)
	) {
		delete state.lastMessages[normalizedDiscordMessageId];
	}
	removeIfMatches(outboundId);
	removeIfMatches(serverId);
	if (outboundId) state.sentMessages.delete(outboundId);
	if (serverId) state.sentMessages.delete(serverId);
};

const mapNewsletterServerIdFromOutbound = ({ outboundId, serverId }) => {
	const normalizedOutboundId = normalizeBridgeMessageId(outboundId);
	const normalizedServerId = normalizeBridgeMessageId(serverId);
	if (
		!normalizedOutboundId ||
		!normalizedServerId ||
		normalizedOutboundId === normalizedServerId
	) {
		return null;
	}
	const discordMessageId = normalizeBridgeMessageId(
		state.lastMessages[normalizedOutboundId],
	);
	if (!discordMessageId) {
		return null;
	}
	clearPendingNewsletterSends({
		discordMessageId,
		outboundId: normalizedOutboundId,
	});
	state.lastMessages[discordMessageId] = normalizedServerId;
	state.lastMessages[normalizedServerId] = discordMessageId;
	state.sentMessages.add(normalizedServerId);
	return normalizedServerId;
};

const mapPendingNewsletterServerId = ({
	jid,
	serverId,
	pending = null,
	source = "unknown",
	updateTimestamp = null,
} = {}) => {
	const normalizedJid = normalizeSendJid(jid);
	const normalizedServerId = normalizeBridgeMessageId(serverId);
	if (
		!isNewsletterJid(normalizedJid) ||
		!isLikelyNewsletterServerId(normalizedServerId)
	) {
		return null;
	}

	const resolvedPending =
		pending ||
		resolvePendingNewsletterSend({
			jid: normalizedJid,
			serverId: normalizedServerId,
			message: null,
		});
	const mappedDiscordMessageId = normalizeBridgeMessageId(
		resolvedPending?.discordMessageId,
	);
	if (!mappedDiscordMessageId) {
		return null;
	}
	const mappedOutboundId = normalizeBridgeMessageId(
		resolvedPending?.outboundId,
	);

	state.lastMessages[mappedDiscordMessageId] = normalizedServerId;
	state.lastMessages[normalizedServerId] = mappedDiscordMessageId;
	if (mappedOutboundId) {
		state.lastMessages[mappedOutboundId] = mappedDiscordMessageId;
		state.lastMessages[mappedDiscordMessageId] = normalizedServerId;
	}
	state.sentMessages.add(normalizedServerId);
	clearPendingNewsletterSends({
		jid: normalizedJid,
		discordMessageId: mappedDiscordMessageId,
		outboundId: mappedOutboundId || null,
	});

	const ts = toIntegerOrNull(updateTimestamp);
	if (ts && ts > state.startTime) {
		state.startTime = ts;
	}

	state.logger?.info?.(
		{
			jid: normalizedJid,
			discordMessageId: mappedDiscordMessageId,
			candidateId: mappedOutboundId || undefined,
			serverId: normalizedServerId,
			source,
		},
		"Mapped newsletter server ID from pending send",
	);

	return {
		jid: normalizedJid,
		discordMessageId: mappedDiscordMessageId,
		outboundId: mappedOutboundId,
		serverId: normalizedServerId,
	};
};

const ensureNewsletterLiveUpdatesSubscription = async (client, jid) => {
	if (typeof client?.subscribeNewsletterUpdates !== "function") {
		return;
	}
	const normalizedJid = normalizeSendJid(jid);
	if (!isNewsletterJid(normalizedJid)) {
		return;
	}
	const now = Date.now();
	const expiresAt = newsletterLiveUpdatesExpiresAt.get(normalizedJid) || 0;
	if (expiresAt > now) {
		return;
	}
	try {
		const result = await client.subscribeNewsletterUpdates(normalizedJid);
		const durationSeconds = toIntegerOrNull(result?.duration);
		const ttlMs =
			durationSeconds && durationSeconds > 0
				? Math.max(60 * 1000, (durationSeconds - 15) * 1000)
				: NEWSLETTER_SUBSCRIPTION_DEFAULT_TTL_MS;
		newsletterLiveUpdatesExpiresAt.set(normalizedJid, now + ttlMs);
		state.logger?.debug?.(
			{ jid: normalizedJid, duration: durationSeconds || null },
			"Subscribed to newsletter live updates for server ID mapping",
		);
	} catch (err) {
		newsletterLiveUpdatesExpiresAt.set(
			normalizedJid,
			now + NEWSLETTER_SUBSCRIPTION_RETRY_TTL_MS,
		);
		state.logger?.debug?.(
			{ err, jid: normalizedJid },
			"Failed to subscribe to newsletter live updates",
		);
	}
};

const resolveNewsletterServerIdFromFetch = async ({
	client,
	jid,
	discordMessageId,
	candidateId = null,
}) => {
	if (typeof client?.newsletterFetchMessages !== "function") {
		return null;
	}
	const normalizedJid = normalizeSendJid(jid);
	if (!isNewsletterJid(normalizedJid)) {
		return null;
	}
	const normalizedCandidateId = normalizeBridgeMessageId(candidateId);
	const normalizedDiscordMessageId = normalizeBridgeMessageId(discordMessageId);
	let pending = getPendingNewsletterSend({
		jid: normalizedJid,
		outboundId: normalizedCandidateId,
		discordMessageId: normalizedDiscordMessageId,
	});
	if (!pending && normalizedCandidateId) {
		const storedMessage = messageStore.get({
			remoteJid: normalizedJid,
			id: normalizedCandidateId,
		});
		if (storedMessage) {
			const storedTimestamp = toIntegerOrNull(
				storedMessage?.messageTimestamp ??
					storedMessage?.messageTimestampMs ??
					storedMessage?.message?.messageTimestamp,
			);
			const timestampMs = storedTimestamp
				? storedTimestamp > 1_000_000_000_000
					? storedTimestamp
					: storedTimestamp * 1000
				: Date.now();
			const signature = getNewsletterSignatureFromMessagePayload(
				storedMessage?.message || {},
			);
			pending = {
				jid: normalizedJid,
				discordMessageId: normalizedDiscordMessageId || null,
				outboundId: normalizedCandidateId,
				type: signature?.type || "",
				text: signature?.text || "",
				timestamp: timestampMs,
			};
		}
	}
	if (!pending) {
		return null;
	}
	const pendingTimestamp = Number(pending.timestamp) || 0;
	const since = pendingTimestamp
		? Math.max(
				0,
				Math.floor(
					(pendingTimestamp -
						NEWSLETTER_SERVER_ID_FETCH_WINDOW_SECONDS * 1000) /
						1000,
				),
			)
		: undefined;

	let result = null;
	try {
		result = await client.newsletterFetchMessages(
			normalizedJid,
			NEWSLETTER_SERVER_ID_FETCH_FALLBACK_COUNT,
			since,
			undefined,
		);
	} catch (err) {
		state.logger?.debug?.(
			{
				err,
				jid: normalizedJid,
				discordMessageId,
				candidateId: normalizedCandidateId,
			},
			"Failed to fetch newsletter messages for server ID resolution",
		);
		return null;
	}

	const parsedMessages = parseNewsletterFetchMessagesResult(result);
	const serverId = normalizeBridgeMessageId(
		findNewsletterServerIdFromFetchedMessages({
			messages: parsedMessages,
			pending,
		}),
	);
	if (!isLikelyNewsletterServerId(serverId)) {
		state.logger?.debug?.(
			{
				jid: normalizedJid,
				discordMessageId: normalizedDiscordMessageId || undefined,
				candidateId: normalizedCandidateId || undefined,
				parsedCount: parsedMessages.length,
			},
			"Newsletter message fetch fallback did not yield a server ID",
		);
		return null;
	}

	const mapped = mapPendingNewsletterServerId({
		jid: normalizedJid,
		serverId,
		pending: {
			...pending,
			discordMessageId: normalizedDiscordMessageId || pending.discordMessageId,
			outboundId: normalizedCandidateId || pending.outboundId,
		},
		source: "newsletter.fetch_messages",
	});
	return mapped?.serverId || null;
};

const getNodeChildren = (node = {}) =>
	Array.isArray(node?.content) ? node.content : [];

const getNodeChildrenByTag = (node = {}, tag) =>
	getNodeChildren(node).filter((entry) => entry?.tag === tag);

const parseNewsletterLiveUpdateEntries = (node = {}) => {
	const results = [];
	for (const liveUpdatesNode of getNodeChildrenByTag(node, "live_updates")) {
		for (const messagesNode of getNodeChildrenByTag(
			liveUpdatesNode,
			"messages",
		)) {
			const timestamp = toIntegerOrNull(messagesNode?.attrs?.t);
			for (const messageNode of getNodeChildrenByTag(messagesNode, "message")) {
				const serverId = normalizeBridgeMessageId(
					messageNode?.attrs?.server_id ||
						messageNode?.attrs?.message_id ||
						messageNode?.attrs?.id,
				);
				if (!isLikelyNewsletterServerId(serverId)) continue;
				const reactionsNode = getNodeChildrenByTag(messageNode, "reactions")[0];
				const hasReactionsNode = Boolean(reactionsNode);
				const reactions = getNodeChildrenByTag(reactionsNode, "reaction")
					.map((reactionNode) => ({
						code:
							typeof reactionNode?.attrs?.code === "string"
								? reactionNode.attrs.code.trim()
								: "",
						count: toIntegerOrNull(reactionNode?.attrs?.count),
					}))
					.filter((entry) => entry.code);
				results.push({
					serverId,
					timestamp,
					reactions,
					hasReactionsNode,
				});
			}
		}
	}
	return results;
};

const emitNewsletterReactionsFromLiveUpdate = ({ jid, update = {} } = {}) => {
	const normalizedJid = normalizeSendJid(jid);
	if (!isNewsletterJid(normalizedJid)) {
		return 0;
	}
	const serverId = normalizeBridgeMessageId(update?.serverId);
	if (!isLikelyNewsletterServerId(serverId)) {
		return 0;
	}
	if (!allowsWhatsAppToDiscord()) {
		return 0;
	}
	if (!utils.whatsapp.inWhitelist({ key: { remoteJid: normalizedJid } })) {
		return 0;
	}
	if (state.sentReactions.has(serverId)) {
		state.sentReactions.delete(serverId);
		return 0;
	}

	const reactions = Array.isArray(update?.reactions) ? update.reactions : [];
	let emittedCount = 0;

	for (const reaction of reactions) {
		const reactionCode =
			typeof reaction?.code === "string" ? reaction.code.trim() : "";
		if (!reactionCode) continue;
		const reactionCount = toIntegerOrNull(reaction?.count);
		const removed = reactionCount != null && reactionCount <= 0;
		state.dcClient.emit("whatsappReaction", {
			id: serverId,
			jid: normalizedJid,
			text: removed ? "" : reactionCode,
			author: `newsletter:${serverId}:${reactionCode}`,
		});
		emittedCount += 1;
	}

	if (!emittedCount && update?.hasReactionsNode) {
		// When live_updates includes <reactions/> with no child reactions,
		// treat it as a clear signal for tracked newsletter reactions.
		state.dcClient.emit("whatsappReaction", {
			id: serverId,
			jid: normalizedJid,
			text: "",
			author: `newsletter:${serverId}`,
		});
		emittedCount += 1;
	}

	return emittedCount;
};

const parseMexNewsletterServerIdCandidates = (node = {}) => {
	const fromJid = normalizeSendJid(node?.attrs?.from || "");
	const candidates = [];
	const seen = new Set();

	const pushCandidate = ({ jid, serverId }) => {
		const normalizedJid = normalizeSendJid(jid || "");
		const normalizedServerId = normalizeBridgeMessageId(serverId);
		if (
			!isNewsletterJid(normalizedJid) ||
			!isLikelyNewsletterServerId(normalizedServerId)
		) {
			return;
		}
		const key = `${normalizedJid}|${normalizedServerId}`;
		if (seen.has(key)) {
			return;
		}
		seen.add(key);
		candidates.push({ jid: normalizedJid, serverId: normalizedServerId });
	};

	const visit = (value, fallbackJid = fromJid, depth = 0) => {
		if (depth > 8 || value == null) {
			return;
		}
		if (Array.isArray(value)) {
			value.forEach((entry) => {
				visit(entry, fallbackJid, depth + 1);
			});
			return;
		}
		if (typeof value !== "object") {
			return;
		}
		const nextFallbackJid = normalizeSendJid(
			value?.newsletter_id ||
				value?.newsletterId ||
				(isNewsletterJid(value?.id) ? value.id : fallbackJid),
		);
		pushCandidate({
			jid: nextFallbackJid || fallbackJid,
			serverId:
				value?.message_server_id ||
				value?.messageServerId ||
				value?.server_id ||
				value?.serverId ||
				value?.message_id ||
				value?.messageId,
		});
		Object.values(value).forEach((entry) => {
			visit(entry, nextFallbackJid || fallbackJid, depth + 1);
		});
	};

	const updateNodes = getNodeChildrenByTag(node, "update");
	updateNodes.forEach((updateNode) => {
		const payload = toBufferIfPresent(updateNode?.content);
		if (!payload?.length) {
			return;
		}
		try {
			const parsed = JSON.parse(payload.toString("utf8"));
			visit(parsed, fromJid, 0);
		} catch {
			return;
		}
	});
	return candidates;
};

const toMentionLabel = (value) => {
	if (typeof value !== "string") return null;
	const trimmed = value.trim().replace(/^@+/, "");
	if (!trimmed) return null;
	return `@${trimmed}`;
};

const replaceLiteralMentionTokens = (text, replacements = []) => {
	if (!text || !Array.isArray(replacements) || !replacements.length)
		return text;
	let nextText = text;
	for (const replacement of replacements) {
		const value =
			typeof replacement?.value === "string" ? replacement.value.trim() : "";
		if (!value) continue;
		const rawTokens = Array.isArray(replacement?.rawTokens)
			? replacement.rawTokens
			: [];
		const candidates = [
			...new Set(
				rawTokens
					.map((token) => (typeof token === "string" ? token.trim() : ""))
					.filter(Boolean),
			),
		];
		for (const token of candidates) {
			const regex = new RegExp(escapeRegex(token), "g");
			nextText = nextText.replace(regex, value);
		}
	}
	return nextText;
};

const DISCORD_USER_MENTION_REGEX = /<@!?(\d+)>/g;
const DISCORD_ROLE_MENTION_REGEX = /<@&(\d+)>/g;
const DISCORD_EVERYONE_MENTION_REGEX =
	/@(everyone|here)(?=$|\s|[\p{P}\p{S}])/giu;
const DISCORD_REPLY_PREFIX_REGEX = /^(<@!?\d+>|@\S+)\s*/;
const DISCORD_REPLY_FALLBACK_MAX_CHARS = 160;
const DISCORD_MESSAGE_TYPE_REPLY = 19;

const isDiscordReplyReference = (message = {}) => {
	if (!message?.reference) return false;
	const type = message?.type;
	if (typeof type === "undefined" || type === null) {
		// Test doubles and some synthetic payloads may omit type.
		return true;
	}
	if (typeof type === "number") {
		return type === DISCORD_MESSAGE_TYPE_REPLY;
	}
	if (typeof type === "string") {
		const normalizedType = type.trim().toUpperCase();
		return (
			normalizedType === "REPLY" ||
			normalizedType === String(DISCORD_MESSAGE_TYPE_REPLY)
		);
	}
	return false;
};

const formatReplyFallbackText = (value = "") =>
	String(value || "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, DISCORD_REPLY_FALLBACK_MAX_CHARS);

const prependReplyFallbackContext = (text, replyContext) => {
	if (!replyContext) return text || "";
	if (!text) return replyContext;
	return `${replyContext}\n${text}`;
};

const buildNewsletterReplyFallbackContext = async (message) => {
	const channelId = message?.reference?.channelId;
	const messageId = message?.reference?.messageId;
	if (!channelId || !messageId) {
		return null;
	}
	try {
		const channel = await message?.client?.channels?.fetch?.(channelId);
		const repliedMessage = await channel?.messages?.fetch?.(messageId);
		const author =
			repliedMessage?.member?.displayName ||
			repliedMessage?.author?.globalName ||
			repliedMessage?.author?.username ||
			"Unknown";
		const rawText =
			repliedMessage?.cleanContent || repliedMessage?.content || "";
		const fallbackText =
			formatReplyFallbackText(rawText) ||
			(repliedMessage?.attachments?.size ? "[attachment]" : "[message]");
		return `Replying to ${author}: ${fallbackText}`;
	} catch {
		return `Replying to message ${messageId}`;
	}
};

const cloneNewsletterSendContentWithReplyFallback = (
	content = {},
	replyContext = "",
) => {
	if (!replyContext || !content || typeof content !== "object") {
		return content;
	}
	const next = { ...content };
	if (typeof next.text === "string") {
		next.text = prependReplyFallbackContext(next.text, replyContext);
		return next;
	}
	if (typeof next.caption === "string") {
		next.caption = prependReplyFallbackContext(next.caption, replyContext);
		return next;
	}
	next.caption = prependReplyFallbackContext("", replyContext);
	return next;
};

const notifyLinkedDiscordChannel = async (jid, text) => {
	const channelId = getChatTargetChannelId(state.chats[jid]);
	if (!channelId || !text) return;
	const channel = await utils.discord.getChannel(channelId).catch(() => null);
	await channel?.send?.(text).catch(() => {});
};

const extractMentionIdsFromText = (text, regex) => {
	const ids = new Set();
	if (typeof text !== "string" || !text) return ids;
	for (const match of text.matchAll(regex)) {
		const id = String(match[1] || "").trim();
		if (/^\d+$/.test(id)) ids.add(id);
	}
	return ids;
};

const collectDiscordMentionData = async (
	message,
	textCandidates = [],
	replyMentionId = null,
) => {
	const mentionDescriptors = [];
	const fallbackReplacements = [];
	const seenUsers = new Set();
	const seenRoles = new Set();

	const addUserMention = (user, member = null) => {
		if (!user?.id) return;
		if (replyMentionId && user.id === replyMentionId) return;
		if (seenUsers.has(user.id)) return;
		seenUsers.add(user.id);
		const displayTokens = [
			...new Set(
				[member?.displayName, user.globalName, user.username]
					.map((value) => (typeof value === "string" ? value.trim() : ""))
					.filter(Boolean),
			),
		];
		const rawTokens = [`<@${user.id}>`, `<@!${user.id}>`];
		mentionDescriptors.push({
			discordUserId: user.id,
			displayTokens,
			rawTokens,
		});
		const fallbackLabel = toMentionLabel(displayTokens[0]);
		if (fallbackLabel) {
			fallbackReplacements.push({ rawTokens, value: fallbackLabel });
		}
	};

	const addRoleMention = (role) => {
		if (!role?.id) return;
		if (seenRoles.has(role.id)) return;
		seenRoles.add(role.id);
		const fallbackLabel = toMentionLabel(role.name);
		if (!fallbackLabel) return;
		fallbackReplacements.push({
			rawTokens: [`<@&${role.id}>`],
			value: fallbackLabel,
		});
	};

	const mentionedUsers = message?.mentions?.users
		? [...message.mentions.users.values()]
		: [];
	for (const user of mentionedUsers) {
		const member = message?.mentions?.members?.get(user.id);
		addUserMention(user, member);
	}

	const mentionedRoles = message?.mentions?.roles
		? [...message.mentions.roles.values()]
		: [];
	for (const role of mentionedRoles) {
		addRoleMention(role);
	}

	const userIdsFromText = new Set();
	const roleIdsFromText = new Set();
	for (const candidate of textCandidates) {
		extractMentionIdsFromText(candidate, DISCORD_USER_MENTION_REGEX).forEach(
			(id) => {
				userIdsFromText.add(id);
			},
		);
		extractMentionIdsFromText(candidate, DISCORD_ROLE_MENTION_REGEX).forEach(
			(id) => {
				roleIdsFromText.add(id);
			},
		);
	}

	for (const userId of userIdsFromText) {
		if (replyMentionId && userId === replyMentionId) continue;
		if (seenUsers.has(userId)) continue;
		const user =
			message?.mentions?.users?.get(userId) ||
			(await message?.client?.users?.fetch?.(userId).catch(() => null));
		const member =
			message?.mentions?.members?.get(userId) ||
			message?.guild?.members?.cache?.get?.(userId) ||
			(await message?.guild?.members?.fetch?.(userId).catch(() => null));
		if (user) addUserMention(user, member);
	}

	for (const roleId of roleIdsFromText) {
		if (seenRoles.has(roleId)) continue;
		const role =
			message?.mentions?.roles?.get(roleId) ||
			message?.guild?.roles?.cache?.get?.(roleId) ||
			(await message?.guild?.roles?.fetch?.(roleId).catch(() => null));
		if (role) addRoleMention(role);
	}

	return { mentionDescriptors, fallbackReplacements };
};

const normalizeMentionJidsForChat = async (jid, mentionJids = []) => [
	...new Set(
		(
			await Promise.all(
				[
					...new Set(
						(Array.isArray(mentionJids) ? mentionJids : []).filter(Boolean),
					),
				].map((candidate) =>
					utils.whatsapp.preferMentionJidForChat(candidate, jid),
				),
			)
		).filter(Boolean),
	),
];

const resolveDiscordEveryoneMentionForWhatsApp = ({ message, text, jid }) => {
	const canMentionAll =
		typeof jid === "string" &&
		jid.endsWith("@g.us") &&
		message?.mentions?.everyone === true;
	if (!canMentionAll) return { text, mentionAll: false };

	let replaced = false;
	const sourceText = typeof text === "string" ? text : "";
	let nextText = sourceText.replace(DISCORD_EVERYONE_MENTION_REGEX, () => {
		replaced = true;
		return "@all";
	});
	if (!replaced) {
		nextText = nextText ? `@all ${nextText}` : "@all";
	}
	return { text: nextText, mentionAll: true };
};

const resolveDiscordTextMentionsForWhatsApp = async ({
	message,
	text,
	jid,
	textCandidates = [],
	replyMentionId = null,
}) => {
	const { mentionDescriptors, fallbackReplacements } =
		await collectDiscordMentionData(message, textCandidates, replyMentionId);
	const linkedMentions =
		typeof utils.whatsapp.applyDiscordMentionLinks === "function"
			? await utils.whatsapp.applyDiscordMentionLinks(
					text,
					mentionDescriptors,
					{ chatJid: jid },
				)
			: { text, mentionJids: [] };
	let updatedText = replaceLiteralMentionTokens(
		linkedMentions.text ?? text,
		fallbackReplacements,
	);
	const everyoneMention = resolveDiscordEveryoneMentionForWhatsApp({
		message,
		text: updatedText,
		jid,
	});
	updatedText = everyoneMention.text;
	const mentionJidsRaw = [
		...new Set([
			...(Array.isArray(linkedMentions.mentionJids)
				? linkedMentions.mentionJids
				: []),
			...utils.whatsapp.getMentionedJids(updatedText),
		]),
	];
	const mentionJids = await normalizeMentionJidsForChat(jid, mentionJidsRaw);
	return {
		text: updatedText,
		mentionJids,
		mentionAll: everyoneMention.mentionAll,
	};
};

const handlePollUpdateMessage = async (client, rawMessage) => {
	const pollUpdate = rawMessage?.message?.pollUpdateMessage;
	const pollKey = pollUpdate?.pollCreationMessageKey;
	if (!pollUpdate || !pollKey) return false;

	const normalizedKey = {
		...pollKey,
		remoteJid: utils.whatsapp.formatJid(
			pollKey.remoteJid || rawMessage.key?.remoteJid,
		),
		participant: utils.whatsapp.formatJid(
			pollKey.participant || pollKey.participantAlt,
		),
	};
	const pollMessage = await getStoredMessageWithJidFallback(normalizedKey);
	if (!pollMessage) {
		state.logger?.warn(
			{ key: normalizedKey },
			"Received poll vote without cached poll message",
		);
		return false;
	}

	const pollEncKey = toBuffer(
		getPollEncKey(pollMessage.message || pollMessage),
	);
	if (!pollEncKey) {
		state.logger?.warn(
			{ key: normalizedKey },
			"Missing poll enc key for incoming poll update",
		);
		return false;
	}

	const meIdRaw = utils.whatsapp.formatJid(client?.user?.id);
	const [mePrimary, meFallback] = await utils.whatsapp.hydrateJidPair(meIdRaw);
	const meId = utils.whatsapp.formatJid(mePrimary || meFallback || meIdRaw);
	const creationKeyForAuth = {
		...pollUpdate.pollCreationMessageKey,
		remoteJid: utils.whatsapp.formatJid(
			pollUpdate.pollCreationMessageKey?.remoteJid ||
				pollMessage.key?.remoteJid,
		),
		participant: utils.whatsapp.formatJid(
			pollUpdate.pollCreationMessageKey?.participant,
		),
	};
	const pollCreatorJid = pollUpdate.pollCreationMessageKey?.fromMe
		? meId
		: getKeyAuthor(creationKeyForAuth, meId);
	const voterPn = selectPnJid(
		[
			rawMessage.key?.participant,
			rawMessage.key?.remoteJid,
			pollUpdate.pollCreationMessageKey?.remoteJid,
			pollMessage.key?.remoteJid,
			pollMessage.key?.remoteJidAlt,
		].map(utils.whatsapp.formatJid),
	);
	const voterJid = voterPn || getKeyAuthor(rawMessage.key, meId);

	const encPayload = toBuffer(pollUpdate.vote?.encPayload);
	const encIv = toBuffer(pollUpdate.vote?.encIv);
	if (!encPayload || !encIv) {
		state.logger?.warn(
			{ key: normalizedKey },
			"Missing poll vote payload bytes",
		);
		return false;
	}

	const baseCreatorCandidates = [
		pollCreatorJid,
		utils.whatsapp.formatJid(pollUpdate.pollCreationMessageKey?.participant),
		utils.whatsapp.formatJid(pollUpdate.pollCreationMessageKey?.remoteJidAlt),
		utils.whatsapp.formatJid(pollMessage.key?.remoteJidAlt),
		utils.whatsapp.formatJid(pollMessage.key?.remoteJid),
	].filter(Boolean);
	const baseVoterCandidates = [
		voterJid,
		selectPnJid(
			[
				rawMessage.key?.remoteJidAlt,
				pollUpdate.pollCreationMessageKey?.remoteJidAlt,
				pollMessage.key?.remoteJidAlt,
			].map(utils.whatsapp.formatJid),
		),
		utils.whatsapp.formatJid(rawMessage.key?.remoteJidAlt),
		utils.whatsapp.formatJid(rawMessage.key?.participant),
	].filter(Boolean);

	const creatorCandidates = (
		await Promise.all(baseCreatorCandidates.map(expandJidVariants))
	)
		.flat()
		.filter(Boolean);
	const voterCandidates = (
		await Promise.all(baseVoterCandidates.map(expandJidVariants))
	)
		.flat()
		.filter(Boolean);

	let voteMsg = null;
	let usedCreator = null;
	let usedVoter = null;
	const pollMsgId =
		pollUpdate.pollCreationMessageKey?.id ||
		(pollMessage.key || normalizedKey).id;

	for (const creator of creatorCandidates) {
		for (const voter of voterCandidates) {
			try {
				voteMsg = decryptPollVote(
					{ encPayload, encIv },
					{
						pollEncKey,
						pollCreatorJid: creator,
						pollMsgId,
						voterJid: voter,
					},
				);
				usedCreator = creator;
				usedVoter = voter;
				break;
			} catch (_err) {}
		}
		if (voteMsg) break;
	}

	state.logger?.info(
		{
			key: normalizedKey,
			pollCreationKey: pollUpdate.pollCreationMessageKey,
			pollMessageKey: pollMessage?.key,
			pollCreatorCandidates: creatorCandidates,
			pollVoterCandidates: voterCandidates,
			pollCreatorJid,
			voterJid,
			usedCreator,
			usedVoter,
			encKeyLen: pollEncKey?.length,
			encPayloadLen: encPayload?.length,
			encIvLen: encIv?.length,
			success: !!voteMsg,
		},
		"Poll vote debug",
	);

	if (!voteMsg) {
		state.logger?.warn({ pollMsgId }, "Failed to decrypt poll vote");
		return false;
	}

	const update = {
		pollUpdateMessageKey: rawMessage.key,
		vote: voteMsg,
		senderTimestampMs: Number(pollUpdate.senderTimestampMs) || Date.now(),
	};

	client.ev.emit("messages.update", [
		{ key: normalizedKey, update: { pollUpdates: [update] } },
	]);
	state.logger?.info(
		{
			pollCreationKey: normalizedKey,
			pollCreatorJid: usedCreator,
			voterJid: usedVoter,
			senderTimestampMs: update.senderTimestampMs,
		},
		"Poll vote decrypted",
	);
	return true;
};

const storeMessage = (message) => {
	if (!message?.key) return;
	const normalizedKey = {
		...message.key,
		remoteJid: utils.whatsapp.formatJid(message.key.remoteJid),
		participant: utils.whatsapp.formatJid(
			message.key.participant || message.key.participantAlt,
		),
	};
	const normalizedMessage = { ...message, key: normalizedKey };
	messageStore.set(normalizedMessage);

	const serverId = normalizeBridgeMessageId(
		getNewsletterServerIdFromMessage(normalizedMessage),
	);
	if (
		isNewsletterJid(normalizedKey.remoteJid || "") &&
		serverId &&
		serverId !== normalizedKey.id
	) {
		messageStore.set({
			...normalizedMessage,
			key: {
				...normalizedKey,
				id: serverId,
			},
		});
	}
};

const cacheGroupMetadata = (metadata, client) => {
	const normalizedJid = utils.whatsapp.formatJid(metadata?.id);
	if (!normalizedJid) {
		return;
	}
	groupMetadataCache.set(normalizedJid, metadata);
	if (metadata.subject) {
		state.contacts[normalizedJid] = metadata.subject;
		client.contacts[normalizedJid] = metadata.subject;
	}
};

const groupRefreshLastRun = new Map();
const refreshGroupMetadata = async (client, groupId) => {
	const normalizedId = utils.whatsapp.formatJid(groupId);
	if (!normalizedId) {
		return null;
	}
	const now = Date.now();
	const last = groupRefreshLastRun.get(normalizedId) || 0;
	const minGapMs = 30 * 1000;
	if (now - last < minGapMs) {
		return null;
	}
	groupRefreshLastRun.set(normalizedId, now);
	try {
		groupMetadataCache.invalidate(normalizedId);
		const metadata = await client.groupMetadata(normalizedId);
		cacheGroupMetadata(metadata, client);
		return metadata;
	} catch (err) {
		const isRateLimit =
			err?.message?.includes("rate-overlimit") || err?.data === 429;
		const level = isRateLimit ? "debug" : "warn";
		state.logger?.[level]?.(
			{ err, groupId: normalizedId },
			"Failed to refresh group metadata",
		);
		if (isRateLimit) {
			groupRefreshLastRun.set(normalizedId, now + minGapMs);
		}
		return null;
	}
};

const patchGroupMetadataForCache = (client) => {
	if (
		!client ||
		client.__wa2dcGroupCachePatched ||
		typeof client.groupMetadata !== "function"
	) {
		return;
	}
	const baseGroupMetadata = client.groupMetadata.bind(client);
	client.groupMetadata = async (...args) => {
		const metadata = await baseGroupMetadata(...args);
		cacheGroupMetadata(metadata, client);
		return metadata;
	};
	client.__wa2dcGroupCachePatched = true;
};

const patchSendMessageForLinkPreviews = (client) => {
	if (
		!client ||
		client.__wa2dcLinkPreviewPatched ||
		typeof client.sendMessage !== "function"
	) {
		return;
	}
	const rewriteNewsletterDirectPath = (value = "") => {
		if (typeof value !== "string") return value;
		if (!value.startsWith("/o1/")) return value;
		return value.replace(/^\/o1\//, "/m1/");
	};
	const rewriteNewsletterMediaUrl = (value = "") => {
		if (typeof value !== "string" || !value) return value;
		try {
			const parsed = new URL(value);
			if (!parsed.pathname.startsWith("/o1/")) {
				return value;
			}
			parsed.pathname = parsed.pathname.replace(/^\/o1\//, "/m1/");
			return parsed.toString();
		} catch {
			return value;
		}
	};
	const rewriteNewsletterImageUploadResult = (
		result = {},
		uploadOptions = {},
	) => {
		if (!result || typeof result !== "object") {
			return result;
		}
		const mediaType =
			typeof uploadOptions?.mediaType === "string"
				? uploadOptions.mediaType.trim().toLowerCase()
				: "";
		if (mediaType !== "image") {
			return result;
		}
		const directPath = rewriteNewsletterDirectPath(result.directPath);
		const mediaUrl = rewriteNewsletterMediaUrl(result.mediaUrl);
		if (directPath === result.directPath && mediaUrl === result.mediaUrl) {
			return result;
		}
		state.logger?.debug?.(
			{
				mediaType,
				originalDirectPath: truncateForDebug(result.directPath, 140),
				rewrittenDirectPath: truncateForDebug(directPath, 140),
				originalMediaUrl: truncateForDebug(result.mediaUrl, 160),
				rewrittenMediaUrl: truncateForDebug(mediaUrl, 160),
			},
			"Rewrote newsletter media upload result path",
		);
		return {
			...result,
			directPath,
			mediaUrl,
		};
	};
	const defaultGetUrlInfo = (text) =>
		utils.whatsapp.generateLinkPreview(text, {
			uploadImage:
				typeof client.waUploadToServer === "function"
					? client.waUploadToServer
					: undefined,
			logger: state.logger,
		});
	const baseSendMessage = client.sendMessage.bind(client);
	client.sendMessage = async (jid, content, options) => {
		let sendJid = jid;
		try {
			if (typeof utils.whatsapp.hydrateJidPair === "function") {
				const [resolvedJid] = await utils.whatsapp.hydrateJidPair(jid);
				sendJid = resolvedJid || jid;
			} else if (typeof utils.whatsapp.formatJid === "function") {
				sendJid = utils.whatsapp.formatJid(jid) || jid;
			}
		} catch (err) {
			state.logger?.debug?.(
				{ err, jid },
				"Failed to resolve preferred WhatsApp JID for sendMessage",
			);
		}
		const normalizedOptions = options ? { ...options } : {};
		if (!normalizedOptions.logger) {
			normalizedOptions.logger = state.logger;
		}
		const newsletterChat = isNewsletterJid(sendJid);
		if (newsletterChat) {
			normalizedOptions.getUrlInfo = undefined;
			const baseUpload =
				typeof normalizedOptions.upload === "function"
					? normalizedOptions.upload
					: typeof client.waUploadToServer === "function"
						? client.waUploadToServer
						: null;
			if (typeof baseUpload === "function") {
				normalizedOptions.upload = async (filePath, uploadOptions = {}) => {
					const result = await baseUpload(filePath, uploadOptions);
					return rewriteNewsletterImageUploadResult(result, uploadOptions);
				};
			}
		}
		const needsGeneratedPreview = !newsletterChat && !content?.linkPreview;
		if (needsGeneratedPreview && !normalizedOptions.getUrlInfo) {
			normalizedOptions.getUrlInfo = defaultGetUrlInfo;
		}
		return baseSendMessage(sendJid, content, normalizedOptions);
	};
	client.__wa2dcLinkPreviewPatched = true;
};

const getNewsletterMediaTypeFromMessage = (message) => {
	if (!message || typeof message !== "object") {
		return "";
	}
	if (message.imageMessage) {
		return "image";
	}
	if (message.videoMessage) {
		return message.videoMessage.gifPlayback ? "gif" : "video";
	}
	if (message.audioMessage) {
		return message.audioMessage.ptt ? "ptt" : "audio";
	}
	if (message.contactMessage) {
		return "vcard";
	}
	if (message.documentMessage) {
		return "document";
	}
	if (message.contactsArrayMessage) {
		return "contact_array";
	}
	if (message.liveLocationMessage) {
		return "livelocation";
	}
	if (message.stickerMessage) {
		return "sticker";
	}
	if (message.listMessage) {
		return "list";
	}
	if (message.listResponseMessage) {
		return "list_response";
	}
	if (message.buttonsResponseMessage) {
		return "buttons_response";
	}
	if (message.orderMessage) {
		return "order";
	}
	if (message.productMessage) {
		return "product";
	}
	if (message.interactiveResponseMessage) {
		return "native_flow_response";
	}
	if (message.groupInviteMessage) {
		return "group_invite";
	}
	return "";
};

const summarizeNewsletterMediaMessageForDebug = (message = {}) => {
	const mediaType = getNewsletterMediaTypeFromMessage(message) || "";
	if (!mediaType) {
		return null;
	}
	const mediaMessage =
		message.imageMessage ||
		message.videoMessage ||
		message.audioMessage ||
		message.documentMessage ||
		null;
	if (!mediaMessage || typeof mediaMessage !== "object") {
		return {
			messageType: mediaType,
			hasMediaMessageObject: false,
		};
	}
	const url = typeof mediaMessage.url === "string" ? mediaMessage.url : "";
	const directPath =
		typeof mediaMessage.directPath === "string"
			? mediaMessage.directPath
			: typeof mediaMessage.direct_path === "string"
				? mediaMessage.direct_path
				: "";
	return {
		messageType: mediaType,
		mimetype:
			typeof mediaMessage.mimetype === "string" ? mediaMessage.mimetype : null,
		fileLength: toIntegerOrNull(mediaMessage.fileLength),
		width: toIntegerOrNull(mediaMessage.width),
		height: toIntegerOrNull(mediaMessage.height),
		seconds: toIntegerOrNull(mediaMessage.seconds),
		pageCount: toIntegerOrNull(mediaMessage.pageCount),
		captionLength:
			typeof mediaMessage.caption === "string"
				? mediaMessage.caption.length
				: 0,
		fileName:
			typeof mediaMessage.fileName === "string" ? mediaMessage.fileName : null,
		hasUrl: Boolean(url),
		urlHost: parseUrlHostForDebug(url),
		urlPreview: truncateForDebug(url, 120),
		hasDirectPath: Boolean(directPath),
		directPathPreview: truncateForDebug(directPath, 120),
		fileSha256Bytes: getByteLength(mediaMessage.fileSha256),
		fileEncSha256Bytes: getByteLength(mediaMessage.fileEncSha256),
		mediaKeyBytes: getByteLength(mediaMessage.mediaKey),
		jpegThumbnailBytes: getByteLength(mediaMessage.jpegThumbnail),
		waveformBytes: getByteLength(mediaMessage.waveform),
		ptt: Boolean(mediaMessage.ptt),
		gifPlayback: Boolean(mediaMessage.gifPlayback),
		mediaKeyTimestamp: toIntegerOrNull(mediaMessage.mediaKeyTimestamp),
	};
};

const pruneNewsletterMediaStanzaDebug = () => {
	const cutoff = Date.now() - NEWSLETTER_MEDIA_STANZA_DEBUG_TTL_MS;
	for (const [outboundId, payload] of newsletterMediaStanzaDebug.entries()) {
		if (
			!payload ||
			typeof payload.timestamp !== "number" ||
			payload.timestamp < cutoff
		) {
			newsletterMediaStanzaDebug.delete(outboundId);
		}
	}
	while (newsletterMediaStanzaDebug.size > NEWSLETTER_MEDIA_STANZA_DEBUG_MAX) {
		const oldestKey = newsletterMediaStanzaDebug.keys().next().value;
		if (!oldestKey) break;
		newsletterMediaStanzaDebug.delete(oldestKey);
	}
};

const noteNewsletterMediaStanzaDebug = (outboundId, payload = {}) => {
	const normalizedOutboundId = normalizeBridgeMessageId(outboundId);
	if (!normalizedOutboundId) return;
	pruneNewsletterMediaStanzaDebug();
	newsletterMediaStanzaDebug.delete(normalizedOutboundId);
	newsletterMediaStanzaDebug.set(normalizedOutboundId, {
		...payload,
		timestamp: Date.now(),
	});
};

const getNewsletterMediaStanzaDebug = (outboundId) => {
	const normalizedOutboundId = normalizeBridgeMessageId(outboundId);
	if (!normalizedOutboundId) return null;
	pruneNewsletterMediaStanzaDebug();
	return newsletterMediaStanzaDebug.get(normalizedOutboundId) || null;
};

const patchSendNodeForNewsletterMessages = (client) => {
	if (
		!client ||
		client.__wa2dcNewsletterNodePatched ||
		typeof client.sendNode !== "function"
	) {
		return;
	}

	const baseSendNode = client.sendNode.bind(client);
	client.sendNode = async (frame) => {
		try {
			if (frame?.tag !== "message") {
				return baseSendNode(frame);
			}
			const to =
				typeof frame?.attrs?.to === "string" ? frame.attrs.to.trim() : "";
			if (!isNewsletterJid(to)) {
				return baseSendNode(frame);
			}

			const outboundId = normalizeBridgeMessageId(frame?.attrs?.id);
			const needsMediaType =
				frame?.attrs?.type === "media" && !frame?.attrs?.mediatype;
			const shouldInspectMedia =
				NEWSLETTER_MEDIA_STANZA_DEBUG_ENABLED && frame?.attrs?.type === "media";
			const contentNodes = Array.isArray(frame?.content) ? frame.content : [];
			const hasMeta = (predicate) =>
				contentNodes.some((node) => predicate(node));
			const needsPollMeta =
				frame?.attrs?.type === "poll" &&
				!hasMeta(
					(node) =>
						node?.tag === "meta" &&
						node?.attrs &&
						typeof node.attrs.polltype === "string",
				);
			const needsEventMeta =
				frame?.attrs?.type === "event" &&
				!hasMeta(
					(node) =>
						node?.tag === "meta" &&
						node?.attrs &&
						typeof node.attrs.event_type === "string",
				);
			if (
				!needsMediaType &&
				!needsPollMeta &&
				!needsEventMeta &&
				!shouldInspectMedia
			) {
				return baseSendNode(frame);
			}

			const plaintextNode = contentNodes.find(
				(node) => node?.tag === "plaintext",
			);
			const rawPlaintext = plaintextNode?.content;
			if (!rawPlaintext) {
				if (shouldInspectMedia) {
					state.logger?.warn?.(
						{
							jid: to,
							outboundId,
							frameType: frame?.attrs?.type || null,
							frameMediaType: frame?.attrs?.mediatype || null,
						},
						"Newsletter media stanza is missing plaintext content",
					);
				}
				return baseSendNode(frame);
			}

			const plaintextBytes =
				typeof rawPlaintext === "string"
					? Buffer.from(rawPlaintext, "binary")
					: Buffer.from(rawPlaintext);
			let decoded = null;
			try {
				decoded = proto.Message.decode(plaintextBytes);
			} catch (_err) {
				decoded = null;
			}
			const decodedMessage =
				decoded && typeof decoded.toJSON === "function"
					? decoded.toJSON()
					: decoded;
			if (!decodedMessage) {
				if (shouldInspectMedia) {
					state.logger?.warn?.(
						{
							jid: to,
							outboundId,
							frameType: frame?.attrs?.type || null,
							frameMediaType: frame?.attrs?.mediatype || null,
						},
						"Failed to decode newsletter media plaintext payload",
					);
				}
				return baseSendNode(frame);
			}

			let patchedMediaType = null;
			if (needsMediaType) {
				const mediatype = getNewsletterMediaTypeFromMessage(decodedMessage);
				if (mediatype) {
					frame.attrs.mediatype = mediatype;
					patchedMediaType = mediatype;
					plaintextNode.attrs = {
						...(plaintextNode.attrs || {}),
						mediatype,
					};
				}
			}

			if (shouldInspectMedia) {
				const summary = summarizeNewsletterMediaMessageForDebug(decodedMessage);
				const debugPayload = {
					jid: to,
					outboundId,
					frameType: frame?.attrs?.type || null,
					frameMediaType: frame?.attrs?.mediatype || null,
					patchedMediaType,
					plaintextMediaType: plaintextNode?.attrs?.mediatype || null,
					contentTags: contentNodes.map((node) => node?.tag).filter(Boolean),
					...(summary || {}),
				};
				if (summary) {
					noteNewsletterMediaStanzaDebug(outboundId, debugPayload);
				}
				state.logger?.info?.(
					debugPayload,
					"Prepared newsletter media stanza payload",
				);
			}

			if (needsPollMeta) {
				const hasPollCreation = Boolean(
					decodedMessage.pollCreationMessage ||
						decodedMessage.pollCreationMessageV2 ||
						decodedMessage.pollCreationMessageV3 ||
						decodedMessage.pollCreationMessageV4,
				);
				if (hasPollCreation) {
					contentNodes.push({ tag: "meta", attrs: { polltype: "creation" } });
					frame.content = contentNodes;
				}
			}

			if (needsEventMeta) {
				if (decodedMessage.eventMessage) {
					contentNodes.push({ tag: "meta", attrs: { event_type: "creation" } });
					frame.content = contentNodes;
				}
			}
		} catch (err) {
			state.logger?.debug?.(
				{ err },
				"Failed to patch newsletter message stanza before send",
			);
		}
		return baseSendNode(frame);
	};

	client.__wa2dcNewsletterNodePatched = true;
};

const ensureSignalStoreSupport = async (keyStore) => {
	if (!keyStore?.get || !keyStore?.set) {
		return;
	}

	const requiredKeys = [
		"tctoken",
		"lid-mapping",
		"device-list",
		"device-index",
	];
	for (const key of requiredKeys) {
		try {
			const existing = await keyStore.get(key, []);
			if (existing == null) {
				await keyStore.set({ [key]: {} });
			}
		} catch (err) {
			state.logger?.warn(
				{ err, key },
				"Failed to ensure auth store compatibility",
			);
		}
	}
};

const migrateLegacyChats = async (client) => {
	const store = client.signalRepository?.lidMapping;
	if (!store) return;
	const lidJids = Object.keys(state.chats).filter((jid) =>
		jid.endsWith("@lid"),
	);
	if (!lidJids.length) return;
	try {
		const mappings =
			typeof store.getPNsForLIDs === "function"
				? await store.getPNsForLIDs(lidJids)
				: {};
		for (const lidJid of lidJids) {
			let pnJid = mappings?.[lidJid];
			if (!pnJid && typeof store.getPNForLID === "function") {
				pnJid = await store.getPNForLID(lidJid);
			}
			const formattedPn = utils.whatsapp.formatJid(pnJid);
			if (formattedPn && utils.whatsapp.isPhoneJid(formattedPn)) {
				utils.whatsapp.migrateLegacyJid(lidJid, formattedPn);
			}
		}
	} catch (err) {
		state.logger?.warn({ err }, "Failed to migrate LID chats to PNs");
	}
};

const connectToWhatsApp = async (retry = 1) => {
	const controlChannel = await utils.discord
		.getControlChannel()
		.catch(() => null);
	const { version } = await getBaileysVersion();
	const sendControlMessage = async (message) => {
		if (!controlChannel || state.shutdownRequested) {
			return;
		}
		try {
			await controlChannel.send(message);
		} catch (err) {
			state.logger?.debug?.(
				{ err },
				"Failed to send WhatsApp status to control channel",
			);
		}
	};

	if (!groupCachePruneInterval) {
		groupCachePruneInterval = setInterval(
			() => groupMetadataCache.prune(),
			60 * 60 * 1000,
		);
		if (typeof groupCachePruneInterval?.unref === "function") {
			groupCachePruneInterval.unref();
		}
	}

	const client = createWhatsAppClient({
		version,
		printQRInTerminal: false,
		auth: authState,
		logger: state.logger,
		markOnlineOnConnect: false,
		syncFullHistory: true,
		shouldSyncHistoryMessage: () => true,
		generateHighQualityLinkPreview: true,
		cachedGroupMetadata: async (jid) =>
			groupMetadataCache.get(utils.whatsapp.formatJid(jid)),
		getMessage: async (key) => {
			const stored = await getStoredMessageWithJidFallback({
				...key,
				remoteJid: utils.whatsapp.formatJid(key?.remoteJid),
			});
			if (!stored) return null;

			return stored.message || stored;
		},
		browser: Browsers.android("13"),
	});
	client.contacts = state.contacts;
	patchSendMessageForLinkPreviews(client);
	patchSendNodeForNewsletterMessages(client);
	patchGroupMetadataForCache(client);
	const groupRefreshScheduler = createGroupRefreshScheduler({
		refreshFn: (jid) => refreshGroupMetadata(client, jid),
	});

	client.ev.on("connection.update", async (update) => {
		try {
			if (state.shutdownRequested) {
				return;
			}

			const { connection, lastDisconnect, qr } = update;
			if (qr) {
				utils.whatsapp.sendQR(qr);
			}
			if (connection === "close") {
				state.logger.error(lastDisconnect?.error);
				groupRefreshScheduler.clearAll();
				groupMetadataCache.clear();
				const statusCode = lastDisconnect?.error?.output?.statusCode;
				if (
					statusCode === DisconnectReason.loggedOut ||
					statusCode === DisconnectReason.badSession
				) {
					await sendControlMessage(
						"WhatsApp session invalid. Please rescan the QR code.",
					);
					await utils.whatsapp.deleteSession();
					await actions.start(true);
					return;
				}
				const delayMs = getReconnectDelayMs(retry);
				const humanReason = formatDisconnectReason(statusCode);
				if (delayMs === 0) {
					await sendControlMessage(
						`WhatsApp connection failed (${humanReason}). Trying to reconnect! Retry #${retry}`,
					);
				} else {
					const delaySeconds = Math.round(delayMs / 1000);
					await sendControlMessage(
						`WhatsApp connection failed (${humanReason}). Waiting ${delaySeconds} seconds before trying to reconnect! Retry #${retry}.`,
					);
					await sleep(delayMs);
				}
				if (!state.shutdownRequested) {
					await connectToWhatsApp(retry + 1);
				}
				return;
			} else if (connection === "open") {
				state.waClient = client;

				retry = 1;
				await sendControlMessage("WhatsApp connection successfully opened!");

				try {
					const groups = await client.groupFetchAllParticipating();
					groupMetadataCache.prime(groups);
					for (const [jid, data] of Object.entries(groups)) {
						state.contacts[jid] = data.subject;
						client.contacts[jid] = data.subject;
					}
					await migrateLegacyChats(client);
				} catch (err) {
					state.logger?.error(err);
				}
			}
		} catch (err) {
			state.logger?.warn(
				{ err },
				"Failed to handle WhatsApp connection.update",
			);
		}
	});
	const credsListener = typeof saveState === "function" ? saveState : () => {};
	client.ev.on("creds.update", credsListener);
	const contactUpdater = utils.whatsapp.updateContacts.bind(utils.whatsapp);
	[
		"chats.set",
		"contacts.set",
		"chats.upsert",
		"chats.update",
		"contacts.upsert",
		"contacts.update",
		"groups.upsert",
		"groups.update",
	].forEach((eventName) => {
		client.ev.on(eventName, contactUpdater);
	});

	client.ev.on("groups.upsert", async (groups) => {
		const list = Array.isArray(groups) ? groups : [groups];
		for (const group of list) {
			cacheGroupMetadata(group, client);
			groupRefreshScheduler.schedule(group.id);
		}
	});

	client.ev.on("groups.update", async (updates = []) => {
		const list = Array.isArray(updates) ? updates : [updates];
		for (const update of list) {
			if (!update?.id) continue;
			if (update.subject) {
				cacheGroupMetadata({ id: update.id, subject: update.subject }, client);
			}
			groupRefreshScheduler.schedule(update.id);
		}
	});

	client.ev.on("group-participants.update", async (event) => {
		if (!event?.id) return;
		groupRefreshScheduler.schedule(event.id);
	});

	client.ev.on("lid-mapping.update", ({ lid, pn }) => {
		const normalizedLid = utils.whatsapp.formatJid(lid);
		const normalizedPn = utils.whatsapp.formatJid(pn);
		if (!normalizedLid || !normalizedPn) return;
		const lidJid = utils.whatsapp.isLidJid(normalizedLid)
			? normalizedLid
			: utils.whatsapp.isLidJid(normalizedPn)
				? normalizedPn
				: null;
		const pnJid = utils.whatsapp.isPhoneJid(normalizedLid)
			? normalizedLid
			: utils.whatsapp.isPhoneJid(normalizedPn)
				? normalizedPn
				: null;
		if (lidJid && pnJid) {
			utils.whatsapp.migrateLegacyJid(lidJid, pnJid);
		}
	});

	client.ev.on("messages.upsert", async (update) => {
		if (["notify", "append"].includes(update.type)) {
			for await (const rawMessage of update.messages) {
				const messageId = normalizeBridgeMessageId(
					utils.whatsapp.getId(rawMessage),
				);
				const outboundId = normalizeBridgeMessageId(rawMessage?.key?.id);
				const serverId = normalizeBridgeMessageId(
					getNewsletterServerIdFromMessage(rawMessage),
				);
				const remoteJid = normalizeSendJid(
					rawMessage?.key?.remoteJid ||
						rawMessage?.chatId ||
						rawMessage?.attrs?.from,
				);
				const newsletterChat = isNewsletterJid(remoteJid);
				if (newsletterChat) {
					const resolvedServerId = normalizeBridgeMessageId(
						serverId || messageId || outboundId,
					);
					if (resolvedServerId) {
						const pending = resolvePendingNewsletterSend({
							jid: remoteJid,
							serverId: resolvedServerId,
							message: rawMessage,
						});
						mapPendingNewsletterServerId({
							jid: remoteJid,
							serverId: resolvedServerId,
							pending,
							source: "messages.upsert",
						});
					}
				}
				const sentCandidates = [
					...new Set([messageId, outboundId, serverId].filter(Boolean)),
				];
				if (sentCandidates.some((id) => state.sentMessages.has(id))) {
					if (newsletterChat) {
						mapNewsletterServerIdFromOutbound({ outboundId, serverId });
					}
					sentCandidates.forEach((id) => {
						state.sentMessages.delete(id);
					});
					continue;
				}
				if (newsletterChat && rawMessage?.key?.fromMe) {
					const rejectedId = sentCandidates.find((id) =>
						getNewsletterAckError(id),
					);
					if (rejectedId) {
						const ackError = getNewsletterAckError(rejectedId);
						state.logger?.debug?.(
							{
								jid: remoteJid,
								outboundId,
								messageId,
								serverId,
								rejectedId,
								error: ackError,
							},
							"Skipping newsletter fromMe upsert for ack-rejected send",
						);
						continue;
					}
				}
				if (
					newsletterChat &&
					rawMessage?.key?.fromMe &&
					outboundId &&
					state.lastMessages[outboundId]
				) {
					mapNewsletterServerIdFromOutbound({ outboundId, serverId });
					continue;
				}
				const messageType = utils.whatsapp.getMessageType(rawMessage);
				storeMessage(rawMessage);
				if (
					!utils.whatsapp.inWhitelist(rawMessage) ||
					!utils.whatsapp.sentAfterStart(rawMessage) ||
					!messageType
				)
					continue;

				if (
					utils.whatsapp.isStatusBroadcast(rawMessage) &&
					!state.settings.MirrorWAStatuses
				) {
					continue;
				}

				if (messageType === "pollUpdateMessage") {
					const handled = await handlePollUpdateMessage(client, rawMessage);
					if (handled) continue;
				}

				const channelJid = await utils.whatsapp.getChannelJid(rawMessage);
				if (!channelJid) {
					continue;
				}

				if (isPinInChatMessage(rawMessage.message)) {
					const { pinInChatMessage } = rawMessage.message;
					const targetKey = {
						...pinInChatMessage.key,
						remoteJid: utils.whatsapp.formatJid(
							pinInChatMessage.key?.remoteJid || channelJid,
						),
					};
					const isPin =
						pinInChatMessage.type ===
							proto.Message.PinInChatMessage.Type.PIN_FOR_ALL ||
						pinInChatMessage.type === 1;
					const pinNoticeKey = rawMessage?.key?.id
						? {
								...rawMessage.key,
								remoteJid: utils.whatsapp.formatJid(
									rawMessage.key.remoteJid || channelJid,
								),
								participant: utils.whatsapp.formatJid(
									rawMessage.key.participant || rawMessage.key.participantAlt,
								),
							}
						: null;
					const isSelfPin =
						state.sentPins.has(targetKey.id) ||
						(pinNoticeKey?.id && state.sentPins.has(pinNoticeKey.id));
					if (isSelfPin) {
						state.sentPins.delete(targetKey.id);
						if (pinNoticeKey?.id) state.sentPins.delete(pinNoticeKey.id);
						if (pinNoticeKey?.id) {
							try {
								await client.sendMessage(pinNoticeKey.remoteJid, {
									delete: pinNoticeKey,
								});
							} catch (err) {
								state.logger?.debug?.(
									{ err },
									"Failed to delete local pin notice",
								);
							}
						}
					} else {
						state.dcClient.emit("whatsappPin", {
							jid: channelJid,
							key: targetKey,
							pinned: isPin,
							actor: await utils.whatsapp.getSenderName(rawMessage),
						});
					}
					continue;
				}

				const pollCreation = getPollCreation(rawMessage.message);
				if (pollCreation) {
					const pollText = formatPollForDiscord(rawMessage);
					const name = await utils.whatsapp.getSenderName(rawMessage);
					const pollOptions = getPollOptions(pollCreation);
					state.dcClient.emit("whatsappMessage", {
						id: utils.whatsapp.getId(rawMessage),
						name,
						content: pollText || pollCreation.name || "Poll",
						quote: await utils.whatsapp.getQuote(rawMessage),
						file: null,
						profilePic: await utils.whatsapp.getProfilePic(rawMessage),
						channelJid,
						isGroup: utils.whatsapp.isGroup(rawMessage),
						isForwarded: utils.whatsapp.isForwarded(
							rawMessage.message,
							rawMessage?.message?.messageContextInfo,
						),
						isEdit: false,
						isPoll: true,
						pollOptions,
						pollSelectableCount:
							pollCreation.selectableOptionsCount ||
							pollCreation.selectableCount ||
							1,
					});
					const ts = utils.whatsapp.getTimestamp(rawMessage);
					if (ts > state.startTime) state.startTime = ts;
					continue;
				}

				const [nMsgType, message] = utils.whatsapp.getMessage(
					rawMessage,
					messageType,
				);
				const { content, discordMentions, discordMentionEveryone } =
					await utils.whatsapp.getContent(message, nMsgType, messageType, {
						mentionTarget: "discord",
					});
				state.dcClient.emit("whatsappMessage", {
					id: utils.whatsapp.getId(rawMessage),
					name: await utils.whatsapp.getSenderName(rawMessage),
					content,
					quote: await utils.whatsapp.getQuote(rawMessage),
					file: await utils.whatsapp.getFile(rawMessage, messageType),
					profilePic: await utils.whatsapp.getProfilePic(rawMessage),
					channelJid: await utils.whatsapp.getChannelJid(rawMessage),
					isGroup: utils.whatsapp.isGroup(rawMessage),
					isForwarded: utils.whatsapp.isForwarded(
						message,
						rawMessage?.message?.messageContextInfo,
					),
					isEdit: messageType === "editedMessage",
					discordMentions,
					discordMentionEveryone,
				});
				const ts = utils.whatsapp.getTimestamp(rawMessage);
				if (ts > state.startTime) state.startTime = ts;
			}
		}
	});

	client.ev.on("messages.reaction", async (reactions) => {
		for await (const rawReaction of reactions) {
			if (
				!utils.whatsapp.inWhitelist(rawReaction) ||
				!utils.whatsapp.sentAfterStart(rawReaction)
			)
				continue;

			const msgId = utils.whatsapp.getId(rawReaction);
			if (state.sentReactions.has(msgId)) {
				state.sentReactions.delete(msgId);
				continue;
			}

			state.dcClient.emit("whatsappReaction", {
				id: msgId,
				jid: await utils.whatsapp.getChannelJid(rawReaction),
				text: rawReaction.reaction.text,
				author: await utils.whatsapp.getSenderJid(
					rawReaction,
					rawReaction.key.fromMe,
				),
			});
			const ts = utils.whatsapp.getTimestamp(rawReaction);
			if (ts > state.startTime) state.startTime = ts;
		}
	});

	client.ev.on("newsletter.reaction", async (update = {}) => {
		const jid = utils.whatsapp.formatJid(update?.id);
		if (!jid) {
			return;
		}
		if (!utils.whatsapp.inWhitelist({ key: { remoteJid: jid } })) {
			return;
		}

		const serverId =
			typeof update?.server_id === "string"
				? update.server_id.trim()
				: String(update?.server_id || "").trim();
		if (!serverId) {
			return;
		}
		if (state.sentReactions.has(serverId)) {
			state.sentReactions.delete(serverId);
			return;
		}

		const reactionCode =
			typeof update?.reaction?.code === "string"
				? update.reaction.code.trim()
				: "";
		const removed = Boolean(update?.reaction?.removed) || !reactionCode;
		const syntheticAuthor = reactionCode
			? `newsletter:${serverId}:${reactionCode}`
			: `newsletter:${serverId}`;

		state.dcClient.emit("whatsappReaction", {
			id: serverId,
			jid,
			text: removed ? "" : reactionCode,
			author: syntheticAuthor,
		});
	});

	client.ev.on("messages.delete", async (updates) => {
		const keys = "keys" in updates ? updates.keys : updates;
		for (const key of keys) {
			if (!utils.whatsapp.inWhitelist({ key })) continue;
			const jid = await utils.whatsapp.getChannelJid({ key });
			if (!jid) continue;
			const id = getNewsletterServerIdFromMessage({ key }) || key?.id;
			if (!id) continue;
			state.dcClient.emit("whatsappDelete", {
				id,
				jid,
			});
		}
	});

	client.ev.on("messages.update", async (updates) => {
		for (const { update, key } of updates) {
			const normalizedRemoteJid = normalizeSendJid(key?.remoteJid);
			if (
				key?.fromMe &&
				update?.status === WAMessageStatus.ERROR &&
				isNewsletterJid(normalizedRemoteJid)
			) {
				const [errorCodeRaw] = Array.isArray(update?.messageStubParameters)
					? update.messageStubParameters
					: [];
				const errorCode = normalizeBridgeMessageId(errorCodeRaw) || "unknown";
				const mediaStanzaDebug = getNewsletterMediaStanzaDebug(key?.id);
				noteNewsletterAckError({
					messageId: key?.id,
					jid: normalizedRemoteJid,
					errorCode,
				});
				state.logger?.warn?.(
					{
						jid: normalizedRemoteJid,
						id: key?.id,
						error: errorCode,
						stanza: mediaStanzaDebug || undefined,
					},
					"Newsletter send failed with ack error",
				);
			}
			if (Array.isArray(update.pollUpdates) && update.pollUpdates.length) {
				const pollMessage = messageStore.get({
					...key,
					remoteJid: utils.whatsapp.formatJid(key?.remoteJid),
				});
				if (!pollMessage) {
					state.logger?.warn(
						{ key },
						"Received poll update without stored poll creation message",
					);
					continue;
				}
				for (const pollUpdate of update.pollUpdates) {
					updateMessageWithPollUpdate(pollMessage, pollUpdate);
				}
				storeMessage(pollMessage);
				const pollText = formatPollForDiscord(pollMessage);
				const channelJid = await utils.whatsapp.getChannelJid({ key });
				if (pollText && channelJid) {
					state.dcClient.emit("whatsappMessage", {
						id: key.id,
						name: await utils.whatsapp.getSenderName(pollMessage),
						content: pollText,
						channelJid,
						profilePic: await utils.whatsapp.getProfilePic(pollMessage),
						isGroup: utils.whatsapp.isGroup({ key }),
						isForwarded: false,
						isEdit: true,
						isPoll: true,
						pollOptions: getPollOptions(getPollCreation(pollMessage.message)),
						pollSelectableCount:
							pollMessage?.message?.pollCreationMessage
								?.selectableOptionsCount ||
							pollMessage?.message?.pollCreationMessage?.selectableCount ||
							pollMessage?.message?.pollCreationMessageV2
								?.selectableOptionsCount ||
							pollMessage?.message?.pollCreationMessageV2?.selectableCount ||
							pollMessage?.message?.pollCreationMessageV3
								?.selectableOptionsCount ||
							pollMessage?.message?.pollCreationMessageV3?.selectableCount ||
							pollMessage?.message?.pollCreationMessageV4
								?.selectableOptionsCount ||
							pollMessage?.message?.pollCreationMessageV4?.selectableCount ||
							1,
					});
				}
				continue;
			}
			if (isPinInChatMessage(update.message)) {
				const { pinInChatMessage } = update.message;
				const targetKey = {
					...pinInChatMessage.key,
					remoteJid: utils.whatsapp.formatJid(
						pinInChatMessage.key?.remoteJid || key?.remoteJid,
					),
				};
				const isPin =
					pinInChatMessage.type ===
						proto.Message.PinInChatMessage.Type.PIN_FOR_ALL ||
					pinInChatMessage.type === 1;
				const pinNoticeKey = key?.id
					? {
							...key,
							remoteJid: utils.whatsapp.formatJid(
								key.remoteJid || targetKey.remoteJid,
							),
							participant: utils.whatsapp.formatJid(
								key.participant || key.participantAlt,
							),
						}
					: null;
				const isSelfPin =
					state.sentPins.has(targetKey.id) ||
					(pinNoticeKey?.id && state.sentPins.has(pinNoticeKey.id));
				if (isSelfPin) {
					state.sentPins.delete(targetKey.id);
					if (pinNoticeKey?.id) state.sentPins.delete(pinNoticeKey.id);
					if (pinNoticeKey?.id) {
						try {
							await client.sendMessage(pinNoticeKey.remoteJid, {
								delete: pinNoticeKey,
							});
						} catch (err) {
							state.logger?.debug?.(
								{ err },
								"Failed to delete local pin notice",
							);
						}
					}
				} else {
					state.dcClient.emit("whatsappPin", {
						jid: await utils.whatsapp.getChannelJid({ key }),
						key: targetKey,
						pinned: isPin,
						actor: await utils.whatsapp.getSenderName({ ...update, key }),
					});
				}
				continue;
			}
			if (
				typeof update.status !== "undefined" &&
				key.fromMe &&
				[WAMessageStatus.READ, WAMessageStatus.PLAYED].includes(update.status)
			) {
				state.dcClient.emit("whatsappRead", {
					id: key.id,
					jid: await utils.whatsapp.getChannelJid({ key }),
				});
			}

			const protocol = update.message?.protocolMessage;
			const isDelete =
				protocol?.type === proto.Message.ProtocolMessage.Type.REVOKE ||
				update.messageStubType === WAMessageStubType.REVOKE;
			if (!isDelete) continue;
			const msgKey = protocol?.key || key;
			if (!utils.whatsapp.inWhitelist({ key: msgKey })) continue;
			state.dcClient.emit("whatsappDelete", {
				id: msgKey.id,
				jid: await utils.whatsapp.getChannelJid({ key: msgKey }),
			});
		}
	});

	client.ev.on("call", async (calls) => {
		for await (const call of calls) {
			if (
				!utils.whatsapp.inWhitelist(call) ||
				!utils.whatsapp.sentAfterStart(call)
			)
				return;

			state.dcClient.emit("whatsappCall", {
				jid: await utils.whatsapp.getChannelJid(call),
				call,
			});
			const ts = utils.whatsapp.getTimestamp(call);
			if (ts > state.startTime) state.startTime = ts;
		}
	});

	client.ev.on("contacts.update", async (contacts) => {
		for await (const contact of contacts) {
			if (typeof contact.imgUrl === "undefined") continue;
			if (!utils.whatsapp.inWhitelist({ chatId: contact.id })) continue;

			utils.whatsapp._profilePicsCache[contact.id] = await client
				.profilePictureUrl(contact.id, "preview")
				.catch(() => null);

			if (!state.settings.ChangeNotifications) continue;
			const removed = utils.whatsapp._profilePicsCache[contact.id] === null;
			state.dcClient.emit("whatsappMessage", {
				id: null,
				name: "WA2DC",
				content:
					"[BOT] " +
					(removed
						? "User removed their profile picture!"
						: "User changed their profile picture!"),
				profilePic: utils.whatsapp._profilePicsCache[contact.id],
				channelJid: await utils.whatsapp.getChannelJid({ chatId: contact.id }),
				isGroup: contact.id.endsWith("@g.us"),
				isForwarded: false,
				file: removed
					? null
					: await client
							.profilePictureUrl(contact.id, "image")
							.catch(() => null),
			});
		}
	});

	client.ws.on(`CB:notification,type:status,set`, async (update) => {
		if (!utils.whatsapp.inWhitelist({ chatId: update.attrs.from })) return;

		if (!state.settings.ChangeNotifications) return;
		const status = update.content[0]?.content?.toString();
		if (!status) return;
		state.dcClient.emit("whatsappMessage", {
			id: null,
			name: "WA2DC",
			content: `[BOT] User changed their status to: ${status}`,
			profilePic: utils.whatsapp._profilePicsCache[update.attrs.from],
			channelJid: await utils.whatsapp.getChannelJid({
				chatId: update.attrs.from,
			}),
			isGroup: update.attrs.from.endsWith("@g.us"),
			isForwarded: false,
		});
	});

	client.ws.on("CB:notification,type:newsletter", (node = {}) => {
		const jid = normalizeSendJid(node?.attrs?.from || "");
		if (!isNewsletterJid(jid)) {
			return;
		}
		const liveUpdates = parseNewsletterLiveUpdateEntries(node);
		if (!liveUpdates.length) {
			return;
		}
		let mappedCount = 0;
		let mirroredReactionEvents = 0;
		for (const update of liveUpdates) {
			const mapped = mapPendingNewsletterServerId({
				jid,
				serverId: update.serverId,
				source: "ws.newsletter.live_updates",
				updateTimestamp: update.timestamp,
			});
			if (mapped) {
				mappedCount += 1;
			}
			mirroredReactionEvents += emitNewsletterReactionsFromLiveUpdate({
				jid,
				update,
			});
		}
		state.logger?.debug?.(
			{
				jid,
				updates: liveUpdates.length,
				mappedCount,
				mirroredReactionEvents,
			},
			"Processed newsletter live_updates notification",
		);
	});

	client.ws.on("CB:notification,type:mex", (node = {}) => {
		const candidates = parseMexNewsletterServerIdCandidates(node);
		if (!candidates.length) {
			return;
		}
		let mappedCount = 0;
		for (const candidate of candidates) {
			const mapped = mapPendingNewsletterServerId({
				jid: candidate.jid,
				serverId: candidate.serverId,
				source: "ws.newsletter.mex",
			});
			if (mapped) {
				mappedCount += 1;
			}
		}
		state.logger?.debug?.(
			{
				from: normalizeSendJid(node?.attrs?.from || ""),
				candidates: candidates.length,
				mappedCount,
			},
			"Processed newsletter mex notification",
		);
	});

	client.ws.on("CB:ack,class:message", (node = {}) => {
		const attrs = node?.attrs || {};
		const errorCode = normalizeBridgeMessageId(attrs?.error);
		if (!errorCode) {
			return;
		}
		const messageId = normalizeBridgeMessageId(attrs?.id);
		if (!messageId) {
			return;
		}
		const fromJid = normalizeSendJid(attrs?.from || attrs?.to || "");
		if (!isNewsletterJid(fromJid)) {
			return;
		}
		if (getNewsletterAckError(messageId) === errorCode) {
			return;
		}
		noteNewsletterAckError({
			messageId,
			jid: fromJid,
			errorCode,
		});
		const mediaStanzaDebug = getNewsletterMediaStanzaDebug(messageId);
		state.logger?.warn?.(
			{
				jid: fromJid,
				id: messageId,
				error: errorCode,
				stanza: mediaStanzaDebug || undefined,
			},
			"Newsletter send failed with ack error",
		);
	});

	client.ev.on("discordMessage", async ({ jid, message, forwardContext }) => {
		if (!allowsDiscordToWhatsApp()) {
			return;
		}

		const targetJid = normalizeSendJid(jid);
		const newsletterChat = isNewsletterJid(targetJid);
		const useNewsletterSpecialFlow = useNewsletterSpecialFlowForJid(targetJid);
		const isForwardedFromDiscord = Boolean(forwardContext?.isForwarded);
		const hasReplyReference =
			!isForwardedFromDiscord && isDiscordReplyReference(message);
		const options = buildSendOptionsForJid(targetJid);
		const forwardSnapshot =
			isForwardedFromDiscord && message?.wa2dcForwardSnapshot
				? message.wa2dcForwardSnapshot
				: null;
		const snapshotEmbeds = Array.isArray(forwardSnapshot?.embeds)
			? forwardSnapshot.embeds
			: [];
		let newsletterReplyFallbackContext = "";

		if (hasReplyReference) {
			options.quoted = await utils.whatsapp.createQuoteMessage(
				message,
				targetJid,
			);
			if (options.quoted == null) {
				if (useNewsletterSpecialFlow) {
					newsletterReplyFallbackContext =
						(await buildNewsletterReplyFallbackContext(message)) || "";
				} else {
					message.channel.send(
						`Couldn't find the message quoted. You can only reply to last ${state.settings.lastMessageStorage} messages. Sending the message without the quoted message.`,
					);
				}
			}
		}

		const emojiData = utils.discord.extractCustomEmojiData(message);
		const hasOnlyCustomEmoji =
			emojiData.matches.length > 0 && emojiData.rawWithoutEmoji.trim() === "";
		const emojiFallbackText = emojiData.matches
			.map((entry) => `:${entry.name}:`)
			.join(" ");
		const embedMirroringEnabled = Boolean(
			state.settings.DiscordEmbedsToWhatsApp,
		);

		const baseText = message.content ?? message.cleanContent ?? "";
		let text = utils.whatsapp.convertDiscordFormatting(baseText);
		if (
			isForwardedFromDiscord &&
			!text &&
			typeof forwardSnapshot?.content === "string"
		) {
			text = utils.whatsapp.convertDiscordFormatting(forwardSnapshot.content);
		}
		const embedTextSegments = [];
		if (
			embedMirroringEnabled &&
			typeof utils.discord.extractEmbedText === "function"
		) {
			const messageEmbedTextRaw = utils.discord.extractEmbedText(message, {
				includeUrls: true,
			});
			if (messageEmbedTextRaw) {
				embedTextSegments.push(messageEmbedTextRaw);
			}
			if (snapshotEmbeds.length) {
				const snapshotEmbedTextRaw = utils.discord.extractEmbedText(
					snapshotEmbeds,
					{ includeUrls: true },
				);
				if (
					snapshotEmbedTextRaw &&
					!embedTextSegments.includes(snapshotEmbedTextRaw)
				) {
					embedTextSegments.push(snapshotEmbedTextRaw);
				}
			}
		}
		const embedTextRaw = embedTextSegments.join("\n\n");
		const embedText = embedTextRaw
			? utils.whatsapp.convertDiscordFormatting(embedTextRaw)
			: "";
		if (embedText) {
			text = text ? `${text}\n${embedText}` : embedText;
		}
		if (hasReplyReference) {
			text = text.replace(DISCORD_REPLY_PREFIX_REGEX, "");
		}
		if (text && typeof text.normalize === "function") {
			text = text.normalize("NFKC");
		}

		const stripped = utils.discord.stripCustomEmojiCodes(text).trim();
		let composedText = stripped;

		if (state.settings.DiscordPrefix) {
			const prefix =
				state.settings.DiscordPrefixText ||
				message.member?.displayName ||
				message.author.username;
			composedText = stripped ? `*${prefix}*\n${stripped}` : `*${prefix}*`;
		}

		const urlEnforcement = utils.discord.ensureExplicitUrlScheme(composedText);
		text = urlEnforcement.text;

		const media = utils.discord.collectMessageMedia(message, {
			includeEmojiAttachments: emojiData.matches.length > 0,
			emojiMatches: emojiData.matches,
			includeEmbedAttachments: embedMirroringEnabled,
		});
		const snapshotEmbedMedia =
			embedMirroringEnabled && snapshotEmbeds.length
				? utils.discord.collectMessageMedia(
						{ embeds: snapshotEmbeds },
						{ includeEmbedAttachments: true },
					)
				: { attachments: [], consumedUrls: [] };
		const snapshotAttachments = Array.isArray(forwardSnapshot?.attachments)
			? forwardSnapshot.attachments
			: [];
		const normalizedSnapshotAttachments = snapshotAttachments
			.map((snapshotAttachment) => {
				const url =
					typeof snapshotAttachment?.url === "string"
						? snapshotAttachment.url
						: "";
				if (!url) return null;
				return {
					url,
					name:
						typeof snapshotAttachment?.name === "string" &&
						snapshotAttachment.name.trim()
							? snapshotAttachment.name.trim()
							: "forwarded-attachment",
					contentType:
						typeof snapshotAttachment?.contentType === "string" &&
						snapshotAttachment.contentType
							? snapshotAttachment.contentType
							: "application/octet-stream",
				};
			})
			.filter(Boolean);
		const mergeCollectedAttachments =
			typeof utils.discord.mergeCollectedAttachments === "function"
				? utils.discord.mergeCollectedAttachments.bind(utils.discord)
				: (...attachmentLists) =>
						utils.discord.dedupeCollectedAttachments(attachmentLists.flat());
		const attachments = mergeCollectedAttachments(
			media.attachments || [],
			snapshotEmbedMedia.attachments || [],
			normalizedSnapshotAttachments,
		);
		const consumedUrls = [
			...(media.consumedUrls || []),
			...(snapshotEmbedMedia.consumedUrls || []),
		];
		const hasAttachments = attachments.length > 0;
		const shouldSendAttachments =
			state.settings.UploadAttachments && hasAttachments;
		const newsletterMediaUrlFallbackEnabled =
			newsletterChat && Boolean(state.settings.NewsletterMediaUrlFallback);
		let attachmentsToSend = attachments;
		let attachmentLinksForFallback = attachments
			.map((file) => file.url)
			.filter(Boolean);
		if (newsletterChat && hasAttachments) {
			const newsletterMediaAttachments = attachments.filter((file) =>
				isNewsletterSupportedMediaAttachment(file),
			);
			const newsletterUnsupportedAttachments = attachments.filter(
				(file) => !isNewsletterSupportedMediaAttachment(file),
			);
			if (newsletterUnsupportedAttachments.length) {
				await message.channel
					?.send(
						`WhatsApp newsletters currently allow only image/video posts. ` +
							`Skipping ${newsletterUnsupportedAttachments.length} unsupported attachment(s). ` +
							"See: https://faq.whatsapp.com/549900560675125",
					)
					.catch(() => {});
			}
			if (newsletterMediaAttachments.length) {
				if (newsletterMediaUrlFallbackEnabled) {
					await message.channel
						?.send(
							"Newsletter media URL fallback is enabled as a temporary workaround until upstream Baileys newsletter media posting is fixed. " +
								"Image/video attachments will be sent as plain URL links (no thumbnail or attachment payload).",
						)
						.catch(() => {});
					attachmentLinksForFallback = newsletterMediaAttachments
						.map((file) => file.url)
						.filter(Boolean);
				} else {
					await message.channel
						?.send(
							"Newsletter media URL fallback is disabled. " +
								"Until upstream Baileys newsletter media posting is fixed, image/video attachments won't be sent as WhatsApp media. " +
								"Use `/newsletterurlfallback enabled:true` to send them as plain links for now.",
						)
						.catch(() => {});
					attachmentLinksForFallback = [];
				}
			} else {
				attachmentLinksForFallback = [];
			}
			attachmentsToSend = [];
		}

		if (shouldSendAttachments && consumedUrls.length && text) {
			for (const consumed of consumedUrls) {
				if (!consumed) continue;
				const variants = [consumed, `<${consumed}>`];
				for (const variant of variants) {
					text = text.split(variant).join(" ");
				}
			}
			text = text.replace(/\s{2,}/g, " ").trim();
		}

		const replyMentionId = hasReplyReference
			? message.mentions?.repliedUser?.id
			: null;
		const mentionTextCandidates = [
			message.content,
			message.cleanContent,
			forwardSnapshot?.content,
			embedTextRaw,
			embedText,
			text,
		];
		const mentionResolution = await resolveDiscordTextMentionsForWhatsApp({
			message,
			text,
			jid: targetJid,
			textCandidates: mentionTextCandidates,
			replyMentionId,
		});
		text = mentionResolution.text;
		const mentionJids = mentionResolution.mentionJids;
		const mentionAll = mentionResolution.mentionAll;
		const ensureNewsletterReplyFallbackContext = async () => {
			if (!useNewsletterSpecialFlow || !hasReplyReference) return "";
			if (newsletterReplyFallbackContext) return newsletterReplyFallbackContext;
			newsletterReplyFallbackContext =
				(await buildNewsletterReplyFallbackContext(message)) || "";
			return newsletterReplyFallbackContext;
		};
		const sendWithNewsletterQuoteFallback = async (content, sendOptions) => {
			try {
				return await client.sendMessage(targetJid, content, sendOptions);
			} catch (err) {
				if (!useNewsletterSpecialFlow || !sendOptions?.quoted) {
					throw err;
				}
				const replyContext = await ensureNewsletterReplyFallbackContext();
				const retryContent = cloneNewsletterSendContentWithReplyFallback(
					content,
					replyContext,
				);
				const retryOptions = { ...sendOptions };
				delete retryOptions.quoted;
				state.logger?.warn?.(
					{
						err,
						jid: targetJid,
						discordMessageId: message?.id,
					},
					"Retrying newsletter send without quoted context",
				);
				return await client.sendMessage(
					targetJid,
					retryContent,
					Object.keys(retryOptions).length ? retryOptions : undefined,
				);
			}
		};
		const sendTrackedMessage = async (
			content,
			sendOptions,
			{
				ackContext = "Newsletter send",
				notifyAckFailure = false,
				retryWithoutQuotedOnAck = true,
				forceNewsletterAck = false,
				watchNewsletterAck = false,
			} = {},
		) => {
			if (newsletterChat) {
				noteNewsletterMessageDebug({
					discordMessageId: message.id,
					jid: targetJid,
					operation: ackContext,
					phase: "attempt",
					details: {
						...summarizeNewsletterContentForDebug(content),
						hasQuoted: Boolean(sendOptions?.quoted),
					},
				});
				await ensureNewsletterLiveUpdatesSubscription(client, targetJid);
			}
			const sentMessage = await sendWithNewsletterQuoteFallback(
				content,
				sendOptions,
			);
			const outboundId = normalizeBridgeMessageId(sentMessage?.key?.id);
			const mediaStanzaDebug = newsletterChat
				? getNewsletterMediaStanzaDebug(outboundId)
				: null;
			mapDiscordMessageToWhatsAppMessage({
				discordMessageId: message.id,
				sentMessage,
				isNewsletter: newsletterChat,
			});
			if (newsletterChat) {
				notePendingNewsletterSend({
					jid: targetJid,
					discordMessageId: message.id,
					outboundId: sentMessage?.key?.id,
					content,
				});
			}
			if (newsletterChat) {
				if (mediaStanzaDebug) {
					noteNewsletterMessageDebug({
						discordMessageId: message.id,
						jid: targetJid,
						operation: ackContext,
						phase: "stanza_prepared",
						details: {
							...mediaStanzaDebug,
						},
					});
				}
				noteNewsletterMessageDebug({
					discordMessageId: message.id,
					jid: targetJid,
					operation: ackContext,
					phase: "sent",
					details: {
						outboundId,
						serverId: normalizeBridgeMessageId(
							getNewsletterServerIdFromMessage(sentMessage),
						),
					},
				});
			}
			storeMessage(sentMessage);
			const shouldTrackNewsletterAck =
				newsletterChat && (useNewsletterSpecialFlow || forceNewsletterAck);
			const notifyNewsletterAckFailure = async (ackErrorCode) => {
				const ackStanzaDebug = getNewsletterMediaStanzaDebug(
					sentMessage?.key?.id,
				);
				clearFailedNewsletterMapping({
					discordMessageId: message.id,
					sentMessage,
				});
				state.logger?.warn?.(
					{
						jid: targetJid,
						discordMessageId: message.id,
						outboundId: sentMessage?.key?.id,
						serverId: getNewsletterServerIdFromMessage(sentMessage),
						error: ackErrorCode,
						stanza: ackStanzaDebug || undefined,
					},
					`${ackContext} was rejected by WhatsApp ack`,
				);
				noteNewsletterMessageDebug({
					discordMessageId: message.id,
					jid: targetJid,
					operation: ackContext,
					phase: "ack_rejected",
					details: {
						outboundId: normalizeBridgeMessageId(sentMessage?.key?.id),
						serverId: normalizeBridgeMessageId(
							getNewsletterServerIdFromMessage(sentMessage),
						),
						error: normalizeBridgeMessageId(ackErrorCode),
						stanza: ackStanzaDebug || undefined,
					},
				});
				if (notifyAckFailure) {
					await message.channel
						?.send(
							`Couldn't send this message to WhatsApp newsletter (ack ${ackErrorCode}).`,
						)
						.catch(() => {});
				}
			};
			if (!shouldTrackNewsletterAck) {
				if (newsletterChat && watchNewsletterAck) {
					const ackWaitMs = newsletterAckWaitMsForSentMessage(sentMessage);
					void (async () => {
						const ackErrorCode = await waitForNewsletterAckError(
							sentMessage?.key?.id,
							ackWaitMs,
						);
						if (!ackErrorCode) return;
						await notifyNewsletterAckFailure(ackErrorCode);
					})();
				}
				return { sentMessage, ackErrorCode: null };
			}

			const ackWaitMs = newsletterAckWaitMsForSentMessage(sentMessage);
			const ackErrorCode = await waitForNewsletterAckError(
				sentMessage?.key?.id,
				ackWaitMs,
			);
			if (!ackErrorCode) {
				noteNewsletterMessageDebug({
					discordMessageId: message.id,
					jid: targetJid,
					operation: ackContext,
					phase: "ack_ok",
					details: {
						outboundId: normalizeBridgeMessageId(sentMessage?.key?.id),
						serverId: normalizeBridgeMessageId(
							getNewsletterServerIdFromMessage(sentMessage),
						),
						ackWaitMs,
					},
				});
				return { sentMessage, ackErrorCode: null };
			}

			if (
				useNewsletterSpecialFlow &&
				retryWithoutQuotedOnAck &&
				sendOptions?.quoted
			) {
				clearFailedNewsletterMapping({
					discordMessageId: message.id,
					sentMessage,
				});
				const replyContext = await ensureNewsletterReplyFallbackContext();
				const retryContent = cloneNewsletterSendContentWithReplyFallback(
					content,
					replyContext,
				);
				const retryOptions = { ...sendOptions };
				delete retryOptions.quoted;
				state.logger?.warn?.(
					{
						jid: targetJid,
						discordMessageId: message.id,
						outboundId: sentMessage?.key?.id,
						serverId: getNewsletterServerIdFromMessage(sentMessage),
						error: ackErrorCode,
						ackWaitMs,
					},
					`${ackContext} was rejected by WhatsApp ack; retrying without quoted context`,
				);
				return await sendTrackedMessage(
					retryContent,
					Object.keys(retryOptions).length ? retryOptions : undefined,
					{
						ackContext,
						notifyAckFailure,
						retryWithoutQuotedOnAck: false,
					},
				);
			}
			await notifyNewsletterAckFailure(ackErrorCode);
			return { sentMessage, ackErrorCode };
		};

		if (state.settings.UploadAttachments && attachmentsToSend.length > 0) {
			const preparedAttachments = [];
			for (const file of attachmentsToSend) {
				const preparedFile = normalizeAttachmentForWhatsAppSend(file);
				let doc = await normalizeStickerSendContentForWhatsApp({
					attachment: preparedFile,
					jid: targetJid,
					discordMessageId: message?.id,
				});
				if (!doc) {
					doc = utils.whatsapp.createDocumentContent(preparedFile);
				}
				if (!doc) continue;
				if (!doc.sticker) {
					doc = await normalizeAudioSendContentForWhatsApp({
						attachment: preparedFile,
						content: doc,
						jid: targetJid,
						discordMessageId: message?.id,
					});
					doc = await normalizeRegularImageSendContentForWhatsApp({
						attachment: preparedFile,
						content: doc,
						jid: targetJid,
						discordMessageId: message?.id,
					});
					doc = await ensureImageThumbForWhatsAppSend({
						content: doc,
						jid: targetJid,
						discordMessageId: message?.id,
					});
					if (newsletterChat) {
						doc = await normalizeNewsletterImageSendContent({
							content: doc,
							jid: targetJid,
							discordMessageId: message?.id,
						});
					}
				}
				preparedAttachments.push({
					attachment: preparedFile,
					content: doc,
				});
			}

			const attachmentCaptionText = await buildAttachmentCaptionText({
				text,
				hasOnlyCustomEmoji,
				isForwardedFromDiscord,
				useNewsletterSpecialFlow,
				hasReplyReference,
				options,
				ensureNewsletterReplyFallbackContext,
				prependReplyFallbackContext,
			});

			const albumEligibleAttachments = preparedAttachments.filter(
				({ content }) => Boolean(getAlbumEligibleMediaKind(content)),
			);
			const canUseMediaAlbum =
				!newsletterChat &&
				!isBroadcastJid(targetJid) &&
				preparedAttachments.length >= 2 &&
				albumEligibleAttachments.length === preparedAttachments.length;
			if (canUseMediaAlbum) {
				let sentAnyAlbum = false;
				for (const [batchIndex, batch] of chunkList(
					preparedAttachments,
					WHATSAPP_MEDIA_ALBUM_MAX_ITEMS,
				).entries()) {
					const albumResult = await sendMediaAlbumToWhatsApp({
						client,
						jid: targetJid,
						discordMessageId: message.id,
						contents: batch.map((entry) => entry.content),
						captionText: batchIndex === 0 ? attachmentCaptionText : "",
						mentionJids: batchIndex === 0 ? mentionJids : [],
						mentionAll: batchIndex === 0 ? mentionAll : false,
						quoted: batchIndex === 0 ? options?.quoted : undefined,
					});
					if (albumResult?.error) {
						state.logger?.error?.(
							{
								err: albumResult.error,
								jid: targetJid,
								discordMessageId: message?.id,
								attachments: batch.length,
							},
							albumResult.startedRelay
								? "Failed while relaying WhatsApp media album"
								: "Failed to prepare WhatsApp media album; falling back to sequential attachment sends",
						);
					}
					if (albumResult?.startedRelay) {
						sentAnyAlbum = true;
						if (albumResult.sentChildren === 0) {
							state.logger?.warn?.(
								{
									jid: targetJid,
									discordMessageId: message?.id,
								},
								"WhatsApp media album relay started but no children were confirmed sent; skipping sequential fallback to avoid duplicates",
							);
						}
						continue;
					}
					if (!albumResult?.sentChildren) {
						if (sentAnyAlbum) {
							return;
						}
						sentAnyAlbum = false;
						break;
					}
					sentAnyAlbum = true;
				}
				if (sentAnyAlbum) {
					return;
				}
			}

			const firstPreparedContent = preparedAttachments[0]?.content || null;
			const firstAttachmentIsSticker = Boolean(firstPreparedContent?.sticker);
			const sentStandaloneStickerText =
				firstAttachmentIsSticker && Boolean(attachmentCaptionText);
			if (sentStandaloneStickerText) {
				const standaloneTextPayload = { text: attachmentCaptionText };
				if (!newsletterChat && mentionJids.length) {
					standaloneTextPayload.mentions = mentionJids;
				}
				if (mentionAll) {
					standaloneTextPayload.mentionAll = true;
				}
				await sendTrackedMessage(standaloneTextPayload, options, {
					ackContext: "Sticker companion text send",
					forceNewsletterAck: newsletterChat,
				});
			}

			let first = true;
			let sentAnyAttachment = false;
			let attemptedAttachmentSends = 0;
			for (const {
				attachment: preparedFile,
				content: doc,
			} of preparedAttachments) {
				attemptedAttachmentSends += 1;
				if (first) {
					if (
						!sentStandaloneStickerText &&
						(attachmentCaptionText || mentionJids.length)
					) {
						doc.caption = attachmentCaptionText;
					}
					if (
						!sentStandaloneStickerText &&
						!newsletterChat &&
						mentionJids.length
					) {
						doc.mentions = mentionJids;
					}
					if (!sentStandaloneStickerText && mentionAll) {
						doc.mentionAll = true;
					}
				}
				try {
					const { ackErrorCode } = await sendTrackedMessage(
						doc,
						first && !sentStandaloneStickerText ? options : undefined,
						{
							ackContext: "Newsletter attachment send",
							forceNewsletterAck: newsletterChat,
						},
					);
					if (!ackErrorCode) {
						sentAnyAttachment = true;
					}
				} catch (err) {
					state.logger?.error(err);
					noteNewsletterMessageDebug({
						discordMessageId: message.id,
						jid: targetJid,
						operation: "Newsletter attachment send",
						phase: "send_error",
						details: {
							attachmentName: preparedFile?.name || null,
							error: normalizeBridgeMessageId(
								err?.output?.statusCode ||
									err?.statusCode ||
									err?.code ||
									err?.message ||
									"send_error",
							),
						},
					});
				}
				if (first) {
					first = false;
				}
			}
			if (sentAnyAttachment) {
				return;
			}
			if (attemptedAttachmentSends > 0) {
				state.logger?.warn?.(
					{
						jid: targetJid,
						discordMessageId: message.id,
						attachments: attemptedAttachmentSends,
					},
					"All attachment sends failed; falling back to text/link send",
				);
				noteNewsletterMessageDebug({
					discordMessageId: message.id,
					jid: targetJid,
					operation: "Newsletter attachment send",
					phase: "all_variants_failed",
					details: {
						attachments: attemptedAttachmentSends,
					},
				});
			}
		}

		const fallbackParts = [];
		if (text) {
			fallbackParts.push(text);
		} else if (hasOnlyCustomEmoji && emojiFallbackText) {
			fallbackParts.push(emojiFallbackText);
		}
		const attachmentLinks = attachmentLinksForFallback;
		fallbackParts.push(...attachmentLinks);
		let finalText = fallbackParts.join(" ").trim();
		if (isForwardedFromDiscord) {
			finalText = finalText ? `Forwarded\n${finalText}` : "Forwarded";
		}
		if (useNewsletterSpecialFlow && hasReplyReference && !options.quoted) {
			const replyContext = await ensureNewsletterReplyFallbackContext();
			finalText = prependReplyFallbackContext(finalText, replyContext);
		}
		if (!finalText) {
			return;
		}

		const content = { text: finalText };
		if (!newsletterChat && mentionJids.length) {
			content.mentions = mentionJids;
		}
		if (mentionAll) {
			content.mentionAll = true;
		}
		let preview = null;
		if (!newsletterChat) {
			try {
				preview = await utils.whatsapp.generateLinkPreview(finalText, {
					uploadImage:
						typeof client.waUploadToServer === "function"
							? client.waUploadToServer
							: undefined,
					logger: state.logger,
				});
			} catch (err) {
				state.logger?.warn(
					{ err },
					"Failed to generate Discord link preview payload",
				);
			}
		}
		if (preview) {
			content.linkPreview = preview;
			options.getUrlInfo = () => preview;
		}

		try {
			const { ackErrorCode } = await sendTrackedMessage(content, options, {
				ackContext: "Newsletter text send",
				notifyAckFailure: newsletterChat,
				watchNewsletterAck: newsletterChat,
			});
			if (ackErrorCode) {
				return;
			}
		} catch (err) {
			state.logger?.error(err);
			if (useNewsletterSpecialFlow) {
				const metadata =
					typeof client.newsletterMetadata === "function"
						? await client
								.newsletterMetadata("jid", targetJid)
								.catch(() => null)
						: null;
				const role =
					metadata?.viewer_metadata?.role || metadata?.viewerMetadata?.role;
				const roleHint =
					role && !["OWNER", "ADMIN"].includes(role)
						? ` Current account role: ${role}.`
						: "";
				await message.channel
					?.send(
						`Couldn't send to WhatsApp channel ${targetJid}.${roleHint} Newsletters require OWNER/ADMIN posting rights and may reject some media types.`,
					)
					.catch(() => {});
			}
		}
	});

	client.ev.on("discordEdit", async ({ jid, message }) => {
		if (!allowsDiscordToWhatsApp()) {
			return;
		}

		const targetJid = normalizeSendJid(jid);
		const newsletterChat = isNewsletterJid(targetJid);
		if (newsletterChat) {
			noteNewsletterMessageDebug({
				discordMessageId: message?.id,
				jid: targetJid,
				operation: "Newsletter edit",
				phase: "unsupported",
				details: {
					reason: "baileys_newsletter_edit_unsupported",
				},
			});
			await message?.channel
				?.send(
					"Newsletter message editing isn't supported by Baileys yet. Please edit the message directly in WhatsApp on your phone.",
				)
				.catch(() => {});
			return;
		}
		const candidateId = normalizeBridgeMessageId(
			state.lastMessages[message.id],
		);
		const messageId = candidateId;

		const key = newsletterChat
			? buildNewsletterActionKey({
					remoteJid: targetJid,
					actionId: messageId,
					fromMe: true,
				})
			: {
					id: messageId,
					fromMe:
						message.webhookId == null || message.author.username === "You",
					remoteJid: targetJid,
				};
		if (!key) {
			state.logger?.warn?.(
				{
					jid: targetJid,
					discordMessageId: message?.id,
					messageId,
				},
				"Skipping newsletter edit because action key could not be built",
			);
			await message.channel
				.send(
					"Couldn't edit this newsletter message because a valid action key could not be built.",
				)
				.catch(() => {});
			return;
		}

		if (!newsletterChat && targetJid.endsWith("@g.us")) {
			key.participant = utils.whatsapp.toJid(message.author.username);
		}

		const embedMirroringEnabled = Boolean(
			state.settings.DiscordEmbedsToWhatsApp,
		);
		const embedTextRaw =
			embedMirroringEnabled &&
			typeof utils.discord.extractEmbedText === "function"
				? utils.discord.extractEmbedText(message, { includeUrls: true })
				: "";

		let text = utils.whatsapp.convertDiscordFormatting(
			message.content ?? message.cleanContent,
		);
		const embedText = embedTextRaw
			? utils.whatsapp.convertDiscordFormatting(embedTextRaw)
			: "";
		if (embedText) {
			text = text ? `${text}\n${embedText}` : embedText;
		}
		if (message.reference) {
			text = text.replace(DISCORD_REPLY_PREFIX_REGEX, "");
		}
		if (text && typeof text.normalize === "function") {
			text = text.normalize("NFKC");
		}
		if (state.settings.DiscordPrefix) {
			const prefix =
				state.settings.DiscordPrefixText ||
				message.member?.nickname ||
				message.author.username;
			text = `*${prefix}*\n${text}`;
		}

		const replyMentionId = message.reference
			? message.mentions?.repliedUser?.id
			: null;
		const mentionTextCandidates = [
			message.content,
			message.cleanContent,
			embedTextRaw,
			embedText,
			text,
		];
		const mentionResolution = await resolveDiscordTextMentionsForWhatsApp({
			message,
			text,
			jid: targetJid,
			textCandidates: mentionTextCandidates,
			replyMentionId,
		});
		text = mentionResolution.text;
		const editMentions = mentionResolution.mentionJids;
		const editMentionAll = mentionResolution.mentionAll;
		const editOptions = buildSendOptionsForJid(targetJid);
		const sendEditWithKey = async (editKey, mode = "default") => {
			if (newsletterChat) {
				noteNewsletterMessageDebug({
					discordMessageId: message.id,
					jid: targetJid,
					operation: "Newsletter edit",
					phase: "attempt",
					details: {
						mode,
						targetId: normalizeBridgeMessageId(messageId),
						keyId: normalizeBridgeMessageId(editKey?.id),
						keyServerId: normalizeBridgeMessageId(
							editKey?.server_id || editKey?.serverId,
						),
						textLength: typeof text === "string" ? text.length : 0,
					},
				});
			}
			const editMsg = await client.sendMessage(
				targetJid,
				{
					text,
					edit: editKey,
					...(!newsletterChat && editMentions.length
						? { mentions: editMentions }
						: {}),
					...(editMentionAll ? { mentionAll: true } : {}),
				},
				editOptions,
			);
			state.sentMessages.add(editMsg.key.id);
			if (!newsletterChat) {
				return { editMsg, ackErrorCode: null };
			}
			const ackWaitMs = newsletterAckWaitMsForSentMessage(editMsg);
			const ackErrorCode = await waitForNewsletterAckError(
				editMsg?.key?.id,
				ackWaitMs,
			);
			if (ackErrorCode) {
				noteNewsletterMessageDebug({
					discordMessageId: message.id,
					jid: targetJid,
					operation: "Newsletter edit",
					phase: "ack_rejected",
					details: {
						mode,
						outboundId: normalizeBridgeMessageId(editMsg?.key?.id),
						error: normalizeBridgeMessageId(ackErrorCode),
					},
				});
			} else {
				noteNewsletterMessageDebug({
					discordMessageId: message.id,
					jid: targetJid,
					operation: "Newsletter edit",
					phase: "ack_ok",
					details: {
						mode,
						outboundId: normalizeBridgeMessageId(editMsg?.key?.id),
						ackWaitMs,
					},
				});
			}
			return { editMsg, ackErrorCode };
		};

		try {
			const primaryResult = await sendEditWithKey(
				key,
				key?.server_id ? "server_id_key" : "id_key",
			);
			if (newsletterChat && primaryResult?.ackErrorCode && key?.server_id) {
				const fallbackKey = {
					remoteJid: targetJid,
					id: normalizeBridgeMessageId(messageId),
					fromMe: true,
				};
				state.logger?.warn?.(
					{
						jid: targetJid,
						discordMessageId: message?.id,
						targetId: normalizeBridgeMessageId(messageId),
						error: primaryResult.ackErrorCode,
					},
					"Newsletter edit with server_id key was rejected; retrying with id key",
				);
				const fallbackResult = await sendEditWithKey(
					fallbackKey,
					"id_key_fallback",
				);
				if (!fallbackResult?.ackErrorCode) {
					return;
				}
				await message.channel
					.send(
						`Couldn't edit this newsletter message (ack ${fallbackResult.ackErrorCode}). WhatsApp rejected the edit request.`,
					)
					.catch(() => {});
				return;
			}
			if (newsletterChat && primaryResult?.ackErrorCode) {
				await message.channel
					.send(
						`Couldn't edit this newsletter message (ack ${primaryResult.ackErrorCode}). WhatsApp rejected the edit request.`,
					)
					.catch(() => {});
			}
		} catch (err) {
			state.logger?.error(err);
			noteNewsletterMessageDebug({
				discordMessageId: message.id,
				jid: targetJid,
				operation: "Newsletter edit",
				phase: "send_error",
				details: {
					error: normalizeBridgeMessageId(
						err?.output?.statusCode ||
							err?.statusCode ||
							err?.code ||
							err?.message ||
							"send_error",
					),
				},
			});
			await message.channel.send("Couldn't edit the message on WhatsApp.");
		}
	});

	client.ev.on(
		"discordReaction",
		async ({ jid, reaction, removed, messageId: resolvedMessageId }) => {
			if (!allowsDiscordToWhatsApp()) {
				return;
			}

			const targetJid = normalizeSendJid(jid);
			const newsletterChat = isNewsletterJid(targetJid);
			const mappedMessageId =
				normalizeBridgeMessageId(resolvedMessageId) ||
				normalizeBridgeMessageId(state.lastMessages[reaction.message.id]);
			if (!mappedMessageId && !newsletterChat) {
				state.logger?.warn?.(
					{
						jid: targetJid,
						discordMessageId: reaction?.message?.id,
					},
					"Skipping Discord reaction because the linked WhatsApp message ID is unavailable",
				);
				return;
			}
			const key = {
				id: mappedMessageId,
				fromMe:
					reaction.message.webhookId == null ||
					reaction.message.author.username === "You",
				remoteJid: targetJid,
			};

			if (targetJid.endsWith("@g.us")) {
				key.participant = utils.whatsapp.toJid(
					reaction.message.author.username,
				);
			}

			if (newsletterChat) {
				await ensureNewsletterLiveUpdatesSubscription(client, targetJid);
				const candidateId = normalizeBridgeMessageId(key.id);
				const hasPendingSend = Boolean(
					getPendingNewsletterSend({
						jid: targetJid,
						outboundId: candidateId,
						discordMessageId: reaction?.message?.id,
					}),
				);
				let serverId = await waitForNewsletterServerId({
					discordMessageId: reaction?.message?.id,
					candidateId: key.id,
					timeoutMs: hasPendingSend
						? NEWSLETTER_SERVER_ID_WAIT_TIMEOUT_MS
						: NEWSLETTER_SERVER_ID_WAIT_WITHOUT_PENDING_MS,
					pollMs: NEWSLETTER_SERVER_ID_WAIT_POLL_MS,
				});
				if (!serverId) {
					serverId = await resolveNewsletterServerIdFromFetch({
						client,
						jid: targetJid,
						discordMessageId: reaction?.message?.id,
						candidateId,
					});
				}
				const actionId = serverId || candidateId;
				if (!actionId) {
					state.logger?.warn?.(
						{
							jid: targetJid,
							discordMessageId: reaction?.message?.id,
							candidateId: key.id,
						},
						"Timed out waiting for newsletter server ID before reaction",
					);
					await reaction?.message?.channel
						?.send(
							"Couldn't send that reaction yet because the newsletter server message ID is still unavailable.",
						)
						.catch(() => {});
					return;
				}
				if (!serverId && candidateId) {
					const sendAckError = getNewsletterAckError(candidateId);
					if (sendAckError) {
						state.logger?.warn?.(
							{
								jid: targetJid,
								discordMessageId: reaction?.message?.id,
								candidateId,
								error: sendAckError,
							},
							"Skipping newsletter reaction because original message was rejected by WhatsApp ack",
						);
						await reaction?.message?.channel
							?.send(
								`Couldn't react because the original newsletter send failed (ack ${sendAckError}).`,
							)
							.catch(() => {});
						return;
					}
					state.logger?.warn?.(
						{
							jid: targetJid,
							discordMessageId: reaction?.message?.id,
							candidateId,
						},
						"Timed out waiting for newsletter server ID before reaction; falling back to outbound message ID",
					);
				}
				if (typeof client.newsletterReactMessage !== "function") {
					state.logger?.warn?.(
						{ jid: targetJid },
						"newsletterReactMessage is unavailable on this WhatsApp client",
					);
					return;
				}
				state.lastMessages[reaction.message.id] = actionId;
				state.lastMessages[actionId] = reaction.message.id;

				try {
					await client.newsletterReactMessage(
						targetJid,
						actionId,
						removed ? undefined : reaction.emoji.name,
					);
					state.sentReactions.add(actionId);
				} catch (err) {
					state.logger?.error(err);
					await reaction?.message?.channel
						?.send(
							"Couldn't apply that reaction on the WhatsApp newsletter message.",
						)
						.catch(() => {});
				}
				return;
			}

			const reactionOptions = buildSendOptionsForJid(targetJid);
			try {
				const reactionMsg = await client.sendMessage(
					targetJid,
					{
						react: {
							text: removed ? "" : reaction.emoji.name,
							key,
						},
					},
					reactionOptions,
				);
				const messageId = reactionMsg.key.id;
				state.lastMessages[messageId] = true;
				state.sentMessages.add(messageId);
				state.sentReactions.add(key.id);
			} catch (err) {
				state.logger?.error(err);
			}
		},
	);

	client.ev.on("discordDelete", async ({ jid, id, discordMessageId }) => {
		if (!allowsDiscordToWhatsApp()) {
			return;
		}

		const targetJid = normalizeSendJid(jid);
		const newsletterChat = isNewsletterJid(targetJid);
		if (newsletterChat) {
			noteNewsletterMessageDebug({
				discordMessageId,
				jid: targetJid,
				operation: "Newsletter delete",
				phase: "unsupported",
				details: {
					reason: "baileys_newsletter_delete_unsupported",
				},
			});
			await notifyLinkedDiscordChannel(
				targetJid,
				"Newsletter message deletion isn't supported by Baileys yet. Please delete the message directly in WhatsApp on your phone.",
			);
			return;
		}
		const rawDeleteId = normalizeBridgeMessageId(id);
		const outboundCandidateId =
			rawDeleteId ||
			normalizeBridgeMessageId(state.lastMessages[discordMessageId]);
		let deleteId = newsletterChat
			? await waitForNewsletterServerId({
					discordMessageId,
					candidateId: outboundCandidateId,
					timeoutMs: NEWSLETTER_SERVER_ID_WAIT_TIMEOUT_MS,
					pollMs: NEWSLETTER_SERVER_ID_WAIT_POLL_MS,
				})
			: rawDeleteId;
		if (newsletterChat && !deleteId) {
			await ensureNewsletterLiveUpdatesSubscription(client, targetJid);
			deleteId = await waitForNewsletterServerId({
				discordMessageId,
				candidateId: outboundCandidateId,
				timeoutMs: NEWSLETTER_SERVER_ID_WAIT_TIMEOUT_MS,
				pollMs: NEWSLETTER_SERVER_ID_WAIT_POLL_MS,
			});
		}
		if (newsletterChat && !deleteId) {
			deleteId = await resolveNewsletterServerIdFromFetch({
				client,
				jid: targetJid,
				discordMessageId,
				candidateId: outboundCandidateId,
			});
		}
		const actionDeleteId =
			deleteId || (newsletterChat ? outboundCandidateId : null);
		if (!targetJid || !actionDeleteId) {
			if (newsletterChat) {
				state.logger?.warn?.(
					{
						jid: targetJid,
						discordMessageId,
						id: rawDeleteId,
					},
					"Timed out waiting for newsletter server ID before delete",
				);
				await notifyLinkedDiscordChannel(
					targetJid,
					"Couldn't delete this newsletter message yet because a server message ID is still unavailable.",
				);
			}
			return;
		}
		if (newsletterChat && !deleteId && outboundCandidateId) {
			const sendAckError = getNewsletterAckError(outboundCandidateId);
			if (sendAckError) {
				state.logger?.warn?.(
					{
						jid: targetJid,
						discordMessageId,
						id: rawDeleteId,
						candidateId: outboundCandidateId,
						error: sendAckError,
					},
					"Skipping newsletter delete because original message was rejected by WhatsApp ack",
				);
				await notifyLinkedDiscordChannel(
					targetJid,
					`Couldn't delete this newsletter message because its original send failed (ack ${sendAckError}).`,
				);
				return;
			}
			state.logger?.warn?.(
				{
					jid: targetJid,
					discordMessageId,
					id: rawDeleteId,
					candidateId: outboundCandidateId,
				},
				"Timed out waiting for newsletter server ID before delete; falling back to outbound message ID",
			);
		}
		const deleteOptions = buildSendOptionsForJid(targetJid);
		const sendDeleteWithKey = async (deleteKey, mode = "default") => {
			if (newsletterChat) {
				noteNewsletterMessageDebug({
					discordMessageId,
					jid: targetJid,
					operation: "Newsletter delete",
					phase: "attempt",
					details: {
						mode,
						targetId: normalizeBridgeMessageId(actionDeleteId),
						keyId: normalizeBridgeMessageId(deleteKey?.id),
						keyServerId: normalizeBridgeMessageId(
							deleteKey?.server_id || deleteKey?.serverId,
						),
					},
				});
			}
			const sentDelete = await client.sendMessage(
				targetJid,
				{
					delete: deleteKey,
				},
				deleteOptions,
			);
			if (!newsletterChat) {
				return { sentDelete, ackErrorCode: null };
			}
			const ackWaitMs = newsletterAckWaitMsForSentMessage(sentDelete);
			const ackErrorCode = await waitForNewsletterAckError(
				sentDelete?.key?.id,
				ackWaitMs,
			);
			if (ackErrorCode) {
				noteNewsletterMessageDebug({
					discordMessageId,
					jid: targetJid,
					operation: "Newsletter delete",
					phase: "ack_rejected",
					details: {
						mode,
						outboundId: normalizeBridgeMessageId(sentDelete?.key?.id),
						error: normalizeBridgeMessageId(ackErrorCode),
					},
				});
			} else {
				noteNewsletterMessageDebug({
					discordMessageId,
					jid: targetJid,
					operation: "Newsletter delete",
					phase: "ack_ok",
					details: {
						mode,
						outboundId: normalizeBridgeMessageId(sentDelete?.key?.id),
						ackWaitMs,
					},
				});
			}
			return { sentDelete, ackErrorCode };
		};

		try {
			const primaryDeleteKey = newsletterChat
				? buildNewsletterActionKey({
						remoteJid: targetJid,
						actionId: actionDeleteId,
						fromMe: true,
					})
				: {
						remoteJid: targetJid,
						id: actionDeleteId,
						fromMe: true,
					};
			if (!primaryDeleteKey) {
				state.logger?.warn?.(
					{
						jid: targetJid,
						discordMessageId,
						actionDeleteId,
					},
					"Skipping newsletter delete because action key could not be built",
				);
				return;
			}
			const primaryDeleteResult = await sendDeleteWithKey(
				primaryDeleteKey,
				primaryDeleteKey?.server_id ? "server_id_key" : "id_key",
			);
			if (
				newsletterChat &&
				primaryDeleteResult?.ackErrorCode &&
				primaryDeleteKey?.server_id
			) {
				const fallbackDeleteKey = {
					remoteJid: targetJid,
					id: normalizeBridgeMessageId(actionDeleteId),
					fromMe: true,
				};
				state.logger?.warn?.(
					{
						jid: targetJid,
						discordMessageId,
						actionDeleteId: normalizeBridgeMessageId(actionDeleteId),
						error: primaryDeleteResult.ackErrorCode,
					},
					"Newsletter delete with server_id key was rejected; retrying with id key",
				);
				const fallbackDeleteResult = await sendDeleteWithKey(
					fallbackDeleteKey,
					"id_key_fallback",
				);
				if (!fallbackDeleteResult?.ackErrorCode) {
					return;
				}
				await notifyLinkedDiscordChannel(
					targetJid,
					`Couldn't delete this newsletter message (ack ${fallbackDeleteResult.ackErrorCode}). WhatsApp rejected the delete request.`,
				);
				return;
			}
			if (newsletterChat && primaryDeleteResult?.ackErrorCode) {
				await notifyLinkedDiscordChannel(
					targetJid,
					`Couldn't delete this newsletter message (ack ${primaryDeleteResult.ackErrorCode}). WhatsApp rejected the delete request.`,
				);
			}
		} catch (err) {
			state.logger?.error(err);
			noteNewsletterMessageDebug({
				discordMessageId,
				jid: targetJid,
				operation: "Newsletter delete",
				phase: "send_error",
				details: {
					error: normalizeBridgeMessageId(
						err?.output?.statusCode ||
							err?.statusCode ||
							err?.code ||
							err?.message ||
							"send_error",
					),
				},
			});
		}
	});

	return client;
};

const actions = {
	async start() {
		const baileyState = await useSQLiteAuthState();
		await ensureSignalStoreSupport(baileyState.state?.keys);
		authState = baileyState.state;
		saveState = baileyState.saveCreds;
		state.waClient = await connectToWhatsApp();
	},
};

export { connectToWhatsApp };
export default actions;
