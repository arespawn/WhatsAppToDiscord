import childProcess from "node:child_process";
import crypto from "node:crypto";
import dns from "node:dns";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import {
	downloadContentFromMessage,
	downloadMediaMessage,
	prepareWAMessageMedia,
} from "@whiskeysockets/baileys";
import discordJs from "discord.js";
import * as linkPreview from "link-preview-js";
import QRCode from "qrcode";
import * as tar from "tar";
import { Agent } from "undici";
import {
	chatTargetsChannelId,
	chatUsesHostChannelId,
	getChatHostChannelId,
	getChatTargetChannelId,
	isThreadChatLink,
} from "./chatLinks.js";
import { getImageSharp } from "./imageLibs.js";
import { createWhatsAppAudioToDiscordFileNormalizer } from "./internal/whatsappAudioToDiscordNormalization.js";
import { createWhatsAppGifToDiscordFileNormalizer } from "./internal/whatsappGifToDiscordNormalization.js";
import messageStore from "./messageStore.js";
import state from "./state.js";
import storage from "./storage.js";

const {
	ActionRowBuilder,
	AttachmentBuilder,
	ButtonBuilder,
	ButtonStyle,
	ChannelType,
	StickerFormatType,
	ThreadAutoArchiveDuration,
	WebhookClient,
} = discordJs;

const DOWNLOAD_TOKEN_VERSION = 1;
const CUSTOM_EMOJI_REGEX = /<(a?):([a-zA-Z0-9_]{1,32}):(\d+)>/g;
const GIF_URL_EXTENSION_REGEX = /\.(gif|mp4|webm)(?:[?#]|$)/i;
const GIF_PROVIDER_HINTS = ["tenor", "giphy", "imgur", "gyazo"];
const isKnownGifProvider = (value = "") =>
	GIF_PROVIDER_HINTS.some((hint) => value.includes(hint));
const isKnownGifProviderEmbed = (embed = {}) => {
	const shareCandidate =
		typeof embed?.url === "string" ? embed.url.toLowerCase() : "";
	const providerCandidate =
		typeof embed?.provider?.name === "string"
			? embed.provider.name.toLowerCase()
			: "";
	return (
		isKnownGifProvider(shareCandidate) || isKnownGifProvider(providerCandidate)
	);
};
const UNKNOWN_DISPLAY_NAME = "Unknown";
const SELF_DISPLAY_NAME = "You";
const escapeRegex = (value) =>
	String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const buildUnicodeMentionRegex = (token) =>
	new RegExp(`@${escapeRegex(token)}(?=$|\\s|[\\p{P}\\p{S}])`, "giu");
const buildWordBoundaryMentionRegex = (token) =>
	new RegExp(`@${escapeRegex(token)}(?=\\W|$)`, "g");
const WHATSAPP_MENTION_ALL_REGEX = /@all(?=$|\s|[\p{P}\p{S}])/giu;
const asLower = (value) => String(value || "").toLowerCase();
const includesHint = (text, hints) =>
	hints.some((hint) => text.includes(asLower(hint)));
const isUnknownDisplayName = (value = "") =>
	String(value).trim().toLowerCase() === UNKNOWN_DISPLAY_NAME.toLowerCase();
const isUnknownOrSelfDisplayName = (value = "") => {
	const normalized = String(value).trim().toLowerCase();
	return (
		normalized === UNKNOWN_DISPLAY_NAME.toLowerCase() ||
		normalized === SELF_DISPLAY_NAME.toLowerCase()
	);
};
const normalizeDiscordUserId = (value, { coerce = false } = {}) => {
	const rawValue =
		typeof value === "string" ? value : coerce ? String(value || "") : "";
	const trimmed = rawValue.trim();
	if (!trimmed) return null;
	return /^\d+$/.test(trimmed) ? trimmed : null;
};
const MIME_BY_EXTENSION = {
	gif: "image/gif",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	jpe: "image/jpeg",
	png: "image/png",
	apng: "image/png",
	webp: "image/webp",
	bmp: "image/bmp",
	tif: "image/tiff",
	tiff: "image/tiff",
	svg: "image/svg+xml",
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
const LINK_PREVIEW_FETCH_TIMEOUT_MS = 3000;
const LINK_PREVIEW_MAX_REDIRECTS = 5;
const LINK_PREVIEW_FETCH_OPTS = { timeout: LINK_PREVIEW_FETCH_TIMEOUT_MS };
const LINK_PREVIEW_MAX_BYTES = 1024 * 1024;
const LINK_PREVIEW_THUMB_MAX_BYTES = 8 * 1024 * 1024;
const FORUM_CHANNEL_TYPES = [ChannelType.GuildForum, "GUILD_FORUM"];
const MANAGED_THREAD_HOST_BASE_NAME = "whatsapp-threads";
const MANAGED_THREAD_HOST_OWNER_PREFIX = "WA2DC managed thread host for bot ";
const MANAGED_THREAD_HOST_SOFT_LIMIT = 500;
const MANAGED_THREAD_HOST_NAME_MAX_LENGTH = 80;
const DISCORD_MAX_FILES_PER_MESSAGE = 10;
const EXPLICIT_URL_REGEX = /<?https?:\/\/[^\s>]+>?/i;
const BARE_URL_REGEX =
	/(?:^|[\s<])((?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[\w\-./?%&=+#]*)?)(?=$|[\s>)\],.;!?])/i;
const TRAILING_PUNCTUATION_REGEX = /[)\],.;!?]+$/;
const RETRYABLE_WEBHOOK_MESSAGE_HINTS = [
	"aborted",
	"fetch failed",
	"terminated",
	"other side closed",
	"stream closed with error code",
	"nghttp2_protocol_error",
	"protocol error",
	"socket",
	"timed out",
	"timeout",
	"econnreset",
	"etimedout",
	"ehostunreach",
	"enotfound",
	"eai_again",
];
const RETRYABLE_WEBHOOK_CODE_HINTS = [
	"ABORT_ERR",
	"UND_ERR",
	"ERR_HTTP2_STREAM_ERROR",
	"ECONNRESET",
	"ETIMEDOUT",
	"EHOSTUNREACH",
	"ENOTFOUND",
	"EAI_AGAIN",
];
const UPDATE_BUTTON_IDS = {
	APPLY: "wa2dc:update",
	SKIP: "wa2dc:skip-update",
};
const ROLLBACK_BUTTON_ID = "wa2dc:rollback";
const normalizeWhatsAppGifFileForDiscord =
	createWhatsAppGifToDiscordFileNormalizer({
		getLogger: () => state.logger,
	});
const normalizeWhatsAppAudioFileForDiscord =
	createWhatsAppAudioToDiscordFileNormalizer({
		getLogger: () => state.logger,
	});
const resolveLinkPreviewFromContentFn = () => {
	let moduleExports;
	if (linkPreview && typeof linkPreview === "object") {
		for (const [key, value] of Object.entries(linkPreview)) {
			if (key === "module.exports") {
				moduleExports = value;
				break;
			}
		}
	}
	const candidates = [
		linkPreview?.getPreviewFromContent,
		linkPreview?.default?.getPreviewFromContent,
		moduleExports?.getPreviewFromContent,
	];
	return (
		candidates.find((candidate) => typeof candidate === "function") || null
	);
};
const getPreviewFromContentFn = resolveLinkPreviewFromContentFn();

const coercePositiveInt = (value) => {
	const number = Number(value);
	if (!Number.isFinite(number) || number <= 0) return null;
	return Math.floor(number);
};

const safeTimingEqual = (a, b) => {
	if (typeof a !== "string" || typeof b !== "string") return false;
	const aBuf = Buffer.from(a, "utf8");
	const bBuf = Buffer.from(b, "utf8");
	if (aBuf.length !== bBuf.length) return false;
	return crypto.timingSafeEqual(aBuf, bBuf);
};

const getDownloadServerSecretKey = () => {
	const secret = state.settings?.LocalDownloadServerSecret;
	if (typeof secret !== "string" || !secret) return null;
	try {
		return Buffer.from(secret, "base64url");
	} catch {
		return null;
	}
};

const ensureDownloadServerSecret = () => {
	const existing = getDownloadServerSecretKey();
	if (existing) return existing;
	const secret = crypto.randomBytes(32).toString("base64url");
	state.settings.LocalDownloadServerSecret = secret;
	storage.saveSettings?.().catch(() => {});
	return Buffer.from(secret, "base64url");
};

const getPrivacySaltKey = () => {
	const secret = state.settings?.PrivacySalt;
	if (typeof secret !== "string" || !secret) return null;
	try {
		return Buffer.from(secret, "base64url");
	} catch {
		return null;
	}
};

const ensurePrivacySaltKey = () => {
	const existing = getPrivacySaltKey();
	if (existing) return existing;
	const secret = crypto.randomBytes(32).toString("base64url");
	state.settings.PrivacySalt = secret;
	storage.saveSettings?.().catch(() => {});
	return Buffer.from(secret, "base64url");
};

const signDownloadTokenPayload = (payloadBase64) => {
	const secretKey = getDownloadServerSecretKey();
	if (!secretKey) return null;
	return crypto
		.createHmac("sha256", secretKey)
		.update(payloadBase64)
		.digest("base64url");
};

const buildDownloadToken = (fileName) => {
	const secretKey = ensureDownloadServerSecret();
	const ttl = coercePositiveInt(state.settings?.LocalDownloadLinkTTLSeconds);
	const now = Math.floor(Date.now() / 1000);
	const payload = { v: DOWNLOAD_TOKEN_VERSION, f: fileName };
	if (ttl) {
		payload.e = now + ttl;
	}
	const payloadBase64 = Buffer.from(JSON.stringify(payload), "utf8").toString(
		"base64url",
	);
	const signature = crypto
		.createHmac("sha256", secretKey)
		.update(payloadBase64)
		.digest("base64url");
	return `${payloadBase64}.${signature}`;
};

const verifyDownloadToken = (token) => {
	if (typeof token !== "string" || !token) return null;
	const parts = token.split(".");
	if (parts.length !== 2) return null;
	const [payloadBase64, signature] = parts;
	if (!payloadBase64 || !signature) return null;
	const expected = signDownloadTokenPayload(payloadBase64);
	if (!expected || !safeTimingEqual(expected, signature)) return null;
	let payload;
	try {
		payload = JSON.parse(
			Buffer.from(payloadBase64, "base64url").toString("utf8"),
		);
	} catch {
		return null;
	}
	if (!payload || payload.v !== DOWNLOAD_TOKEN_VERSION) return null;
	if (typeof payload.f !== "string" || !payload.f) return null;
	const now = Math.floor(Date.now() / 1000);
	if (payload.e != null) {
		const exp = Number(payload.e);
		if (!Number.isFinite(exp)) return null;
		if (now > exp) return { ...payload, expired: true };
	}
	return payload;
};

const normalizeHostname = (hostname = "") =>
	hostname.replace(/\.$/, "").toLowerCase();

const isHostnameEqualOrSubdomain = (hostname = "", domain = "") => {
	const normalizedHost = normalizeHostname(hostname);
	const normalizedDomain = normalizeHostname(domain);
	if (!normalizedHost || !normalizedDomain) return false;
	return (
		normalizedHost === normalizedDomain ||
		normalizedHost.endsWith(`.${normalizedDomain}`)
	);
};

const ipv4ToInt = (addr) => {
	const parts = String(addr).split(".");
	if (parts.length !== 4) return null;
	const bytes = parts.map((part) => Number(part));
	if (bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255))
		return null;
	return (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
};

const isPrivateIPv4Int = (value) => {
	if (!Number.isInteger(value)) return true;
	const unsigned = value >>> 0;
	const first = unsigned >>> 24;
	const second = (unsigned >>> 16) & 0xff;

	if (first === 10) return true;
	if (first === 127) return true;
	if (first === 169 && second === 254) return true;
	if (first === 172 && second >= 16 && second <= 31) return true;
	if (first === 192 && second === 168) return true;
	if (first === 0) return true;
	return false;
};

const isBlockedIp = (address = "") => {
	const ipVersion = net.isIP(address);
	if (ipVersion === 4) {
		const asInt = ipv4ToInt(address);
		return isPrivateIPv4Int(asInt);
	}
	if (ipVersion === 6) {
		const normalized = address.toLowerCase();
		if (normalized === "::" || normalized === "::1") return true;
		if (normalized.startsWith("::ffff:")) {
			const tail = normalized.slice("::ffff:".length);
			if (net.isIP(tail) === 4) return isBlockedIp(tail);
		}

		if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;

		if (
			normalized.startsWith("fe8") ||
			normalized.startsWith("fe9") ||
			normalized.startsWith("fea") ||
			normalized.startsWith("feb")
		)
			return true;

		if (normalized.startsWith("ff")) return true;
		return false;
	}
	return false;
};

const isBlockedHostname = (hostname = "") => {
	const normalized = normalizeHostname(hostname);
	if (!normalized) return true;
	if (normalized === "localhost" || normalized.endsWith(".localhost"))
		return true;
	return false;
};

const pickSafeLookupResult = (results = [], familyPreference) => {
	const filtered = results
		.filter((entry) => entry?.address && !isBlockedIp(entry.address))
		.filter((entry) =>
			familyPreference ? entry.family === familyPreference : true,
		);
	if (!filtered.length) return null;
	const ipv4 = filtered.find((entry) => entry.family === 4);
	return ipv4 || filtered[0];
};

const linkPreviewLookup = (hostname, options, callback) => {
	Promise.resolve()
		.then(async () => {
			const normalized = normalizeHostname(hostname);
			if (isBlockedHostname(normalized)) {
				throw new Error("Blocked hostname");
			}

			const ipVersion = net.isIP(normalized);
			const wantsAll = Boolean(options?.all);
			if (ipVersion) {
				if (isBlockedIp(normalized)) {
					throw new Error("Blocked IP address");
				}
				const entry = { address: normalized, family: ipVersion };
				return wantsAll ? [entry] : entry;
			}

			const family =
				options?.family === 4 || options?.family === 6
					? options.family
					: undefined;
			const results = await dns.promises.lookup(normalized, {
				all: true,
				verbatim: true,
			});
			const filtered = results
				.filter((entry) => entry?.address && !isBlockedIp(entry.address))
				.filter((entry) => (family ? entry.family === family : true));
			if (!filtered.length) {
				throw new Error("No public IPs resolved for host");
			}
			if (wantsAll) {
				return filtered;
			}
			const picked = pickSafeLookupResult(filtered);
			if (!picked) {
				throw new Error("No public IPs resolved for host");
			}
			return picked;
		})
		.then((picked) => {
			if (Array.isArray(picked)) {
				callback(null, picked);
				return;
			}
			callback(null, picked.address, picked.family);
		})
		.catch((err) => callback(err));
};

const linkPreviewDispatcher = new Agent({
	connect: { lookup: linkPreviewLookup },
});

const isSafeUrlForPreviewFetch = async (candidate) => {
	if (!candidate) return false;
	let url;
	try {
		url = new URL(candidate);
	} catch {
		return false;
	}
	if (!["http:", "https:"].includes(url.protocol)) return false;
	if (url.username || url.password) return false;
	const hostname = normalizeHostname(url.hostname);
	if (isBlockedHostname(hostname)) return false;

	const ipVersion = net.isIP(hostname);
	if (ipVersion) {
		return !isBlockedIp(hostname);
	}

	let results;
	try {
		results = await dns.promises.lookup(hostname, {
			all: true,
			verbatim: true,
		});
	} catch {
		return false;
	}
	if (!Array.isArray(results) || results.length === 0) return false;
	return results.every(
		(entry) => entry?.address && !isBlockedIp(entry.address),
	);
};

const readBodyWithLimit = async (body, maxBytes) => {
	if (!body || typeof body.getReader !== "function") {
		return Buffer.alloc(0);
	}
	const reader = body.getReader();
	const chunks = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			total += value.byteLength || value.length || 0;
			if (total > maxBytes) {
				const err = new Error("Response too large");
				err.code = "WA2DC_PREVIEW_TOO_LARGE";
				throw err;
			}
			chunks.push(Buffer.from(value));
		}
	} finally {
		try {
			await reader.cancel();
		} catch (err) {
			void err;
		}
	}
	return Buffer.concat(chunks, total);
};

const validatePreviewTargetUrl = (candidate = "") => {
	let url;
	try {
		url = new URL(candidate);
	} catch {
		throw new Error("Invalid URL");
	}
	if (!["http:", "https:"].includes(url.protocol)) {
		throw new Error("Unsupported URL protocol");
	}
	if (url.username || url.password) {
		throw new Error("Blocked URL credentials");
	}
	if (isBlockedHostname(url.hostname)) {
		throw new Error("Blocked hostname");
	}
	if (isBlockedIp(url.hostname)) {
		throw new Error("Blocked IP address");
	}
	return url;
};

const fetchPreviewResponse = async (
	url,
	{ maxBytes = LINK_PREVIEW_MAX_BYTES } = {},
) => {
	let currentUrl = url;
	let redirects = 0;
	const shouldFollowRedirect = createRedirectHandler();

	for (;;) {
		validatePreviewTargetUrl(currentUrl);
		const controller = new AbortController();
		const timeout = setTimeout(
			() => controller.abort(),
			LINK_PREVIEW_FETCH_TIMEOUT_MS,
		);
		try {
			const response = await fetch(currentUrl, {
				dispatcher: linkPreviewDispatcher,
				redirect: "manual",
				signal: controller.signal,
				headers: {
					"user-agent": "WA2DC-LinkPreview",
					accept:
						"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
				},
			});

			const status = Number(response.status) || 0;
			if (status >= 300 && status < 400) {
				const locationHeader = response.headers.get("location") || "";
				if (!locationHeader) {
					throw new Error("Redirect without location");
				}
				if (redirects >= LINK_PREVIEW_MAX_REDIRECTS) {
					throw new Error("Too many redirects");
				}
				const forwardedUrl = new URL(locationHeader, currentUrl).toString();
				if (!shouldFollowRedirect(currentUrl, forwardedUrl)) {
					throw new Error("Redirect blocked");
				}
				currentUrl = forwardedUrl;
				redirects += 1;
				continue;
			}

			if (status < 200 || status >= 300) {
				throw new Error(`Unexpected status ${status}`);
			}

			const headers = {};
			response.headers.forEach((value, key) => {
				headers[String(key).toLowerCase()] = value;
			});

			const contentLength = Number(headers["content-length"]);
			if (Number.isFinite(contentLength) && contentLength > maxBytes) {
				const err = new Error("Response too large");
				err.code = "WA2DC_PREVIEW_TOO_LARGE";
				throw err;
			}

			let data = "";
			const contentType = headers["content-type"] || "";
			const treatAsText =
				!contentType ||
				/^text\//i.test(contentType) ||
				/html|xml|json/i.test(contentType);
			if (treatAsText) {
				const buffer = await readBodyWithLimit(response.body, maxBytes);
				data = buffer.toString("utf8");
			}

			return {
				url: currentUrl,
				headers,
				data,
			};
		} catch (err) {
			if (err?.name === "AbortError" || err?.code === "ABORT_ERR") {
				throw new Error("Request timeout");
			}
			throw err;
		} finally {
			clearTimeout(timeout);
		}
	}
};

const fetchPreviewBuffer = async (
	url,
	{
		maxBytes = LINK_PREVIEW_THUMB_MAX_BYTES,
		accept = "image/*,*/*;q=0.8",
	} = {},
) => {
	let currentUrl = url;
	let redirects = 0;

	for (;;) {
		validatePreviewTargetUrl(currentUrl);
		const controller = new AbortController();
		const timeout = setTimeout(
			() => controller.abort(),
			LINK_PREVIEW_FETCH_TIMEOUT_MS,
		);
		try {
			const response = await fetch(currentUrl, {
				dispatcher: linkPreviewDispatcher,
				redirect: "manual",
				signal: controller.signal,
				headers: {
					"user-agent": "WA2DC-LinkPreview",
					accept,
				},
			});

			const status = Number(response.status) || 0;
			if (status >= 300 && status < 400) {
				const locationHeader = response.headers.get("location") || "";
				if (!locationHeader) {
					throw new Error("Redirect without location");
				}
				if (redirects >= LINK_PREVIEW_MAX_REDIRECTS) {
					throw new Error("Too many redirects");
				}
				currentUrl = new URL(locationHeader, currentUrl).toString();
				redirects += 1;
				continue;
			}

			if (status < 200 || status >= 300) {
				throw new Error(`Unexpected status ${status}`);
			}

			const headers = {};
			response.headers.forEach((value, key) => {
				headers[String(key).toLowerCase()] = value;
			});

			const contentLength = Number(headers["content-length"]);
			if (Number.isFinite(contentLength) && contentLength > maxBytes) {
				const err = new Error("Response too large");
				err.code = "WA2DC_PREVIEW_TOO_LARGE";
				throw err;
			}

			const buffer = await readBodyWithLimit(response.body, maxBytes);
			return { url: currentUrl, headers, buffer };
		} catch (err) {
			if (err?.name === "AbortError" || err?.code === "ABORT_ERR") {
				throw new Error("Request timeout");
			}
			throw err;
		} finally {
			clearTimeout(timeout);
		}
	}
};

const isRetryableWebhookTransportError = (err) => {
	const messageText = asLower(
		[err?.message, err?.cause?.message].filter(Boolean).join(" | "),
	);
	const codeText = asLower(
		[err?.code, err?.cause?.code].filter(Boolean).join(" | "),
	);
	const stackText = asLower(
		[err?.stack, err?.cause?.stack].filter(Boolean).join("\n"),
	);
	return (
		includesHint(messageText, RETRYABLE_WEBHOOK_MESSAGE_HINTS) ||
		includesHint(codeText, RETRYABLE_WEBHOOK_CODE_HINTS) ||
		stackText.includes("node:internal/deps/undici/undici") ||
		stackText.includes("/undici/")
	);
};

const isWhatsAppStreamBackedDiscordFile = (file) =>
	Boolean(file?.downloadCtx) && typeof file?.attachment?.pipe === "function";

const resolveWhatsAppDiscordMediaBurstSize = (value) => {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < 1) {
		return DISCORD_MAX_FILES_PER_MESSAGE;
	}
	return Math.min(Math.floor(parsed), DISCORD_MAX_FILES_PER_MESSAGE);
};

const chunkDiscordWebhookFilesForSend = (files = []) => {
	const normalizedFiles = Array.isArray(files) ? files.filter(Boolean) : [];
	if (!normalizedFiles.length) {
		return [];
	}
	const chunkSize = normalizedFiles.some(isWhatsAppStreamBackedDiscordFile)
		? resolveWhatsAppDiscordMediaBurstSize(
				state.settings?.WhatsAppDiscordMediaBurstSize,
			)
		: DISCORD_MAX_FILES_PER_MESSAGE;
	const chunks = [];
	for (let i = 0; i < normalizedFiles.length; i += chunkSize) {
		chunks.push(normalizedFiles.slice(i, i + chunkSize));
	}
	return chunks;
};

const sanitizeFileName = (name = "", fallback = "file") => {
	const normalized = name
		.replace(/[^\w.-]+/g, "-")
		.replace(/-+/g, "-")
		.slice(0, 64);
	return normalized || fallback;
};
const DISCORD_SPOILER_PREFIX = "SPOILER_";
const isWhatsAppViewOnceMessageType = (msgType = "") =>
	[
		"viewOnceMessage",
		"viewOnceMessageV2",
		"viewOnceMessageV2Extension",
	].includes(msgType);
const isWhatsAppViewOnceMediaMessage = (
	rawMsg = {},
	msgType = "",
	msg = {},
) => {
	if (isWhatsAppViewOnceMessageType(msgType)) return true;
	if (msg?.viewOnce === true) return true;
	const typedMessage = rawMsg?.message?.[msgType];
	if (typedMessage?.viewOnce === true) return true;
	return false;
};
const asDiscordSpoilerFileName = (name = "attachment") => {
	const fileName = String(name || "attachment");
	return fileName.toUpperCase().startsWith(DISCORD_SPOILER_PREFIX)
		? fileName
		: `${DISCORD_SPOILER_PREFIX}${fileName}`;
};
const ensureDiscordSpoilerFileName = (file = {}) => {
	if (!file || typeof file !== "object" || file.spoiler !== true) return file;
	const name =
		typeof file.name === "string" && file.name.trim()
			? file.name.trim()
			: typeof file.attachment?.name === "string" && file.attachment.name.trim()
				? file.attachment.name.trim()
				: "attachment";
	const spoilerName = asDiscordSpoilerFileName(name);
	return spoilerName === file.name ? file : { ...file, name: spoilerName };
};

const WINDOWS_RESERVED_BASENAMES = new Set([
	"con",
	"prn",
	"aux",
	"nul",
	...Array.from({ length: 9 }, (_, idx) => `com${idx + 1}`),
	...Array.from({ length: 9 }, (_, idx) => `lpt${idx + 1}`),
]);

const isWindowsReservedBasename = (value = "") =>
	WINDOWS_RESERVED_BASENAMES.has(String(value).toLowerCase());

const sanitizePathSegment = (name = "", fallback = "file") => {
	const raw = String(name)
		.replace(/[\\/]+/g, "-")
		.replace(/\0/g, "")
		.trim();
	const base = path.basename(raw);
	let normalized = base
		.replace(/[^\w.-]+/g, "-")
		.replace(/-+/g, "-")
		.slice(0, 128);
	normalized = normalized.replace(/[. ]+$/g, "");
	const parsed = path.parse(normalized);
	if (parsed.name && isWindowsReservedBasename(parsed.name)) {
		normalized = `_${parsed.name}${parsed.ext}`.slice(0, 128);
	}

	normalized = normalized.replace(/[. ]+$/g, "");
	if (!normalized || normalized === "." || normalized === "..") {
		return fallback;
	}
	return normalized;
};

const guessExtensionFromUrl = (url = "") => {
	const match = url.match(/\.([a-z0-9]+)(?:[?#]|$)/i);
	return match ? match[1].toLowerCase() : null;
};

const extensionToMime = (ext = "") =>
	MIME_BY_EXTENSION[ext] || "application/octet-stream";

const normalizeAttachmentMimeType = (value = "") =>
	typeof value === "string" ? value.split(";")[0].trim().toLowerCase() : "";

const isSupportedGifUrl = (url = "") => GIF_URL_EXTENSION_REGEX.test(url);
const resolveEmbedList = (input = null) => {
	const embeds = Array.isArray(input) ? input : input?.embeds;
	return Array.isArray(embeds) ? embeds : [];
};

const pickEmbedMediaUrl = (embed = {}) => {
	const candidates = [
		embed.video?.url,
		embed.video?.proxyURL,
		embed.video?.proxy_url,
		embed.image?.url,
		embed.image?.proxyURL,
		embed.image?.proxy_url,
		embed.thumbnail?.url,
		embed.thumbnail?.proxyURL,
		embed.thumbnail?.proxy_url,
	].filter(
		(candidate) =>
			typeof candidate === "string" && candidate.startsWith("http"),
	);
	if (!candidates.length) {
		return null;
	}
	const supported = candidates.find((candidate) =>
		isSupportedGifUrl(candidate),
	);
	return supported || candidates[0] || null;
};

const pickEmbedMediaCandidates = (embed = {}) =>
	[
		embed.image?.url,
		embed.image?.proxyURL,
		embed.image?.proxy_url,
		embed.video?.url,
		embed.video?.proxyURL,
		embed.video?.proxy_url,
		embed.thumbnail?.url,
		embed.thumbnail?.proxyURL,
		embed.thumbnail?.proxy_url,
	].filter(
		(candidate) =>
			typeof candidate === "string" && candidate.startsWith("http"),
	);

const buildGifEmbedAttachmentEntry = (embed = {}) => {
	const mediaUrl = pickEmbedMediaUrl(embed);
	if (!mediaUrl) return null;

	const normalizedMediaUrl = normalizeAttachmentUrlForDedupe(mediaUrl);
	const isVideoCandidate = [
		embed.video?.url,
		embed.video?.proxyURL,
		embed.video?.proxy_url,
	]
		.filter(
			(candidate) =>
				typeof candidate === "string" && candidate.startsWith("http"),
		)
		.some(
			(candidate) =>
				normalizeAttachmentUrlForDedupe(candidate) === normalizedMediaUrl,
		);
	const extension = guessExtensionFromUrl(mediaUrl);
	const inferredExtension =
		isSupportedGifUrl(mediaUrl) && extension
			? extension
			: isKnownGifProviderEmbed(embed) && isVideoCandidate
				? "mp4"
				: null;
	if (!inferredExtension) {
		return null;
	}

	const baseName = embed?.title || embed?.provider?.name || "discord-gif";
	const shareCandidate = (embed?.url || "").toLowerCase();
	const providerCandidate = (embed?.provider?.name || "").toLowerCase();
	const shouldConsumeUrl =
		isKnownGifProvider(shareCandidate) || isKnownGifProvider(providerCandidate);
	const contentType = extensionToMime(inferredExtension);
	return {
		attachment: {
			url: mediaUrl,
			name: `${sanitizeFileName(baseName, "discord-gif")}.${inferredExtension}`,
			contentType,
			...(contentType.startsWith("video/") ? { gifPlayback: true } : {}),
		},
		sourceUrl: shouldConsumeUrl ? embed?.url : null,
		shareUrl: typeof embed?.url === "string" ? embed.url : null,
	};
};

const formatEmbedTextBlock = (embed = {}, includeUrls = true) => {
	if (!embed || typeof embed !== "object") return "";
	const lines = [];
	const pushLine = (value) => {
		if (typeof value !== "string") return;
		const trimmed = value.trim();
		if (!trimmed) return;
		lines.push(trimmed);
	};

	pushLine(embed.author?.name);
	pushLine(embed.title);
	pushLine(embed.description);

	const fields = Array.isArray(embed.fields) ? embed.fields : [];
	for (const field of fields) {
		const name = typeof field?.name === "string" ? field.name.trim() : "";
		const value = typeof field?.value === "string" ? field.value.trim() : "";
		if (!name && !value) continue;
		pushLine(name && value ? `${name}: ${value}` : name || value);
	}

	pushLine(embed.footer?.text);
	if (includeUrls) {
		pushLine(embed.url);
	}

	return lines.join("\n").trim();
};

const normalizeAttachmentUrlForDedupe = (value = "") => {
	if (typeof value !== "string") return "";
	const trimmed = value.trim();
	if (!trimmed) return "";
	try {
		const parsed = new URL(trimmed);
		const normalizedHost = normalizeHostname(parsed.hostname);
		if (!["http:", "https:"].includes(parsed.protocol)) {
			return trimmed;
		}

		if (isHostnameEqualOrSubdomain(normalizedHost, "discordapp.net")) {
			const match = parsed.pathname.match(/\/(https|http)\/([^/]+)\/(.+)/);
			if (match) {
				const [, protocol, host, rest] = match;
				return normalizeAttachmentUrlForDedupe(`${protocol}://${host}/${rest}`);
			}
		}
		parsed.search = "";
		parsed.hash = "";
		if (normalizedHost === "media.discordapp.net") {
			parsed.hostname = "cdn.discordapp.com";
		}
		return parsed.toString();
	} catch {
		return trimmed;
	}
};

const normalizeDiscordUploadedMediaKey = (value = "") => {
	if (typeof value !== "string" || !value.trim()) return "";
	try {
		const parsed = new URL(value);
		let host = normalizeHostname(parsed.hostname);
		if (host === "media.discordapp.net") {
			host = "cdn.discordapp.com";
		}
		if (host !== "cdn.discordapp.com") {
			return "";
		}
		const parts = parsed.pathname.split("/").filter(Boolean);
		if (parts[0] !== "attachments" || parts.length < 4) {
			return "";
		}
		const fileName = parts[parts.length - 1] || "";
		const stem = fileName.replace(/\.[^.]+$/u, "").toLowerCase();
		if (!stem) {
			return "";
		}
		return `${host}/${parts.slice(0, -1).join("/")}/${stem}`;
	} catch {
		return "";
	}
};

const isGifLikeAttachment = (attachment = {}) => {
	const contentType = normalizeAttachmentMimeType(
		attachment?.contentType || attachment?.content_type,
	);
	if (contentType === "image/gif") {
		return true;
	}
	const fileName =
		typeof attachment?.name === "string" ? attachment.name.trim() : "";
	if (/\.gif$/iu.test(fileName)) {
		return true;
	}
	return guessExtensionFromUrl(attachment?.url) === "gif";
};

const isVideoLikeAttachment = (attachment = {}) =>
	normalizeAttachmentMimeType(
		attachment?.contentType || attachment?.content_type,
	).startsWith("video/");

const shouldPreferGifEmbedAttachment = (
	attachment = {},
	gifEmbedEntry = {},
) => {
	if (
		!isGifLikeAttachment(attachment) ||
		!isVideoLikeAttachment(gifEmbedEntry?.attachment)
	) {
		return false;
	}
	const attachmentUrl = normalizeAttachmentUrlForDedupe(attachment?.url);
	const embedShareUrl = normalizeAttachmentUrlForDedupe(
		gifEmbedEntry?.shareUrl || gifEmbedEntry?.sourceUrl,
	);
	if (attachmentUrl && embedShareUrl && attachmentUrl === embedShareUrl) {
		return true;
	}
	const attachmentKey = normalizeDiscordUploadedMediaKey(attachment?.url);
	const embedKey = normalizeDiscordUploadedMediaKey(
		gifEmbedEntry?.attachment?.url,
	);
	return Boolean(attachmentKey && embedKey && attachmentKey === embedKey);
};

const getAttachmentDedupeKey = (attachment, fallbackIndex = 0) => {
	const urlKey = normalizeAttachmentUrlForDedupe(attachment?.url);
	const idKey = attachment?.id ? String(attachment.id) : "";
	const nameKey =
		typeof attachment?.name === "string"
			? attachment.name.trim().toLowerCase()
			: "";
	const contentTypeKey =
		typeof attachment?.contentType === "string"
			? attachment.contentType.trim().toLowerCase()
			: "";
	return urlKey
		? `url:${urlKey}`
		: idKey
			? `id:${idKey}`
			: nameKey
				? `name:${nameKey}|type:${contentTypeKey}`
				: `idx:${fallbackIndex}`;
};

const createAttachmentAccumulator = (initialAttachments = []) => {
	const seen = new Set();
	const attachments = [];
	const push = (attachment) => {
		const key = getAttachmentDedupeKey(attachment, attachments.length);
		if (seen.has(key)) return false;
		seen.add(key);
		attachments.push(attachment);
		return true;
	};
	const append = (attachmentList = []) => {
		if (!Array.isArray(attachmentList)) return;
		for (const attachment of attachmentList) {
			push(attachment);
		}
	};
	append(initialAttachments);
	return {
		append,
		push,
		toArray: () => [...attachments],
	};
};

const dedupeAttachments = (attachments = []) =>
	createAttachmentAccumulator(attachments).toArray();

const stripUrlDelimiters = (value = "") => value.replace(/^<+|>+$/g, "");
const stripTrailingPunctuation = (value = "") =>
	value.replace(TRAILING_PUNCTUATION_REGEX, "");

const extractUrlCandidate = (text = "") => {
	if (!text) {
		return null;
	}
	const explicitMatch = text.match(EXPLICIT_URL_REGEX);
	if (explicitMatch) {
		return stripTrailingPunctuation(stripUrlDelimiters(explicitMatch[0]));
	}
	const bareMatch = text.match(BARE_URL_REGEX);
	if (bareMatch) {
		return stripTrailingPunctuation(bareMatch[1] || "");
	}
	return null;
};

const replaceFirstInstance = (text, search, replacement) => {
	if (!text || !search) {
		return text;
	}
	const index = text.indexOf(search);
	if (index === -1) {
		return text;
	}
	return `${text.slice(0, index)}${replacement}${text.slice(index + search.length)}`;
};

const normalizePreviewUrl = (value = "") => {
	const trimmed = stripTrailingPunctuation(stripUrlDelimiters(value).trim());
	if (!trimmed) {
		return null;
	}
	const hasScheme = /^[a-z]+:/i.test(trimmed);
	const candidate = hasScheme ? trimmed : `https://${trimmed}`;
	try {
		const url = new URL(candidate);
		if (!["http:", "https:"].includes(url.protocol)) {
			return null;
		}
		return url.toString();
	} catch {
		return null;
	}
};

const hostWithoutWww = (hostname = "") => hostname.replace(/^www\./, "");

const createRedirectHandler = () => {
	let redirects = 0;
	return (baseURL, forwardedURL) => {
		if (redirects >= LINK_PREVIEW_MAX_REDIRECTS) {
			return false;
		}
		try {
			const baseHost = hostWithoutWww(new URL(baseURL).hostname || "");
			const forwardedHost = hostWithoutWww(
				new URL(forwardedURL).hostname || "",
			);
			if (baseHost && forwardedHost && baseHost === forwardedHost) {
				redirects += 1;
				return true;
			}
		} catch (err) {
			void err;
		}
		return false;
	};
};

const buildHighQualityThumbnail = async (
	imageUrl,
	uploadImage,
	fetchOpts = {},
) => {
	if (typeof uploadImage !== "function" || !imageUrl) {
		return {};
	}
	const safeToFetch = await isSafeUrlForPreviewFetch(imageUrl).catch(
		() => false,
	);
	if (!safeToFetch) {
		state.logger?.warn(
			{ imageUrl },
			"Blocked link preview thumbnail fetch (SSRF protection)",
		);
		return {};
	}
	try {
		const { buffer } = await fetchPreviewBuffer(imageUrl, {
			maxBytes: LINK_PREVIEW_THUMB_MAX_BYTES,
			accept: "image/*,*/*;q=0.8",
		});

		let jpegThumbnail;
		try {
			const sharp = await getImageSharp();
			if (sharp) {
				jpegThumbnail = await sharp(buffer, { animated: true })
					.resize({ width: 192, fit: "inside", withoutEnlargement: true })
					.jpeg({ quality: 50 })
					.toBuffer();
			}
		} catch (err) {
			state.logger?.debug?.(
				{ err },
				"Failed to generate link preview jpegThumbnail",
			);
		}

		const { imageMessage } = await prepareWAMessageMedia(
			{ image: buffer },
			{
				upload: uploadImage,
				mediaTypeOverride: "thumbnail-link",
				options: fetchOpts,
			},
		);
		if (!imageMessage) {
			return {};
		}
		if (!jpegThumbnail && imageMessage.jpegThumbnail) {
			jpegThumbnail = Buffer.from(imageMessage.jpegThumbnail);
		}
		return {
			jpegThumbnail,
			highQualityThumbnail: imageMessage,
		};
	} catch (err) {
		state.logger?.warn(
			{ err, imageUrl },
			"Failed to upload high quality thumbnail for preview",
		);
		return {};
	}
};

const buildLinkPreviewInfo = async (text, { uploadImage, logger } = {}) => {
	const matchedText = extractUrlCandidate(text);
	if (!matchedText || !getPreviewFromContentFn) {
		return undefined;
	}
	const normalizedUrl = normalizePreviewUrl(matchedText);
	if (!normalizedUrl) {
		return undefined;
	}

	let preview;
	try {
		const response = await fetchPreviewResponse(normalizedUrl);
		preview = await getPreviewFromContentFn(response, {});
	} catch (err) {
		if (!err?.message?.includes("receive a valid response")) {
			logger?.warn({ err, url: normalizedUrl }, "Failed to fetch link preview");
		}
		return undefined;
	}

	if (!preview) {
		return undefined;
	}

	const urlInfo = {
		"canonical-url": preview.url || normalizedUrl,
		"matched-text": matchedText,
	};

	if (preview.title) {
		urlInfo.title = preview.title;
	}
	if (preview.description) {
		urlInfo.description = preview.description;
	}

	const images = Array.isArray(preview.images) ? preview.images : [];
	const firstImage = images.find((imageUrl) => {
		if (typeof imageUrl !== "string" || !imageUrl.startsWith("http"))
			return false;
		try {
			const url = new URL(imageUrl);
			if (!["http:", "https:"].includes(url.protocol)) return false;
			if (isBlockedHostname(url.hostname)) return false;
			if (isBlockedIp(url.hostname)) return false;
			return true;
		} catch {
			return false;
		}
	});
	if (firstImage) {
		urlInfo.originalThumbnailUrl = firstImage;
		if (typeof uploadImage === "function") {
			const { jpegThumbnail, highQualityThumbnail } =
				await buildHighQualityThumbnail(
					firstImage,
					uploadImage,
					LINK_PREVIEW_FETCH_OPTS,
				);
			if (jpegThumbnail) {
				urlInfo.jpegThumbnail = jpegThumbnail;
			}
			if (highQualityThumbnail) {
				urlInfo.highQualityThumbnail = highQualityThumbnail;
			}
		}
	}

	return urlInfo;
};

function ensureWebhookReplySupport(webhook) {
	if (!webhook) return webhook;
	if (webhook.messages && typeof webhook.messages.resolveId === "function") {
		return webhook;
	}

	const cloneArray = (value) => (Array.isArray(value) ? [...value] : value);
	webhook.messages = {
		resolveId(reference) {
			if (!reference) return null;
			if (typeof reference === "string" || typeof reference === "number") {
				return String(reference);
			}
			if (typeof reference === "object") {
				if ("id" in reference && reference.id) {
					return String(reference.id);
				}
				if ("message_id" in reference && reference.message_id) {
					return String(reference.message_id);
				}
				if ("messageId" in reference && reference.messageId) {
					return String(reference.messageId);
				}
				if ("message" in reference && reference.message?.id) {
					return String(reference.message.id);
				}
			}
			return null;
		},
	};

	if (webhook.client?.options) {
		const { allowedMentions } = webhook.client.options;
		if (allowedMentions) {
			webhook._wa2dcAllowedMentions = {
				...allowedMentions,
				parse: cloneArray(allowedMentions.parse),
				roles: cloneArray(allowedMentions.roles),
				users: cloneArray(allowedMentions.users),
			};
		}
	}

	return webhook;
}

function ensureDownloadServer() {
	if (!state.settings.LocalDownloadServer || ensureDownloadServer.server)
		return;

	const bindHost = state.settings.LocalDownloadServerBindHost || "0.0.0.0";

	const handler = (req, res) => {
		void (async () => {
			res.setHeader("Cache-Control", "private, no-store, max-age=0");
			res.setHeader("X-Content-Type-Options", "nosniff");

			if (req.method !== "GET" && req.method !== "HEAD") {
				res.writeHead(405, { Allow: "GET, HEAD" });
				res.end("Method not allowed");
				return;
			}

			const requestUrl = new URL(req.url, "http://localhost");
			const segments = requestUrl.pathname.split("/").filter(Boolean);
			const token = segments[0] || "";
			const verification = verifyDownloadToken(token);
			if (!verification || verification.expired) {
				res.writeHead(404);
				res.end("Not found");
				return;
			}
			const resolvedDownloadDir = path.resolve(state.settings.DownloadDir);
			const fileName = sanitizePathSegment(verification.f, "file");
			const filePath = path.resolve(resolvedDownloadDir, fileName);
			const relative = path.relative(resolvedDownloadDir, filePath);
			if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
				res.writeHead(404);
				res.end("Not found");
				return;
			}
			let stat;
			try {
				stat = await fs.promises.stat(filePath);
			} catch {
				res.writeHead(404);
				res.end("Not found");
				return;
			}
			if (!stat.isFile()) {
				res.writeHead(404);
				res.end("Not found");
				return;
			}

			const ext = path.extname(fileName).replace(/^\./, "").toLowerCase();
			const mime = extensionToMime(ext);
			res.setHeader("Content-Type", mime);
			res.setHeader(
				"Content-Disposition",
				`attachment; filename="${fileName}"`,
			);
			res.setHeader("Accept-Ranges", "bytes");

			const totalSize = stat.size;
			const rangeHeader =
				typeof req.headers.range === "string" ? req.headers.range : "";
			const rangeMatch = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
			const wantsRange = Boolean(rangeHeader);
			if (wantsRange && !rangeMatch) {
				res.writeHead(416, { "Content-Range": `bytes */${totalSize}` });
				res.end();
				return;
			}

			let start = 0;
			let end = totalSize - 1;
			let status = 200;

			if (rangeMatch) {
				const startRaw = rangeMatch[1];
				const endRaw = rangeMatch[2];
				const startNum = startRaw ? Number.parseInt(startRaw, 10) : null;
				const endNum = endRaw ? Number.parseInt(endRaw, 10) : null;

				if (startNum == null && endNum == null) {
					res.writeHead(416, { "Content-Range": `bytes */${totalSize}` });
					res.end();
					return;
				}

				if (startNum == null) {
					const suffixLength = endNum;
					if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
						res.writeHead(416, { "Content-Range": `bytes */${totalSize}` });
						res.end();
						return;
					}
					start = Math.max(totalSize - suffixLength, 0);
					end = totalSize - 1;
				} else {
					start = startNum;
					end = endNum == null ? totalSize - 1 : endNum;
					if (end >= totalSize) {
						end = totalSize - 1;
					}
				}

				if (
					!Number.isFinite(start) ||
					!Number.isFinite(end) ||
					start < 0 ||
					start >= totalSize ||
					end < start
				) {
					res.writeHead(416, { "Content-Range": `bytes */${totalSize}` });
					res.end();
					return;
				}

				status = 206;
				res.setHeader("Content-Range", `bytes ${start}-${end}/${totalSize}`);
			}

			const contentLength = end - start + 1;
			res.setHeader("Content-Length", String(contentLength));
			res.writeHead(status);
			if (req.method === "HEAD") {
				res.end();
				return;
			}

			const stream = fs.createReadStream(
				filePath,
				status === 206 ? { start, end } : undefined,
			);
			stream.on("error", () => {
				res.destroy();
			});
			stream.pipe(res);
		})().catch(() => {
			res.writeHead(500);
			res.end("Error");
		});
	};

	const handleServerError = (err) => {
		state.logger?.error(err);
		ensureDownloadServer.server = null;
	};

	try {
		const shouldUseHttps =
			state.settings.UseHttps &&
			state.settings.HttpsKeyPath &&
			state.settings.HttpsCertPath &&
			fs.existsSync(state.settings.HttpsKeyPath) &&
			fs.existsSync(state.settings.HttpsCertPath);

		if (shouldUseHttps) {
			const options = {
				key: fs.readFileSync(state.settings.HttpsKeyPath),
				cert: fs.readFileSync(state.settings.HttpsCertPath),
			};
			ensureDownloadServer.server = https.createServer(options, handler);
			ensureDownloadServer.protocol = "https";
		} else {
			ensureDownloadServer.server = http.createServer(handler);
			ensureDownloadServer.protocol = "http";
		}

		ensureDownloadServer.server.on("error", handleServerError);
		ensureDownloadServer.server.listen(
			state.settings.LocalDownloadServerPort,
			bindHost,
		);
	} catch (err) {
		handleServerError(err);
	}
}

function stopDownloadServer() {
	if (ensureDownloadServer.server) {
		ensureDownloadServer.server.close();
		ensureDownloadServer.server = null;
		ensureDownloadServer.protocol = null;
	}
}

const parseVersionTag = (tag = "") => {
	const normalized = String(tag).trim().replace(/^v/i, "");
	const match = normalized.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
	if (!match) return null;
	const prerelease = match[4]
		? match[4]
				.split(".")
				.filter(Boolean)
				.map((identifier) =>
					/^\d+$/.test(identifier) ? Number(identifier) : identifier,
				)
		: [];
	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
		prerelease,
	};
};

const comparePrereleaseIdentifiers = (aIdentifiers = [], bIdentifiers = []) => {
	const a = Array.isArray(aIdentifiers) ? aIdentifiers : [];
	const b = Array.isArray(bIdentifiers) ? bIdentifiers : [];
	const maxLen = Math.max(a.length, b.length);
	for (let index = 0; index < maxLen; index += 1) {
		const left = a[index];
		const right = b[index];
		if (typeof left === "undefined" && typeof right === "undefined") return 0;
		if (typeof left === "undefined") return -1;
		if (typeof right === "undefined") return 1;
		if (left === right) continue;

		const leftIsNumber = typeof left === "number";
		const rightIsNumber = typeof right === "number";
		if (leftIsNumber && rightIsNumber) {
			return left > right ? 1 : -1;
		}
		if (leftIsNumber) return -1;
		if (rightIsNumber) return 1;
		const lexical = String(left).localeCompare(String(right));
		if (lexical !== 0) return lexical > 0 ? 1 : -1;
	}
	return 0;
};

const compareVersionTags = (leftTag = "", rightTag = "") => {
	const left = parseVersionTag(leftTag);
	const right = parseVersionTag(rightTag);
	if (!left || !right) return 0;

	if (left.major !== right.major) return left.major > right.major ? 1 : -1;
	if (left.minor !== right.minor) return left.minor > right.minor ? 1 : -1;
	if (left.patch !== right.patch) return left.patch > right.patch ? 1 : -1;

	const leftHasPrerelease = left.prerelease.length > 0;
	const rightHasPrerelease = right.prerelease.length > 0;
	if (!leftHasPrerelease && rightHasPrerelease) return 1;
	if (leftHasPrerelease && !rightHasPrerelease) return -1;
	if (!leftHasPrerelease && !rightHasPrerelease) return 0;
	return comparePrereleaseIdentifiers(left.prerelease, right.prerelease);
};

const releaseSortTimestamp = (release = {}) => {
	const published = Date.parse(release.published_at || "");
	if (Number.isFinite(published)) return published;
	const created = Date.parse(release.created_at || "");
	return Number.isFinite(created) ? created : 0;
};

const compareReleases = (leftRelease = {}, rightRelease = {}) => {
	const versionOrder = compareVersionTags(
		leftRelease.tag_name,
		rightRelease.tag_name,
	);
	if (versionOrder !== 0) return versionOrder;
	return releaseSortTimestamp(leftRelease) - releaseSortTimestamp(rightRelease);
};

const movePathWithCrossDeviceFallback = async (from, to) => {
	try {
		await fs.promises.rename(from, to);
		return;
	} catch (err) {
		if (err?.code !== "EXDEV") {
			throw err;
		}
	}

	await fs.promises.cp(from, to, { recursive: true });
	await fs.promises.rm(from, { recursive: true, force: true });
};

const updater = {
	isNode: process.argv0.replace(".exe", "").endsWith("node"),

	currentExeName: process.argv0.split(/[/\\]/).pop(),

	get supportsSignedSelfUpdate() {
		return true;
	},

	getCurrentExecutablePath() {
		if (typeof process.execPath === "string" && process.execPath) {
			return process.execPath;
		}
		return path.resolve(this.currentExeName);
	},

	getRuntimeSidecarPath() {
		return path.join(path.dirname(this.getCurrentExecutablePath()), "runtime");
	},

	getRuntimeArchiveName(defaultExeName) {
		return `${defaultExeName}.runtime.tar.gz`;
	},

	getPackagedRuntimeRequire() {
		if (!process.pkg) {
			return null;
		}
		return createRequire(
			path.join(this.getRuntimeSidecarPath(), "package.json"),
		);
	},

	isRuntimeSidecarUsable() {
		if (!process.pkg) {
			return true;
		}
		try {
			fs.accessSync(
				path.join(this.getRuntimeSidecarPath(), "package.json"),
				fs.constants.F_OK,
			);
			const runtimeRequire = this.getPackagedRuntimeRequire();
			const sharpFromSidecar = runtimeRequire?.("sharp");
			const sharp = sharpFromSidecar?.default || sharpFromSidecar || null;
			return typeof sharp === "function";
		} catch {
			return false;
		}
	},

	get channel() {
		const envChannel = process.env.WA2DC_UPDATE_CHANNEL?.toLowerCase();
		const configuredChannel = (
			state.settings?.UpdateChannel || ""
		).toLowerCase();
		const channel = configuredChannel || envChannel;
		return channel === "unstable" ? "unstable" : "stable";
	},

	async renameOldVersion() {
		const currentPath = this.getCurrentExecutablePath();
		const backupPath = `${currentPath}.oldVersion`;

		try {
			await fs.promises.access(currentPath, fs.constants.F_OK);
		} catch (err) {
			if (err.code === "ENOENT") {
				return false;
			}
			throw err;
		}

		try {
			await fs.promises.rm(backupPath, { force: true });
		} catch (err) {
			if (err.code !== "ENOENT") {
				state.logger?.warn(
					{ err },
					"Failed to remove previous backup before update.",
				);
			}
		}

		await fs.promises.rename(currentPath, backupPath);
		return true;
	},

	async backupRuntimeSidecar() {
		const runtimePath = this.getRuntimeSidecarPath();
		const backupPath = `${runtimePath}.oldVersion`;

		try {
			await fs.promises.access(runtimePath, fs.constants.F_OK);
		} catch (err) {
			if (err.code === "ENOENT") {
				return false;
			}
			throw err;
		}

		try {
			await fs.promises.rm(backupPath, { recursive: true, force: true });
		} catch (err) {
			if (err.code !== "ENOENT") {
				state.logger?.warn(
					{ err },
					"Failed to remove previous runtime backup before update.",
				);
			}
		}

		await fs.promises.rename(runtimePath, backupPath);
		return true;
	},

	cleanOldVersion() {
		if (
			process.env.WA2DC_KEEP_OLD_BINARY === "1" ||
			state.settings?.KeepOldBinary
		) {
			return;
		}
		const candidates = [
			`${this.getCurrentExecutablePath()}.oldVersion`,
			`${this.getRuntimeSidecarPath()}.oldVersion`,
		];
		for (const candidate of candidates) {
			fs.rm(candidate, { recursive: true, force: true }, () => 0);
		}
	},

	async revertChanges() {
		const currentPath = this.getCurrentExecutablePath();
		const backupPath = `${currentPath}.oldVersion`;
		const runtimePath = this.getRuntimeSidecarPath();
		const runtimeBackupPath = `${runtimePath}.oldVersion`;

		try {
			await fs.promises.access(runtimeBackupPath, fs.constants.F_OK);
			try {
				await fs.promises.rm(runtimePath, { recursive: true, force: true });
			} catch (err) {
				if (err.code !== "ENOENT") {
					state.logger?.error(
						{ err },
						"Failed to remove partially updated runtime sidecar.",
					);
					throw err;
				}
			}
			await fs.promises.rename(runtimeBackupPath, runtimePath);
		} catch (err) {
			if (err.code !== "ENOENT") {
				state.logger?.error(
					{ err },
					"Failed to restore original runtime sidecar after update failure.",
				);
				throw err;
			}
			try {
				await fs.promises.rm(runtimePath, { recursive: true, force: true });
			} catch (runtimeErr) {
				if (runtimeErr.code !== "ENOENT") {
					state.logger?.error(
						{ err: runtimeErr },
						"Failed to clean partially installed runtime sidecar after update failure.",
					);
					throw runtimeErr;
				}
			}
		}

		try {
			await fs.promises.access(backupPath, fs.constants.F_OK);
		} catch (err) {
			if (err.code === "ENOENT") {
				return;
			}
			throw err;
		}

		try {
			await fs.promises.rm(currentPath, { force: true });
		} catch (err) {
			if (err.code !== "ENOENT") {
				state.logger?.error(
					{ err },
					"Failed to remove partially downloaded update.",
				);
				throw err;
			}
		}

		try {
			await fs.promises.rename(backupPath, currentPath);
		} catch (err) {
			state.logger?.error(
				{ err },
				"Failed to restore original executable after update failure.",
			);
			throw err;
		}
	},

	async fetchLatestVersion(channel = this.channel) {
		const response = await requests.fetchJson(
			"https://api.github.com/repos/arespawn/WhatsAppToDiscord/releases?per_page=20",
		);
		if ("error" in response) {
			state.logger.error(response.error);
			return null;
		}

		const releases = Array.isArray(response.result)
			? response.result.filter((release) => !release.draft)
			: [];

		if (!releases.length) {
			state.logger.error("No releases found when checking for updates.");
			return null;
		}

		const sortedReleases = [...releases].sort((left, right) =>
			compareReleases(right, left),
		);
		const sortedByTimestamp = [...releases].sort(
			(left, right) => releaseSortTimestamp(right) - releaseSortTimestamp(left),
		);

		let release;
		if (channel === "unstable") {
			release =
				sortedByTimestamp.find((rel) => rel.prerelease) ||
				sortedReleases.find((rel) => !rel.prerelease);
		} else {
			release =
				sortedReleases.find((rel) => !rel.prerelease) || sortedReleases[0];
		}

		if (!release || !release.tag_name) {
			state.logger.error("Tag name wasn't in result");
			return null;
		}

		return {
			version: release.tag_name,
			changes: release.body || "No changelog provided.",
			url: release.html_url,
			prerelease: Boolean(release.prerelease),
			channel,
		};
	},

	get defaultExeName() {
		let name = "WA2DC";
		switch (os.platform()) {
			case "linux":
				name += "-Linux";
				break;
			case "darwin":
				name += "-macOS";
				break;
			case "win32":
				break;
			default:
				return "";
		}

		switch (process.arch) {
			case "arm64":
				name += "-arm64";
				break;
			case "x64":
				break;
			default:
				return "";
		}

		if (os.platform() === "win32") {
			name += ".exe";
		}

		return name;
	},

	buildDownloadUrl(versionTag, name) {
		if (!versionTag || versionTag === "latest") {
			return `https://github.com/arespawn/WhatsAppToDiscord/releases/latest/download/${name}`;
		}
		return `https://github.com/arespawn/WhatsAppToDiscord/releases/download/${versionTag}/${name}`;
	},

	async downloadLatestVersion(defaultExeName, targetPath, versionTag) {
		return requests.downloadFile(
			targetPath,
			this.buildDownloadUrl(versionTag, defaultExeName),
		);
	},

	async downloadSignature(defaultExeName, versionTag) {
		const signature = await requests.fetchBuffer(
			this.buildDownloadUrl(versionTag, `${defaultExeName}.sig`),
		);
		if ("error" in signature) {
			state.logger?.error("Couldn't fetch the signature of the update.");
			return false;
		}
		return signature;
	},

	async downloadRuntimeArchive(defaultExeName, targetPath, versionTag) {
		return requests.downloadFile(
			targetPath,
			this.buildDownloadUrl(
				versionTag,
				this.getRuntimeArchiveName(defaultExeName),
			),
		);
	},

	async downloadRuntimeArchiveSignature(defaultExeName, versionTag) {
		const archiveName = this.getRuntimeArchiveName(defaultExeName);
		const signature = await requests.fetchBuffer(
			this.buildDownloadUrl(versionTag, `${archiveName}.sig`),
		);
		if ("error" in signature) {
			state.logger?.error(
				"Couldn't fetch the signature of the runtime sidecar update.",
			);
			return false;
		}
		return signature;
	},

	async installRuntimeArchive(archivePath) {
		const runtimePath = this.getRuntimeSidecarPath();
		const tempRoot = await fs.promises.mkdtemp(
			path.join(os.tmpdir(), "wa2dc-runtime-install-"),
		);
		try {
			await tar.extract({
				cwd: tempRoot,
				file: archivePath,
				strict: true,
			});
			const extractedRuntimePath = path.join(tempRoot, "runtime");
			await fs.promises.access(
				path.join(extractedRuntimePath, "package.json"),
				fs.constants.F_OK,
			);
			await fs.promises.mkdir(path.dirname(runtimePath), { recursive: true });
			await fs.promises.rm(runtimePath, { recursive: true, force: true });
			await movePathWithCrossDeviceFallback(extractedRuntimePath, runtimePath);
		} finally {
			await fs.promises.rm(tempRoot, { recursive: true, force: true });
		}
	},

	async restoreRuntimeSidecarBackup() {
		const runtimePath = this.getRuntimeSidecarPath();
		const backupPath = `${runtimePath}.oldVersion`;
		try {
			await fs.promises.access(backupPath, fs.constants.F_OK);
		} catch (err) {
			if (err.code === "ENOENT") {
				await fs.promises.rm(runtimePath, {
					recursive: true,
					force: true,
				});
				return false;
			}
			throw err;
		}

		await fs.promises.rm(runtimePath, { recursive: true, force: true });
		await fs.promises.rename(backupPath, runtimePath);
		return true;
	},

	async ensureRuntimeSidecar(versionTag = state.version) {
		if (!process.pkg) {
			return true;
		}
		if (this.isRuntimeSidecarUsable()) {
			return true;
		}

		const normalizedVersion =
			typeof versionTag === "string" && versionTag.trim()
				? versionTag.trim()
				: null;
		const defaultExeName = this.defaultExeName;
		if (!normalizedVersion || !defaultExeName) {
			state.logger?.warn?.(
				{
					versionTag: normalizedVersion,
					defaultExeName,
				},
				"Packaged runtime sidecar is unavailable and could not be bootstrapped automatically.",
			);
			return false;
		}

		state.logger?.warn?.(
			{
				versionTag: normalizedVersion,
				runtimePath: this.getRuntimeSidecarPath(),
			},
			"Packaged runtime sidecar missing or unusable; attempting signed bootstrap.",
		);

		let backedUp = false;
		try {
			backedUp = await this.backupRuntimeSidecar();
		} catch (err) {
			state.logger?.warn?.(
				{ err },
				"Failed to prepare packaged runtime sidecar backup before bootstrap.",
			);
			return false;
		}

		const runtimeArchiveName = this.getRuntimeArchiveName(defaultExeName);
		const runtimeArchivePath = path.join(os.tmpdir(), runtimeArchiveName);
		try {
			await fs.promises.rm(runtimeArchivePath, { force: true });
			const runtimeDownloadStatus = await this.downloadRuntimeArchive(
				defaultExeName,
				runtimeArchivePath,
				normalizedVersion,
			);
			if (!runtimeDownloadStatus) {
				throw new Error("runtime_archive_download_failed");
			}
			const runtimeSignature = await this.downloadRuntimeArchiveSignature(
				defaultExeName,
				normalizedVersion,
			);
			if (!runtimeSignature) {
				throw new Error("runtime_archive_signature_missing");
			}
			if (
				!this.validateSignature(runtimeSignature.result, runtimeArchivePath)
			) {
				throw new Error("runtime_archive_signature_invalid");
			}

			await this.installRuntimeArchive(runtimeArchivePath);
			if (!this.isRuntimeSidecarUsable()) {
				throw new Error("runtime_sidecar_unusable_after_install");
			}
			if (
				process.env.WA2DC_KEEP_OLD_BINARY !== "1" &&
				!state.settings?.KeepOldBinary
			) {
				await fs.promises
					.rm(`${this.getRuntimeSidecarPath()}.oldVersion`, {
						recursive: true,
						force: true,
					})
					.catch(() => {});
			}
			state.logger?.info?.(
				{
					versionTag: normalizedVersion,
					runtimePath: this.getRuntimeSidecarPath(),
				},
				"Bootstrapped packaged runtime sidecar from signed release asset.",
			);
			return true;
		} catch (err) {
			state.logger?.warn?.(
				{ err, versionTag: normalizedVersion },
				"Failed to bootstrap packaged runtime sidecar automatically.",
			);
			try {
				if (backedUp) {
					await this.restoreRuntimeSidecarBackup();
				} else {
					await fs.promises.rm(this.getRuntimeSidecarPath(), {
						recursive: true,
						force: true,
					});
				}
			} catch (restoreErr) {
				state.logger?.warn?.(
					{ err: restoreErr },
					"Failed to restore packaged runtime sidecar after bootstrap failure.",
				);
			}
			return false;
		} finally {
			await fs.promises.rm(runtimeArchivePath, { force: true }).catch(() => {});
		}
	},

	validateSignature(signature, name) {
		return crypto.verify(
			"RSA-SHA256",
			fs.readFileSync(name),
			this.publicKey,
			signature,
		);
	},

	async update(targetVersion = state.updateInfo?.version) {
		if (this.isNode) {
			state.logger?.info(
				"Self-update is only available for packaged binaries.",
			);
			return false;
		}
		if (!this.supportsSignedSelfUpdate) {
			state.logger?.info(
				"Self-update is disabled on this platform (missing signed release artifacts).",
			);
			return false;
		}

		const currExePath = this.getCurrentExecutablePath();
		const defaultExeName = this.defaultExeName;
		if (!defaultExeName) {
			state.logger?.info(
				`Auto-update is not supported on this platform: ${os.platform()}`,
			);
			return false;
		}

		try {
			await this.renameOldVersion();
			await this.backupRuntimeSidecar();
		} catch (err) {
			state.logger?.error(
				{ err },
				"Failed to prepare current packaged install for update.",
			);
			await this.revertChanges();
			return false;
		}

		let downloadStatus;
		try {
			downloadStatus = await this.downloadLatestVersion(
				defaultExeName,
				currExePath,
				targetVersion,
			);
		} catch (err) {
			state.logger?.error({ err }, "Download failed! Skipping update.");
			await this.revertChanges();
			return false;
		}

		if (!downloadStatus) {
			state.logger?.error("Download failed! Skipping update.");
			await this.revertChanges();
			return false;
		}
		if (os.platform() !== "win32") {
			try {
				await fs.promises.chmod(currExePath, 0o755);
			} catch (err) {
				state.logger?.error(
					{ err },
					"Failed to mark the updated binary as executable.",
				);
				await this.revertChanges();
				return false;
			}
		}

		const signature = await this.downloadSignature(
			defaultExeName,
			targetVersion,
		);
		if (!signature) {
			state.logger?.error(
				"Missing signature for the requested update. Reverting back.",
			);
			await this.revertChanges();
			return false;
		}
		if (!this.validateSignature(signature.result, currExePath)) {
			state.logger?.error(
				"Couldn't verify the signature of the updated binary, reverting back. Please update manually.",
			);
			await this.revertChanges();
			return false;
		}

		const runtimeArchiveName = this.getRuntimeArchiveName(defaultExeName);
		const runtimeArchivePath = path.join(os.tmpdir(), runtimeArchiveName);
		try {
			await fs.promises.rm(runtimeArchivePath, { force: true });
			const runtimeDownloadStatus = await this.downloadRuntimeArchive(
				defaultExeName,
				runtimeArchivePath,
				targetVersion,
			);
			if (!runtimeDownloadStatus) {
				state.logger?.error(
					"Download failed for the packaged runtime sidecar. Reverting back.",
				);
				await this.revertChanges();
				return false;
			}

			const runtimeSignature = await this.downloadRuntimeArchiveSignature(
				defaultExeName,
				targetVersion,
			);
			if (!runtimeSignature) {
				state.logger?.error(
					"Missing signature for the packaged runtime sidecar update. Reverting back.",
				);
				await this.revertChanges();
				return false;
			}
			if (
				!this.validateSignature(runtimeSignature.result, runtimeArchivePath)
			) {
				state.logger?.error(
					"Couldn't verify the signature of the packaged runtime sidecar update, reverting back. Please update manually.",
				);
				await this.revertChanges();
				return false;
			}

			await this.installRuntimeArchive(runtimeArchivePath);
		} catch (err) {
			state.logger?.error(
				{ err },
				"Failed to install the packaged runtime sidecar update. Reverting back.",
			);
			await this.revertChanges();
			return false;
		} finally {
			await fs.promises.rm(runtimeArchivePath, { force: true }).catch(() => {});
		}
		this.cleanOldVersion();
		return true;
	},

	async hasBackup() {
		const candidates = [`${this.getCurrentExecutablePath()}.oldVersion`];
		for (const backupPath of candidates) {
			try {
				await fs.promises.access(backupPath, fs.constants.F_OK);
				return true;
			} catch (err) {
				void err;
			}
		}
		return false;
	},

	async rollback() {
		if (this.isNode) {
			return { success: false, reason: "node" };
		}

		const hasBackup = await this.hasBackup();
		if (!hasBackup) {
			return { success: false, reason: "no-backup" };
		}

		try {
			await this.revertChanges();
			return { success: true };
		} catch (err) {
			state.logger?.error({ err }, "Rollback failed.");
			return { success: false, reason: "error" };
		}
	},

	async run(currVer, { prompt = process.stdin.isTTY } = {}) {
		if (
			process.argv.some((arg) => ["--skip-update", "-su"].includes(arg)) ||
			process.env.WA2DC_SKIP_UPDATE === "1"
		) {
			state.logger?.info("Skipping update due to configuration.");
			state.updateInfo = null;
			return;
		}

		const channel = this.channel;
		const canSelfUpdate = !this.isNode && this.supportsSignedSelfUpdate;

		this.cleanOldVersion();
		const newVer = await this.fetchLatestVersion(channel);
		if (newVer === null) {
			state.logger?.error("Something went wrong with auto-update.");
			state.updateInfo = null;
			return;
		}

		if (newVer.version === currVer) {
			state.updateInfo = null;
			return;
		}

		state.updateInfo = { currVer, ...newVer, canSelfUpdate };

		if (!prompt || !canSelfUpdate) {
			return;
		}

		const answer = (
			await ui.input(
				`A new ${channel} version is available ${currVer} -> ${newVer.version}. Changelog: ${newVer.changes}\nDo you want to update? (Y/N) `,
			)
		).toLowerCase();
		if (answer !== "y") {
			state.logger?.info("Skipping update.");
			return;
		}

		state.logger?.info("Please wait as the bot downloads the new version.");
		const exeName = await updater.update(newVer.version);
		if (exeName) {
			await ui.input(
				`Updated WA2DC. Hit enter to exit and run ${this.currentExeName}.`,
			);
			process.exit();
		}
	},

	formatUpdateMessage(updateInfo) {
		if (!updateInfo) {
			return "";
		}

		const maxLength = 2000;
		const channel = updateInfo.channel || "stable";
		const header = `A new ${channel} version is available ${updateInfo.currVer} -> ${updateInfo.version}.`;
		const urlLine = updateInfo.url ? `See ${updateInfo.url}` : null;
		const footer = updateInfo.canSelfUpdate
			? "Use /update or the buttons below to install, or /skipupdate to ignore."
			: "This instance cannot self-update (Docker/source install). Pull the new image or binary for this release and restart. Use Skip Update to dismiss this reminder.";

		const rawChanges =
			typeof updateInfo.changes === "string"
				? updateInfo.changes
				: String(updateInfo.changes ?? "");
		const changes =
			(rawChanges || "No changelog provided.")
				.replace(/\r\n/g, "\n")
				.replace(/\r/g, "")
				.trim() || "No changelog provided.";

		const prefixLines = [header, urlLine].filter(Boolean);
		const prefix = `${prefixLines.join("\n")}\nChangelog: `;
		const suffix = `\n${footer}`;
		const available = maxLength - prefix.length - suffix.length;

		if (available <= 0) {
			return prefixLines.concat(footer).join("\n").slice(0, maxLength);
		}

		let snippet = changes;
		if (snippet.length > available) {
			const ellipsis = "...";
			if (available <= ellipsis.length) {
				snippet = snippet.slice(0, available);
			} else {
				const sliceLength = available - ellipsis.length;
				snippet = `${snippet.slice(0, sliceLength)}${ellipsis}`;
			}
		}

		return `${prefix}${snippet}${suffix}`;
	},

	publicKey:
		"-----BEGIN PUBLIC KEY-----\n" +
		"MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEA9Vu9wa838q/QI6WDxroy\n" +
		"HEGDaZelRrI1GUxxLAoBcU0RTIxqIWTI7DC04DIYbuukpEokBhHZTQMknY7mjONk\n" +
		"M1GftYPdZGoKMOUL4F0K7jV4axS8dNze81IbS8hkG4UwQTn8z0bQQF6/v+qd/tbG\n" +
		"ECH2OVpbU9jKBOSr3YviN8f1RNpJVmcgOPd5W8SFhN4ImVUtWtRXN6Nwv6EbYvKV\n" +
		"nZAbREwYV7wvgZlJZka9onMtER0Ac1tYLK1Syf29Lp+zMWOAjMOHBzmT/MhePmtS\n" +
		"TqZVOpMo2OQzO9LuHv3sh06L6qCSOCEqImnq1/hHnklnmn/HMVCXnF537Ejggtlt\n" +
		"BVdXGz+qNh88p0NfGqRP2d4JZ+doGA4pxLE9cJp6/429d4osrAisGywF1Z1R1Tt7\n" +
		"SAYeeFyn8glp1+9lcb5f+S2HglGafrnxIwyujH269FrZ8d2oYIhfspkZjtB5is99\n" +
		"aR9HnXMbXuZw+uGJUsDQoDzxJN0tvvnJ5HcuK8NAxBfczY2q93mW2i1x+CHS+x+g\n" +
		"T9+NOegwshfnYnHBkiz/cqEgMQNZnhacOnTi29zLxHRsREWi143ZPogZJ3uS8GX7\n" +
		"PYgM2agSkkVbEkSwij2n56fRA1jo+l5833mtKU1HWGufptC3bErKvfH22JwE1q4q\n" +
		"CDO3JpgAt8wj2RU7n2MOPMkCAwEAAQ==\n" +
		"-----END PUBLIC KEY-----",
};

const sqliteToJson = {
	get defaultExeName() {
		let name = "stj_";
		const osPlatform = os.platform();

		switch (osPlatform) {
			case "linux":
			case "darwin":
			case "freebsd":
				name += `${osPlatform}_`;
				break;
			case "win32":
				name += "windows_";
				break;
			default:
				return "";
		}

		switch (process.arch) {
			case "arm":
			case "arm64":
				name += process.arch;
				break;
			case "x64":
				name += "amd64";
				break;
			default:
				return "";
		}

		if (osPlatform === "win32") {
			name += ".exe";
		}
		return name;
	},

	async downloadLatestVersion(defaultExeName) {
		return requests.downloadFile(
			defaultExeName,
			`https://github.com/arespawn/sqlite-to-json/releases/latest/download/${defaultExeName}`,
		);
	},

	async downloadSignature(defaultExeName) {
		const signature = await requests.fetchBuffer(
			`https://github.com/arespawn/sqlite-to-json/releases/latest/download/${defaultExeName}.sig`,
		);
		if ("error" in signature) {
			state.logger?.error("Couldn't fetch the signature of the update.");
			return false;
		}
		return signature;
	},

	_storageDir: "./storage/",
	_dbPath: "./storage.db",
	isConverted() {
		return fs.existsSync(this._storageDir) || !fs.existsSync(this._dbPath);
	},

	async downloadAndVerify() {
		const exeName = this.defaultExeName;
		if (exeName === "") {
			state.logger?.error(
				`Automatic conversion of database is not supported on this platform and arch ${os.platform()}/${process.arch}. Please convert database manually`,
			);
			return false;
		}

		const downloadStatus = await this.downloadLatestVersion(exeName);
		if (!downloadStatus) {
			state.logger?.error("Download failed! Please convert database manually.");
			return false;
		}
		if (os.platform() !== "win32") {
			try {
				await fs.promises.chmod(exeName, 0o755);
			} catch (err) {
				state.logger?.error(
					{ err },
					"Failed to mark the database converter as executable.",
				);
				fs.unlinkSync(exeName);
				return false;
			}
		}

		const signature = await this.downloadSignature(exeName);
		if (!signature) {
			state.logger?.error(
				"Couldn't fetch the signature of the database converter. Please convert database manually",
			);
			fs.unlinkSync(exeName);
			return false;
		}
		if (!updater.validateSignature(signature.result, exeName)) {
			state.logger?.error(
				"Couldn't verify the signature of the database converter. Please convert database manually",
			);
			fs.unlinkSync(exeName);
			return false;
		}

		return exeName;
	},

	runStj(exeName) {
		fs.mkdirSync(this._storageDir, { recursive: true, mode: 0o700 });
		const exePath = path.resolve(exeName);

		const child = childProcess.spawnSync(
			exePath,
			[this._dbPath, "SELECT * FROM WA2DC"],
			{ shell: false },
		);
		if (child.error) {
			throw child.error;
		}
		if (typeof child.status === "number" && child.status !== 0) {
			const stderr = child.stderr ? child.stderr.toString() : "";
			throw new Error(
				`Database converter failed (exit ${child.status})${stderr ? `: ${stderr}` : ""}`,
			);
		}

		const allowedKeys = new Set([
			"settings",
			"chats",
			"contacts",
			"lastMessages",
			"lastTimestamp",
		]);
		const raw = child.stdout ? child.stdout.toString().trim() : "";
		if (!raw) {
			return;
		}

		const rows = raw.split("\n");
		for (const line of rows) {
			if (!line) continue;
			const row = JSON.parse(line);
			const key = sanitizePathSegment(row?.[0] ?? "", "");
			if (!key || !allowedKeys.has(key)) {
				state.logger?.warn(
					{ key: row?.[0] },
					"Skipping unexpected storage key during database migration",
				);
				continue;
			}
			fs.writeFileSync(path.join(this._storageDir, key), row?.[1] ?? "", {
				mode: 0o600,
			});
		}
	},

	async convert() {
		if (this.isConverted()) {
			return true;
		}

		const stjName = await this.downloadAndVerify();
		if (!stjName) {
			return false;
		}

		this.runStj(stjName);
		fs.unlinkSync(stjName);

		return true;
	},
};

const isForumChannelType = (type) => FORUM_CHANNEL_TYPES.includes(type);
const normalizeDiscordId = (value) => {
	if (value == null) return null;
	const trimmed = String(value).trim();
	return trimmed ? trimmed : null;
};
const uniqueDiscordIds = (value = []) => [
	...new Set(
		(Array.isArray(value) ? value : []).map(normalizeDiscordId).filter(Boolean),
	),
];
const normalizeManagedThreadHostBaseName = (value) => {
	const normalized = String(value || "")
		.trim()
		.toLowerCase()
		.replace(/\s+/gu, "-")
		.replace(/[^a-z0-9_-]+/gu, "")
		.replace(/-+/gu, "-")
		.replace(/^[-_]+|[-_]+$/gu, "")
		.slice(0, MANAGED_THREAD_HOST_NAME_MAX_LENGTH);
	return normalized || MANAGED_THREAD_HOST_BASE_NAME;
};
const getManagedThreadHostBaseName = () =>
	normalizeManagedThreadHostBaseName(state.settings?.DefaultThreadHostName);
const getManagedThreadHostName = (
	index = 0,
	baseName = getManagedThreadHostBaseName(),
) => (index <= 0 ? baseName : `${baseName}-${index + 1}`);
const managedThreadHostNamePattern = (baseName) =>
	new RegExp(`^${escapeRegex(baseName)}-(\\d+)$`, "iu");
const getManagedThreadHostNameBase = (name = "") => {
	const normalizedName = String(name || "").toLowerCase();
	const configuredBase = getManagedThreadHostBaseName();
	if (normalizedName === configuredBase) return configuredBase;
	if (normalizedName === MANAGED_THREAD_HOST_BASE_NAME) {
		return MANAGED_THREAD_HOST_BASE_NAME;
	}
	if (managedThreadHostNamePattern(configuredBase).test(normalizedName)) {
		return configuredBase;
	}
	if (
		managedThreadHostNamePattern(MANAGED_THREAD_HOST_BASE_NAME).test(
			normalizedName,
		)
	) {
		return MANAGED_THREAD_HOST_BASE_NAME;
	}
	return null;
};
const isManagedThreadHostName = (name = "") =>
	typeof name === "string" && Boolean(getManagedThreadHostNameBase(name));
const getManagedThreadHostIndex = (channel = {}) => {
	const name = String(channel?.name || "").toLowerCase();
	const baseName = getManagedThreadHostNameBase(name);
	if (!baseName) return null;
	if (name === baseName) return 0;
	const match = name.match(managedThreadHostNamePattern(baseName));
	if (!match) return null;
	const parsed = Number.parseInt(match[1], 10);
	return Number.isFinite(parsed) && parsed >= 2 ? parsed - 1 : null;
};
const getManagedThreadHostTopic = (botId = state.dcClient?.user?.id) =>
	botId ? `${MANAGED_THREAD_HOST_OWNER_PREFIX}${botId}` : "";
const getManagedThreadHostOwnerId = (channel = {}) => {
	const topic = typeof channel?.topic === "string" ? channel.topic : "";
	const markerIndex = topic.indexOf(MANAGED_THREAD_HOST_OWNER_PREFIX);
	if (markerIndex < 0) return null;
	const ownerId = topic
		.slice(markerIndex + MANAGED_THREAD_HOST_OWNER_PREFIX.length)
		.trim()
		.split(/\s+/u)[0];
	return normalizeDiscordId(ownerId);
};
const isManagedThreadHostOwnedByCurrentBot = (channel = {}) => {
	const ownerId = getManagedThreadHostOwnerId(channel);
	const currentBotId = normalizeDiscordId(state.dcClient?.user?.id);
	return !ownerId || !currentBotId || ownerId === currentBotId;
};
const buildStoredChatLink = (webhook, existingChat = {}, overrides = {}) => {
	const threadId = normalizeDiscordId(
		overrides.threadId ?? existingChat?.threadId ?? null,
	);
	return {
		...existingChat,
		id: webhook.id,
		type: webhook.type,
		token: webhook.token,
		channelId: webhook.channelId,
		...(threadId ? { threadId } : {}),
	};
};
const attachWebhookChatMetadata = (webhook, chatLink = {}) => {
	if (!webhook) return webhook;
	webhook.wa2dcThreadId = normalizeDiscordId(chatLink?.threadId);
	webhook.wa2dcTargetChannelId =
		getChatTargetChannelId(chatLink) ||
		webhook.wa2dcThreadId ||
		webhook.channelId;
	return webhook;
};
const withThreadIdForChat = (payload, jid) => {
	const normalizedJid = whatsapp.formatJid(jid) || jid;
	const chatLink = state.chats?.[normalizedJid];
	const threadId = normalizeDiscordId(chatLink?.threadId);
	if (!threadId || !payload || typeof payload !== "object") {
		return payload;
	}
	if (Object.hasOwn(payload, "threadId") && payload.threadId) {
		return payload;
	}
	return { ...payload, threadId };
};

const discord = {
	updateButtonIds: UPDATE_BUTTON_IDS,
	rollbackButtonId: ROLLBACK_BUTTON_ID,
	channelIdToJids(channelId) {
		return Object.keys(state.chats).filter((key) =>
			chatTargetsChannelId(state.chats[key], channelId),
		);
	},
	channelIdToJid(channelId) {
		return this.channelIdToJids(channelId)[0] || null;
	},
	hostChannelIdToJids(channelId) {
		return Object.keys(state.chats).filter(
			(key) =>
				isThreadChatLink(state.chats[key]) &&
				chatUsesHostChannelId(state.chats[key], channelId),
		);
	},
	getChatLink(jid) {
		const normalizedJid = whatsapp.formatJid(jid) || jid;
		return normalizedJid ? state.chats?.[normalizedJid] || null : null;
	},
	getChatTargetChannelId(jid) {
		return getChatTargetChannelId(this.getChatLink(jid));
	},
	getChatTargetMention(jid) {
		const targetChannelId = this.getChatTargetChannelId(jid);
		return targetChannelId ? `<#${targetChannelId}>` : null;
	},
	isManagedThreadHostChannel(channel = {}) {
		return (
			isForumChannelType(channel?.type) &&
			isManagedThreadHostName(channel?.name)
		);
	},
	isOwnedManagedThreadHostChannel(channel = {}) {
		return (
			this.isManagedThreadHostChannel(channel) &&
			isManagedThreadHostOwnedByCurrentBot(channel)
		);
	},
	async ensureManagedThreadHostOwnership(channel) {
		if (!this.isOwnedManagedThreadHostChannel(channel)) return channel;
		const ownerTopic = getManagedThreadHostTopic();
		if (!ownerTopic || getManagedThreadHostOwnerId(channel)) return channel;

		if (typeof channel.setTopic === "function") {
			try {
				await channel.setTopic(ownerTopic);
				channel.topic = ownerTopic;
			} catch (err) {
				state.logger?.warn(
					{
						err,
						channelId: channel.id,
						botId: state.dcClient?.user?.id,
					},
					"Could not mark managed thread host ownership",
				);
			}
		}
		return channel;
	},
	partitionText(text) {
		return text.match(/(.|[\r\n]){1,2000}/g) || [];
	},
	isRetryableWebhookTransportError,
	chunkWebhookFilesForSend(files) {
		return chunkDiscordWebhookFilesForSend(files);
	},
	ensureSpoilerFileName(file) {
		return ensureDiscordSpoilerFileName(file);
	},
	async sendPartitioned(channel, text) {
		if (!channel || !text) return;
		const parts = this.partitionText(text);
		for (const part of parts) {
			await channel.send(part);
		}
	},
	stripCustomEmojiCodes(text = "") {
		if (!text) return "";
		return text.replace(CUSTOM_EMOJI_REGEX, " ").replace(/ {2,}/g, " ");
	},
	ensureExplicitUrlScheme(text = "") {
		const candidate = extractUrlCandidate(text);
		if (!candidate) {
			return { text, matched: null, normalized: null };
		}
		const normalized = normalizePreviewUrl(candidate);
		if (!normalized || normalized === candidate) {
			return { text, matched: candidate, normalized: normalized || candidate };
		}
		const variants = [candidate, `<${candidate}>`];
		let updated = text;
		for (const variant of variants) {
			const next = replaceFirstInstance(updated, variant, normalized);
			if (next !== updated) {
				updated = next;
				break;
			}
		}
		return { text: updated, matched: candidate, normalized };
	},
	normalizeAttachmentUrl(url = "") {
		return normalizeAttachmentUrlForDedupe(url);
	},
	dedupeCollectedAttachments(attachments = []) {
		return dedupeAttachments(attachments);
	},
	mergeCollectedAttachments(...attachmentLists) {
		const accumulator = createAttachmentAccumulator();
		for (const list of attachmentLists) {
			accumulator.append(list);
		}
		return accumulator.toArray();
	},
	extractCustomEmojiData(message) {
		const content = message?.content ?? "";
		if (!content) {
			return { matches: [], rawWithoutEmoji: "" };
		}
		const matches = [...content.matchAll(CUSTOM_EMOJI_REGEX)].map(
			([, animatedFlag, name, id]) => ({
				animated: animatedFlag === "a",
				name,
				id,
			}),
		);
		const rawWithoutEmoji = content.replace(CUSTOM_EMOJI_REGEX, " ");
		return { matches, rawWithoutEmoji };
	},
	buildCustomEmojiAttachments(matches = []) {
		if (!matches.length) return [];
		const unique = new Map();
		for (const entry of matches) {
			if (!entry?.id || unique.has(entry.id)) continue;
			const extension = entry.animated ? "gif" : "png";
			unique.set(entry.id, {
				url: `https://cdn.discordapp.com/emojis/${entry.id}.${extension}?quality=lossless`,
				name: `${sanitizeFileName(entry.name || "emoji", "emoji")}-${entry.id}.${extension}`,
				contentType: extensionToMime(extension),
			});
		}
		return [...unique.values()];
	},
	_buildStickerAttachment(sticker) {
		const id = sticker?.id;
		if (!id) return null;
		const format = sticker?.format;
		const explicitUrl =
			typeof sticker?.url === "string" ? sticker.url.trim() : "";
		let extension = guessExtensionFromUrl(explicitUrl) || "png";
		if (!explicitUrl) {
			if (format === StickerFormatType.GIF) {
				extension = "gif";
			} else if (format === StickerFormatType.Lottie) {
				extension = "json";
			}
		}
		const url =
			explicitUrl || `https://cdn.discordapp.com/stickers/${id}.${extension}`;
		return {
			url,
			name: `${sanitizeFileName(sticker?.name || "sticker", "sticker")}-${id}.${extension}`,
			contentType: extensionToMime(extension),
			isSticker: true,
			discordStickerFormat: format || null,
		};
	},
	collectStickerAttachments(message) {
		const stickers = message?.stickers;
		if (!stickers?.size) return [];
		const attachments = [];
		const seen = new Set();
		for (const sticker of stickers.values()) {
			if (!sticker || !sticker.id || seen.has(sticker.id)) continue;
			const attachment = this._buildStickerAttachment(sticker);
			if (attachment) {
				seen.add(sticker.id);
				attachments.push(attachment);
			}
		}
		return attachments;
	},
	extractGifEmbedAttachments(messageOrEmbeds) {
		const embeds = resolveEmbedList(messageOrEmbeds);
		if (!embeds.length) return [];
		return embeds.map(buildGifEmbedAttachmentEntry).filter(Boolean);
	},
	extractEmbedMediaAttachments(messageOrEmbeds) {
		const embeds = resolveEmbedList(messageOrEmbeds);
		if (!embeds.length) return [];
		const attachments = [];
		const seenUrls = new Set();
		for (const embed of embeds) {
			if (buildGifEmbedAttachmentEntry(embed)) {
				continue;
			}
			const baseName = embed?.title || embed?.provider?.name || "discord-embed";
			for (const mediaUrl of pickEmbedMediaCandidates(embed)) {
				const normalizedUrl = normalizeAttachmentUrlForDedupe(mediaUrl);
				if (
					!normalizedUrl ||
					seenUrls.has(normalizedUrl) ||
					isSupportedGifUrl(mediaUrl)
				)
					continue;
				const extension = guessExtensionFromUrl(mediaUrl);
				if (!extension) continue;
				const contentType = extensionToMime(extension);
				if (
					!contentType.startsWith("image/") &&
					!contentType.startsWith("video/")
				)
					continue;
				seenUrls.add(normalizedUrl);
				attachments.push({
					url: mediaUrl,
					name: `${sanitizeFileName(baseName, "discord-embed")}.${extension}`,
					contentType,
				});
			}
		}
		return attachments;
	},
	extractEmbedText(messageOrEmbeds, { includeUrls = true } = {}) {
		const embeds = resolveEmbedList(messageOrEmbeds);
		if (!embeds.length) return "";
		const blocks = embeds
			.map((embed) => formatEmbedTextBlock(embed, includeUrls))
			.filter(Boolean);
		if (!blocks.length) return "";
		return blocks.join("\n\n");
	},
	collectMessageMedia(
		message,
		{
			includeEmojiAttachments = false,
			emojiMatches = [],
			includeEmbedAttachments = false,
		} = {},
	) {
		const baseAttachments = message?.attachments?.size
			? [...message.attachments.values()]
			: [];
		const stickerAttachments = this.collectStickerAttachments(message);
		const gifEmbeds = this.extractGifEmbedAttachments(message);
		const filteredBaseAttachments = baseAttachments.filter(
			(attachment) =>
				!gifEmbeds.some((entry) =>
					shouldPreferGifEmbedAttachment(attachment, entry),
				),
		);
		const embedAttachments = includeEmbedAttachments
			? this.extractEmbedMediaAttachments(message)
			: [];
		const emojiAttachments = includeEmojiAttachments
			? this.buildCustomEmojiAttachments(emojiMatches)
			: [];
		const consumedUrls = gifEmbeds
			.map((entry) => entry.sourceUrl)
			.filter(Boolean);
		const combined = this.mergeCollectedAttachments(
			filteredBaseAttachments,
			stickerAttachments,
			gifEmbeds.map((entry) => entry.attachment),
			embedAttachments,
			emojiAttachments,
		);
		return { attachments: combined, consumedUrls };
	},
	convertWhatsappFormatting(text = "") {
		if (!text) return text;
		let converted = text;
		converted = converted.replace(/_\*(.+?)\*_/g, "***$1***");
		converted = converted.replace(
			/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g,
			"**$1**",
		);
		converted = converted.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, "*$1*");
		converted = converted.replace(/~(.+?)~/g, "~~$1~~");
		return converted;
	},
	async generateLinkPreview(text, { uploadImage, logger } = {}) {
		return buildLinkPreviewInfo(text, { uploadImage, logger });
	},
	async getGuild() {
		if (!state.dcClient) return null;
		if (!state.settings?.GuildID) return null;
		return state.dcClient.guilds.fetch(state.settings.GuildID).catch((err) => {
			state.logger?.error(err);
		});
	},
	async getChannel(channelID) {
		const guild = await this.getGuild();
		if (!guild) return null;
		return guild.channels.fetch(channelID).catch((err) => {
			state.logger?.error(err);
		});
	},
	async getCategory(nthChannel) {
		const guild = await this.getGuild();
		await guild.channels.fetch();

		if (!Array.isArray(state.settings.Categories)) {
			state.settings.Categories = [];
		}

		let nthCategory = Math.floor((nthChannel + 1) / 50);

		for (;;) {
			if (state.settings.Categories[nthCategory] == null) {
				const categoryName = `whatsapp ${nthCategory + 1}`;
				const category = await guild.channels.create({
					name: categoryName,
					type: ChannelType.GuildCategory,
				});
				state.settings.Categories[nthCategory] = category.id;
				continue;
			}

			const categoryId = state.settings.Categories[nthCategory];
			const category = guild.channels.cache.get(categoryId);

			if (!category) {
				state.settings.Categories.splice(nthCategory, 1);
				continue;
			}

			const childCount = guild.channels.cache.filter(
				(channel) => channel.parentId === categoryId,
			).size;

			if (childCount >= 50) {
				nthCategory += 1;
				continue;
			}

			return categoryId;
		}
	},
	async createChannel(name) {
		const guild = await this.getGuild();
		if (!guild) return null;
		return guild.channels.create({
			name,
			type: ChannelType.GuildText,
			parent: await this.getCategory(
				Object.keys(state.chats).length + this._unfinishedGoccCalls,
			),
		});
	},
	async getOrCreateOwnedWebhook(channel) {
		if (!channel) return null;
		const webhooks = await channel.fetchWebhooks();
		const existing = webhooks.find(
			(hook) => hook.token && hook.owner?.id === state.dcClient?.user?.id,
		);
		if (existing) {
			return ensureWebhookReplySupport(existing);
		}
		return ensureWebhookReplySupport(
			await channel.createWebhook({ name: "WA2DC" }),
		);
	},
	buildManagedThreadStarterPayload(
		jid,
		{
			restored = false,
			notifyTargets = state.settings.ThreadNotificationsEnabled,
		} = {},
	) {
		const name = whatsapp.jidToName(jid);
		const roleIds = uniqueDiscordIds(state.settings?.ThreadNotificationRoles);
		const userIds = uniqueDiscordIds(state.settings?.ThreadNotificationUsers);
		const mentionTokens = [];
		roleIds.forEach((id) => mentionTokens.push(`<@&${id}>`));
		userIds.forEach((id) => mentionTokens.push(`<@${id}>`));

		const lines = [];
		if (notifyTargets && mentionTokens.length) {
			lines.push(mentionTokens.join(" "));
		}
		lines.push(
			restored
				? `WA2DC restored the WhatsApp chat thread for **${name}**.`
				: `New WhatsApp chat: **${name}**`,
		);
		lines.push("Open or join this thread to follow the conversation.");

		const allowedMentions =
			mentionTokens.length && notifyTargets
				? { parse: [], roles: roleIds, users: userIds }
				: undefined;

		return {
			content: lines.join("\n"),
			...(allowedMentions ? { allowedMentions } : {}),
		};
	},
	async getOrCreateManagedThreadHostChannel({
		preferredHostChannelId = null,
	} = {}) {
		const guild = await this.getGuild();
		if (!guild) return null;
		await guild.channels.fetch();

		const preferredHost = preferredHostChannelId
			? guild.channels.cache.get(preferredHostChannelId) || null
			: null;
		if (preferredHost && this.isOwnedManagedThreadHostChannel(preferredHost)) {
			return this.ensureManagedThreadHostOwnership(preferredHost);
		}

		const threadCounts = new Map();
		Object.values(state.chats || {}).forEach((chatLink) => {
			if (!isThreadChatLink(chatLink)) return;
			const hostChannelId = getChatHostChannelId(chatLink);
			if (!hostChannelId) return;
			threadCounts.set(
				hostChannelId,
				(threadCounts.get(hostChannelId) || 0) + 1,
			);
		});

		const allManagedHosts = [...guild.channels.cache.values()]
			.filter((channel) => this.isManagedThreadHostChannel(channel))
			.sort(
				(a, b) =>
					(getManagedThreadHostIndex(a) ?? Number.MAX_SAFE_INTEGER) -
					(getManagedThreadHostIndex(b) ?? Number.MAX_SAFE_INTEGER),
			);
		const managedHosts = allManagedHosts.filter((channel) =>
			isManagedThreadHostOwnedByCurrentBot(channel),
		);
		const availableHost = managedHosts.find(
			(channel) =>
				(threadCounts.get(channel.id) || 0) < MANAGED_THREAD_HOST_SOFT_LIMIT,
		);
		if (availableHost) {
			return this.ensureManagedThreadHostOwnership(availableHost);
		}

		const nextIndex =
			allManagedHosts.reduce(
				(maxIndex, channel) =>
					Math.max(maxIndex, getManagedThreadHostIndex(channel) ?? -1),
				-1,
			) + 1;
		return guild.channels.create({
			name: getManagedThreadHostName(nextIndex),
			type: ChannelType.GuildForum,
			topic: getManagedThreadHostTopic() || undefined,
			parent: await this.getCategory(0),
		});
	},
	async createManagedThreadLink(
		jid,
		{
			restored = false,
			notifyTargets = state.settings.ThreadNotificationsEnabled,
			preferredHostChannelId = null,
		} = {},
	) {
		const hostChannel = await this.getOrCreateManagedThreadHostChannel({
			preferredHostChannelId,
		});
		if (!hostChannel) return null;

		const starterPayload = this.buildManagedThreadStarterPayload(jid, {
			restored,
			notifyTargets,
		});
		const desiredName = whatsapp.jidToChannelName(jid);
		let thread;
		try {
			thread = await hostChannel.threads.create({
				name: desiredName,
				autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
				message: starterPayload,
			});
		} catch (err) {
			if (err?.code !== 50035) {
				throw err;
			}
			thread = await hostChannel.threads.create({
				name: "invalid-name",
				autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
				message: starterPayload,
			});
		}

		const webhook = await this.getOrCreateOwnedWebhook(hostChannel);
		const chatLink = buildStoredChatLink(webhook, {}, { threadId: thread.id });
		return {
			webhook: attachWebhookChatMetadata(webhook, chatLink),
			chatLink,
			thread,
			hostChannel,
		};
	},
	async recreateManagedThreadLink(jid) {
		const normalizedJid = whatsapp.formatJid(jid);
		if (!normalizedJid) return null;
		const existingChat = state.chats?.[normalizedJid] || {};
		const created = await this.createManagedThreadLink(normalizedJid, {
			restored: true,
			notifyTargets: false,
			preferredHostChannelId: existingChat.channelId || null,
		});
		if (!created) return null;
		state.chats[normalizedJid] = {
			...existingChat,
			...created.chatLink,
		};
		delete state.goccRuns[normalizedJid];
		return attachWebhookChatMetadata(
			created.webhook,
			state.chats[normalizedJid],
		);
	},
	_unfinishedGoccCalls: 0,
	async getOrCreateChannel(jid) {
		const normalizedJid = whatsapp.formatJid(jid);
		if (!normalizedJid) return null;
		if (state.goccRuns[normalizedJid]) {
			return state.goccRuns[normalizedJid];
		}
		const inFlight = (async () => {
			const existingChat = state.chats[normalizedJid];
			if (existingChat) {
				let webhook;
				if (existingChat.id && existingChat.token) {
					webhook = ensureWebhookReplySupport(
						new WebhookClient({
							id: existingChat.id,
							token: existingChat.token,
						}),
					);
				} else if (existingChat.channelId) {
					const channel = await this.getChannel(existingChat.channelId);
					webhook = await this.getOrCreateOwnedWebhook(channel);
					state.chats[normalizedJid] = buildStoredChatLink(
						webhook,
						existingChat,
					);
				}
				if (!webhook) {
					return null;
				}
				return attachWebhookChatMetadata(
					webhook,
					state.chats[normalizedJid] || existingChat,
				);
			}

			this._unfinishedGoccCalls++;
			try {
				if (state.settings.DefaultChatType === "thread") {
					const created = await this.createManagedThreadLink(normalizedJid);
					if (!created?.webhook || !created?.chatLink) {
						return null;
					}
					state.chats[normalizedJid] = created.chatLink;
					return attachWebhookChatMetadata(
						created.webhook,
						state.chats[normalizedJid],
					);
				}

				const name = whatsapp.jidToChannelName(normalizedJid);
				const channel = await this.createChannel(name).catch((err) => {
					if (err?.code === 50035) {
						return this.createChannel("invalid-name");
					}
					throw err;
				});
				const webhook = await this.getOrCreateOwnedWebhook(channel);
				state.chats[normalizedJid] = buildStoredChatLink(webhook);
				return attachWebhookChatMetadata(webhook, state.chats[normalizedJid]);
			} finally {
				this._unfinishedGoccCalls--;
			}
		})();

		state.goccRuns[normalizedJid] = inFlight;
		try {
			return await inFlight;
		} catch (err) {
			delete state.goccRuns[normalizedJid];
			throw err;
		}
	},
	async safeWebhookSend(webhook, args, jid) {
		const normalizedJid = whatsapp.formatJid(jid) || jid;
		const normalizeWebhookUsername = (value) => {
			if (typeof value !== "string") return null;
			const trimmed = value
				.replace(/discord/giu, "Disc")
				.replace(/clyde/giu, "Cly")
				.trim();
			if (!trimmed) return null;
			return trimmed.length > 80 ? trimmed.slice(0, 80) : trimmed;
		};

		if (args && typeof args === "object" && Object.hasOwn(args, "username")) {
			const normalized = normalizeWebhookUsername(args.username);
			if (normalized == null) {
				args = { ...args };
				delete args.username;
			} else if (normalized !== args.username) {
				args = { ...args, username: normalized };
			}
		}
		args = withThreadIdForChat(args, normalizedJid);

		const configuredRetriesRaw = state.settings?.DiscordUploadRetryAttempts;
		const configuredRetries = Number(configuredRetriesRaw);
		const maxAbortRetries =
			Number.isFinite(configuredRetries) && configuredRetries >= 1
				? Math.floor(configuredRetries)
				: 3;

		const isAbortError = (err) =>
			err?.name === "AbortError" ||
			err?.name === "AbortError2" ||
			err?.code === "ABORT_ERR" ||
			/aborted/i.test(err?.message || "") ||
			isRetryableWebhookTransportError(err);
		const isUnknownWebhookError = (err) =>
			err?.code === 10015 && /Unknown Webhook/i.test(err?.message || "");
		const isUnknownChannelError = (err) =>
			err?.code === 10003 ||
			err?.rawError?.code === 10003 ||
			/Unknown Channel/i.test(err?.message || "");
		const refreshWebhookForChat = async () => {
			delete state.goccRuns[normalizedJid];
			const chatInfo = state.chats[normalizedJid];
			if (!chatInfo?.channelId) {
				return null;
			}
			const channel = await this.getChannel(chatInfo.channelId);
			if (!channel) {
				return null;
			}
			const refreshedWebhook = await this.getOrCreateOwnedWebhook(channel);
			state.chats[normalizedJid] = buildStoredChatLink(
				refreshedWebhook,
				chatInfo,
			);
			return attachWebhookChatMetadata(
				refreshedWebhook,
				state.chats[normalizedJid],
			);
		};
		const recreateMissingThread = async () => {
			const chatInfo = state.chats[normalizedJid];
			if (!isThreadChatLink(chatInfo)) {
				return null;
			}
			return this.recreateManagedThreadLink(normalizedJid);
		};

		const extractFileNames = (files) => {
			if (!Array.isArray(files)) return [];
			return files
				.map((file, index) => {
					if (!file) return null;
					if (typeof file === "string") return file;
					if (Buffer.isBuffer(file)) return `Attachment ${index + 1}`;
					return (
						file.name ||
						file.attachment?.name ||
						file.attachment?.filename ||
						(typeof file.attachment?.path === "string"
							? path.basename(file.attachment.path)
							: null) ||
						`Attachment ${index + 1}`
					);
				})
				.filter(Boolean);
		};

		const snapshotFileForRetry = (file) => {
			if (file == null || typeof file === "number") {
				return { type: "raw", data: file, retryable: true };
			}
			if (typeof file === "string" || Buffer.isBuffer(file)) {
				return { type: "raw", data: file, retryable: true };
			}

			const { attachment, file: fileProp, ...rest } = file;
			const snapshotBase = {
				rest,
				includeFileProperty: typeof fileProp !== "undefined",
			};

			if (attachment == null) {
				return { ...snapshotBase, type: "object", retryable: true };
			}
			if (typeof attachment === "string" || Buffer.isBuffer(attachment)) {
				return {
					...snapshotBase,
					type: "buffer",
					data: attachment,
					retryable: true,
				};
			}
			if (attachment && typeof attachment.path === "string") {
				return {
					...snapshotBase,
					type: "path",
					path: attachment.path,
					retryable: true,
				};
			}
			if (rest.downloadCtx) {
				return { ...snapshotBase, type: "wa", retryable: true };
			}
			if (typeof attachment.pipe === "function") {
				return { ...snapshotBase, type: "stream", retryable: false };
			}
			return {
				...snapshotBase,
				type: "unknown",
				data: attachment,
				retryable: false,
			};
		};

		const recreateFileFromSnapshot = async (snapshot) => {
			switch (snapshot.type) {
				case "raw":
					return snapshot.data;
				case "object": {
					const base = { ...snapshot.rest };
					if (snapshot.includeFileProperty) {
						base.file = base.attachment;
					}
					return base;
				}
				case "buffer": {
					const base = { ...snapshot.rest, attachment: snapshot.data };
					if (snapshot.includeFileProperty) {
						base.file = base.attachment;
					}
					return base;
				}
				case "path": {
					try {
						const attachment = fs.createReadStream(snapshot.path);
						const base = { ...snapshot.rest, attachment };
						if (snapshot.includeFileProperty) {
							base.file = attachment;
						}
						return base;
					} catch (error) {
						const retryError = new Error(
							`Failed to recreate attachment from path: ${snapshot.path}`,
						);
						retryError.cause = error;
						retryError.wa2dcAttachmentRebuildFailed = true;
						throw retryError;
					}
				}
				case "wa": {
					try {
						const attachment = await downloadMediaMessage(
							snapshot.rest.downloadCtx,
							"stream",
							{},
							{
								logger: state.logger,
								reuploadRequest: state.waClient.updateMediaMessage,
							},
						);
						const base = { ...snapshot.rest, attachment };
						if (snapshot.includeFileProperty) {
							base.file = attachment;
						}
						return base;
					} catch (error) {
						const retryError = new Error(
							"Failed to re-download WhatsApp media for retry",
						);
						retryError.cause = error;
						retryError.wa2dcAttachmentRebuildFailed = true;
						throw retryError;
					}
				}
				case "stream":
				case "unknown": {
					const retryError = new Error(
						"Attachment cannot be retried because the original stream cannot be reconstructed",
					);
					retryError.wa2dcAttachmentRebuildFailed = true;
					throw retryError;
				}
				default:
					return snapshot.data ?? null;
			}
		};

		const { files: originalFiles, ...restArgs } = args;
		const baseArgsWithoutFiles = { ...restArgs };
		const hasFilesArray = Array.isArray(originalFiles);
		const fileSnapshots = hasFilesArray
			? originalFiles.map(snapshotFileForRetry)
			: null;
		const attachmentsRetryable =
			!fileSnapshots ||
			fileSnapshots.every((snapshot) => snapshot.retryable !== false);

		const buildArgsFromSnapshots = async () => {
			const builtArgs = { ...baseArgsWithoutFiles };
			if (hasFilesArray) {
				const rebuiltFiles = await Promise.all(
					fileSnapshots.map(recreateFileFromSnapshot),
				);
				if (rebuiltFiles.some((file) => file == null)) {
					const retryError = new Error(
						"Failed to rebuild one or more attachments for retry",
					);
					retryError.wa2dcAttachmentRebuildFailed = true;
					throw retryError;
				}
				builtArgs.files = rebuiltFiles;
			}
			return builtArgs;
		};

		let attempt = 0;
		let attemptsMade = 0;
		let useOriginalFiles = true;
		let lastAbortError = null;

		while (attempt < maxAbortRetries) {
			let sendArgs;
			try {
				sendArgs = useOriginalFiles ? args : await buildArgsFromSnapshots();
			} catch (prepErr) {
				attemptsMade = attempt + 1;
				if (prepErr.wa2dcAttachmentRebuildFailed) {
					lastAbortError = prepErr;
					break;
				}
				throw prepErr;
			}
			useOriginalFiles = false;

			try {
				return await webhook.send(sendArgs);
			} catch (err) {
				attemptsMade = attempt + 1;
				if (isUnknownWebhookError(err)) {
					webhook = await refreshWebhookForChat();
					if (!webhook) {
						throw err;
					}
					attempt += 1;
					continue;
				}
				if (isUnknownChannelError(err)) {
					webhook = await recreateMissingThread();
					if (!webhook) {
						throw err;
					}
					attempt += 1;
					continue;
				}
				if (err.code === 40005 || err.httpStatus === 413) {
					const content = `WA2DC Attention: Received a file, but it's over Discord's upload limit. Check WhatsApp on your phone${state.settings.LocalDownloads ? "" : " or enable local downloads."}`;
					const fallbackArgs = {
						...withThreadIdForChat(baseArgsWithoutFiles, normalizedJid),
						content,
					};
					if (hasFilesArray) {
						fallbackArgs.files = [];
					}
					return await webhook.send(fallbackArgs);
				}
				if (err.wa2dcAttachmentRebuildFailed) {
					lastAbortError = err;
					break;
				}
				if (isAbortError(err)) {
					lastAbortError = err;
					state.logger?.warn(
						{ err, attempt: attempt + 1 },
						"Discord webhook request failed with a retryable transport error.",
					);
					if (!attachmentsRetryable) {
						state.logger?.warn(
							"Attachments cannot be retried because their sources are not reproducible. Sending fallback message.",
						);
						break;
					}
					attempt += 1;
					if (attempt >= maxAbortRetries) {
						break;
					}
					continue;
				}
				throw err;
			}
		}

		const attemptsForMessage =
			Math.max(attemptsMade, lastAbortError ? 1 : 0) || 1;
		const fileNames = extractFileNames(originalFiles);
		const attemptText = ` after ${attemptsForMessage} attempt${attemptsForMessage === 1 ? "" : "s"}`;
		const attachmentNotice = fileNames.length
			? ` Discord failed to upload${attemptText} for: ${fileNames.join(", ")}.`
			: ` Discord failed to upload${attemptText}.`;
		const originalContent =
			typeof args.content === "string" ? args.content.trim() : "";
		const fallbackParts = [];
		if (originalContent) {
			fallbackParts.push(originalContent);
		}
		fallbackParts.push(
			`WA2DC Attention:${attachmentNotice} Please check WhatsApp for the original message.`,
		);
		const fallbackContent = fallbackParts.join("\n\n");
		const fallbackArgs = {
			...withThreadIdForChat(baseArgsWithoutFiles, normalizedJid),
			content: fallbackContent,
		};
		if (hasFilesArray) {
			fallbackArgs.files = [];
		}
		state.logger?.error(
			{ err: lastAbortError, attempts: attemptsForMessage },
			"Discord webhook request failed repeatedly with a retryable transport error; sending fallback message.",
		);
		return await webhook.send(fallbackArgs);
	},
	async safeWebhookEdit(webhook, messageId, args, jid) {
		const normalizedJid = whatsapp.formatJid(jid);
		const chatInfo = state.chats[normalizedJid];
		try {
			return await webhook.editMessage(
				messageId,
				withThreadIdForChat(args, normalizedJid),
			);
		} catch (err) {
			if (err.code === 10008 && err.message.includes("Unknown Message")) {
				return null;
			}
			if (err.code === 10015 && err.message.includes("Unknown Webhook")) {
				if (normalizedJid) {
					delete state.goccRuns[normalizedJid];
				}
				const channel = await this.getChannel(chatInfo?.channelId);
				webhook = await this.getOrCreateOwnedWebhook(channel);
				if (normalizedJid) {
					state.chats[normalizedJid] = buildStoredChatLink(webhook, chatInfo);
				}
				return await webhook.editMessage(
					messageId,
					withThreadIdForChat(args, normalizedJid),
				);
			}
			throw err;
		}
	},
	async safeWebhookDelete(webhook, messageId, jid) {
		const normalizedJid = whatsapp.formatJid(jid);
		const chatInfo = state.chats[normalizedJid];
		const threadId = normalizeDiscordId(chatInfo?.threadId);
		try {
			return await webhook.deleteMessage(messageId, threadId || undefined);
		} catch (err) {
			if (err.code === 10008 && err.message.includes("Unknown Message")) {
				return null;
			}
			if (threadId && err?.code === 10003) {
				return null;
			}
			if (err.code === 10015 && err.message.includes("Unknown Webhook")) {
				if (normalizedJid) {
					delete state.goccRuns[normalizedJid];
				}
				const channel = await this.getChannel(chatInfo?.channelId);
				webhook = await this.getOrCreateOwnedWebhook(channel);
				if (normalizedJid) {
					state.chats[normalizedJid] = buildStoredChatLink(webhook, chatInfo);
				}
				return await webhook.deleteMessage(messageId, threadId || undefined);
			}
			throw err;
		}
	},
	async repairChannels() {
		const guild = await this.getGuild();
		await guild.channels.fetch();

		if (state.settings.Categories == null) {
			state.settings.Categories = [state.settings.CategoryID];
		}
		const categoryExists = await guild.channels
			.fetch(state.settings.Categories?.[0])
			.catch(() => null);
		const controlExists = await guild.channels
			.fetch(state.settings.ControlChannelID)
			.catch(() => null);

		if (!categoryExists) {
			state.settings.Categories[0] = (
				await guild.channels.create({
					name: "whatsapp",
					type: ChannelType.GuildCategory,
				})
			).id;
		}

		if (!controlExists) {
			state.settings.ControlChannelID = (
				await this.createChannel("control-room")
			).id;
		}

		await (await guild.channels.fetch(state.settings.ControlChannelID)).edit({
			position: 0,
			parent: state.settings.Categories[0],
		});
		for (const [jid, chatLink] of Object.entries(state.chats)) {
			const hostChannelId = getChatHostChannelId(chatLink);
			const targetChannelId = getChatTargetChannelId(chatLink);
			const [hostChannel, targetChannel] = await Promise.all([
				hostChannelId
					? guild.channels.fetch(hostChannelId).catch(() => null)
					: Promise.resolve(null),
				targetChannelId
					? guild.channels.fetch(targetChannelId).catch(() => null)
					: Promise.resolve(null),
			]);
			if (!hostChannel || !targetChannel) {
				delete state.chats[jid];
			}
		}

		for await (const categoryId of state.settings.Categories) {
			const category = await guild.channels.fetch(categoryId).catch(() => null);
			if (category == null) {
				state.settings.Categories = state.settings.Categories.filter(
					(id) => categoryId !== id,
				);
			}
		}

		for (const [, channel] of guild.channels.cache) {
			if (
				channel.id !== state.settings.ControlChannelID &&
				state.settings.Categories.includes(channel.parentId) &&
				!this.channelIdToJid(channel.id) &&
				!this.hostChannelIdToJids(channel.id).length &&
				!this.isManagedThreadHostChannel(channel)
			) {
				channel.edit({ parent: null });
			}
		}
	},
	async renameChannels() {
		const guild = await this.getGuild();

		for (const [jid, chatLink] of Object.entries(state.chats)) {
			try {
				const channel = await guild.channels.fetch(
					getChatTargetChannelId(chatLink),
				);
				await channel.edit({
					name: whatsapp.jidToName(jid),
				});
			} catch (err) {
				state.logger?.error(err);
			}
		}
	},
	async getControlChannel() {
		let channel = await this.getChannel(state.settings.ControlChannelID);
		if (!channel) {
			channel = await this.createChannel("control-room");
			if (!channel) return null;
			state.settings.ControlChannelID = channel.id;
			await channel.edit({
				position: 0,
				parent: await this.getCategory(0),
			});
		}
		return channel;
	},
	async _fetchUpdatePromptMessage() {
		const ref = state.settings.UpdatePromptMessage;
		if (!ref?.messageId) {
			return null;
		}
		const channelId = ref.channelId || state.settings.ControlChannelID;
		try {
			const channel = await this.getChannel(channelId);
			if (!channel) {
				state.settings.UpdatePromptMessage = null;
				return null;
			}
			const message = await channel.messages.fetch(ref.messageId);
			return message;
		} catch (err) {
			state.logger?.debug?.(
				{ err },
				"Failed to fetch stored update prompt message",
			);
			state.settings.UpdatePromptMessage = null;
			return null;
		}
	},
	async ensureUpdatePrompt(updateInfo) {
		if (!updateInfo) {
			await this.clearUpdatePrompt();
			return;
		}
		const content = updater.formatUpdateMessage(updateInfo);
		const components = [
			new ActionRowBuilder().addComponents(
				new ButtonBuilder()
					.setCustomId(UPDATE_BUTTON_IDS.APPLY)
					.setLabel("Update")
					.setStyle(ButtonStyle.Primary)
					.setDisabled(!updateInfo.canSelfUpdate),
				new ButtonBuilder()
					.setCustomId(UPDATE_BUTTON_IDS.SKIP)
					.setLabel("Skip update")
					.setStyle(ButtonStyle.Secondary),
			),
		];

		let message = await this._fetchUpdatePromptMessage();
		if (message) {
			await message.edit({ content, components });
			return;
		}

		const channel = await this.getControlChannel();
		if (!channel) {
			return;
		}
		message = await channel.send({ content, components });
		state.settings.UpdatePromptMessage = {
			channelId: channel.id,
			messageId: message.id,
		};
		try {
			await storage.save();
		} catch (err) {
			state.logger?.warn({ err }, "Failed to persist update prompt metadata");
		}
	},
	async clearUpdatePrompt() {
		const ref = state.settings.UpdatePromptMessage;
		const hadStoredMessage = Boolean(ref);
		if (ref?.messageId) {
			const message = await this._fetchUpdatePromptMessage();
			await message?.delete().catch(() => {});
		}
		state.settings.UpdatePromptMessage = null;
		if (hadStoredMessage) {
			try {
				await storage.save();
			} catch (err) {
				state.logger?.warn(
					{ err },
					"Failed to persist cleared update prompt metadata",
				);
			}
		}
	},
	async syncUpdatePrompt() {
		try {
			if (state.updateInfo) {
				await this.ensureUpdatePrompt(state.updateInfo);
			} else {
				await this.clearUpdatePrompt();
			}
		} catch (err) {
			state.logger?.warn({ err }, "Failed to sync update prompt");
		}
	},
	async _fetchRollbackPromptMessage() {
		const ref = state.settings.RollbackPromptMessage;
		if (!ref?.messageId) {
			return null;
		}
		const channelId = ref.channelId || state.settings.ControlChannelID;
		try {
			const channel = await this.getChannel(channelId);
			if (!channel) {
				state.settings.RollbackPromptMessage = null;
				return null;
			}
			const message = await channel.messages.fetch(ref.messageId);
			return message;
		} catch (err) {
			state.logger?.debug?.(
				{ err },
				"Failed to fetch stored rollback prompt message",
			);
			state.settings.RollbackPromptMessage = null;
			return null;
		}
	},
	async ensureRollbackPrompt() {
		if (updater.isNode) {
			await this.clearRollbackPrompt();
			return;
		}
		const hasBackup = await updater.hasBackup();
		if (!hasBackup) {
			await this.clearRollbackPrompt();
			return;
		}
		const content =
			"A backup of the previous version is available. Use the button below to roll back if you encounter issues.";
		const components = [
			new ActionRowBuilder().addComponents(
				new ButtonBuilder()
					.setCustomId(ROLLBACK_BUTTON_ID)
					.setLabel("Roll back")
					.setStyle(ButtonStyle.Danger),
			),
		];
		let message = await this._fetchRollbackPromptMessage();
		if (message) {
			await message.edit({ content, components });
			return;
		}
		const channel = await this.getControlChannel();
		if (!channel) {
			return;
		}
		message = await channel.send({ content, components });
		state.settings.RollbackPromptMessage = {
			channelId: channel.id,
			messageId: message.id,
		};
		try {
			await storage.save();
		} catch (err) {
			state.logger?.warn({ err }, "Failed to persist rollback prompt metadata");
		}
	},
	async clearRollbackPrompt() {
		const ref = state.settings.RollbackPromptMessage;
		const hadStoredMessage = Boolean(ref);
		if (ref?.messageId) {
			const message = await this._fetchRollbackPromptMessage();
			await message?.delete().catch(() => {});
		}
		state.settings.RollbackPromptMessage = null;
		if (hadStoredMessage) {
			try {
				await storage.save();
			} catch (err) {
				state.logger?.warn(
					{ err },
					"Failed to persist cleared rollback prompt metadata",
				);
			}
		}
	},
	async syncRollbackPrompt() {
		try {
			if (updater.isNode) {
				await this.clearRollbackPrompt();
				return;
			}
			const hasBackup = await updater.hasBackup();
			if (hasBackup) {
				await this.ensureRollbackPrompt();
			} else {
				await this.clearRollbackPrompt();
			}
		} catch (err) {
			state.logger?.warn({ err }, "Failed to sync rollback prompt");
		}
	},
	async findAvailableName(dir, fileName) {
		const safeName = sanitizePathSegment(fileName, "file");
		const parsed = path.parse(safeName);
		const baseName = parsed.name || "file";
		const ext = parsed.ext || "";

		let counter = 0;
		for (;;) {
			const suffix = counter === 0 ? "" : `-${counter}`;
			const candidate = `${baseName}${suffix}${ext}`;
			const absPath = path.resolve(dir, candidate);
			try {
				await fs.promises.stat(absPath);
				counter += 1;
			} catch (err) {
				if (err?.code === "ENOENT") {
					return [absPath, candidate];
				}
				throw err;
			}
		}
	},
	async pruneDownloadsDir(ignorePath) {
		const limitGB = Number(state.settings.DownloadDirLimitGB) || 0;
		const maxAgeDays = Number(state.settings.DownloadDirMaxAgeDays) || 0;
		const minFreeGB = Number(state.settings.DownloadDirMinFreeGB) || 0;

		const limitBytes = limitGB > 0 ? limitGB * 1024 * 1024 * 1024 : null;
		const maxAgeMs = maxAgeDays > 0 ? maxAgeDays * 24 * 60 * 60 * 1000 : null;
		const minFreeBytes = minFreeGB > 0 ? minFreeGB * 1024 * 1024 * 1024 : null;

		if (!limitBytes && !maxAgeMs && !minFreeBytes) return;

		const resolvedDownloadDir = path.resolve(state.settings.DownloadDir);
		const resolvedIgnorePath = ignorePath ? path.resolve(ignorePath) : null;
		let entries;
		try {
			entries = await fs.promises.readdir(state.settings.DownloadDir);
		} catch {
			return;
		}
		const files = await Promise.all(
			entries.map(async (name) => {
				const filePath = path.resolve(resolvedDownloadDir, name);
				try {
					const stat = await fs.promises.stat(filePath);
					if (!stat.isFile()) return null;
					return { filePath, mtime: stat.mtimeMs, size: stat.size };
				} catch {
					return null;
				}
			}),
		);
		let validFiles = files.filter(Boolean).sort((a, b) => a.mtime - b.mtime);

		const deleteFile = async (file) => {
			if (!file?.filePath) return false;
			if (resolvedIgnorePath && file.filePath === resolvedIgnorePath)
				return false;
			try {
				await fs.promises.unlink(file.filePath);
				return true;
			} catch {
				return false;
			}
		};

		if (maxAgeMs) {
			const cutoff = Date.now() - maxAgeMs;
			const remaining = [];
			for (const file of validFiles) {
				if (file.mtime >= cutoff) {
					remaining.push(file);
					continue;
				}

				const deleted = await deleteFile(file);
				if (!deleted) {
					remaining.push(file);
				}
			}
			validFiles = remaining;
		}

		if (limitBytes) {
			let total = validFiles.reduce((sum, f) => sum + f.size, 0);
			const remaining = [];
			for (const file of validFiles) {
				if (total <= limitBytes) {
					remaining.push(file);
					continue;
				}

				const deleted = await deleteFile(file);
				if (deleted) {
					total -= file.size;
				} else {
					remaining.push(file);
				}
			}
			validFiles = remaining;
		}

		if (minFreeBytes) {
			let freeBytes = null;
			try {
				const statfs = await fs.promises.statfs(resolvedDownloadDir);
				const bavail = Number(statfs?.bavail);
				const bsize = Number(statfs?.bsize);
				if (Number.isFinite(bavail) && Number.isFinite(bsize)) {
					freeBytes = bavail * bsize;
				}
			} catch {
				freeBytes = null;
			}

			if (freeBytes != null && freeBytes < minFreeBytes) {
				const remaining = [];
				for (const file of validFiles) {
					if (freeBytes >= minFreeBytes) {
						remaining.push(file);
						continue;
					}

					const deleted = await deleteFile(file);
					if (deleted) {
						freeBytes += file.size;
					} else {
						remaining.push(file);
					}
				}
				validFiles = remaining;
			}
		}
	},
	async downloadLargeFile(file) {
		await fs.promises.mkdir(state.settings.DownloadDir, {
			recursive: true,
			mode: 0o700,
		});
		const [absPath, fileName] = await this.findAvailableName(
			state.settings.DownloadDir,
			file.name,
		);
		const writeFromDownloadCtx = async () => {
			const stream = await downloadContentFromMessage(
				file.downloadCtx.message[file.msgType],
				file.msgType.replace("Message", ""),
				{
					logger: state.logger,
					reuploadRequest: state.waClient.updateMediaMessage,
				},
			);
			await pipeline(stream, fs.createWriteStream(absPath, { mode: 0o600 }));
		};

		try {
			if (typeof file.attachment?.pipe === "function") {
				await pipeline(
					file.attachment,
					fs.createWriteStream(absPath, { mode: 0o600 }),
				);
			} else if (file.downloadCtx) {
				await writeFromDownloadCtx();
			} else {
				await fs.promises.writeFile(absPath, file.attachment, { mode: 0o600 });
			}
		} catch (err) {
			const canRetry = !!file.downloadCtx;
			if (canRetry) {
				state.logger?.warn(
					{ err, file: file.name },
					"Retrying WhatsApp media download after failure",
				);
				try {
					await writeFromDownloadCtx();
				} catch (retryErr) {
					state.logger?.error(
						{ err: retryErr, file: file.name },
						"Failed to download WhatsApp media after retry",
					);
					await fs.promises.rm(absPath, { force: true }).catch(() => {});
					return "\nWA2DC Attention: Failed to download attachment from WhatsApp. Please check WhatsApp or try again.";
				}
			} else {
				state.logger?.error(
					{ err, file: file.name },
					"Failed to download WhatsApp media",
				);
				await fs.promises.rm(absPath, { force: true }).catch(() => {});
				return "\nWA2DC Attention: Failed to download attachment from WhatsApp. Please check WhatsApp or try again.";
			}
		}
		await this.pruneDownloadsDir(absPath);
		let url;
		if (state.settings.LocalDownloadServer) {
			ensureDownloadServer();
			const server = ensureDownloadServer.server;
			if (!server) {
				url = pathToFileURL(absPath).href;
			} else {
				const token = buildDownloadToken(fileName);
				const configuredHost =
					typeof state.settings.LocalDownloadServerHost === "string"
						? state.settings.LocalDownloadServerHost.trim()
						: "";
				const publicHost =
					configuredHost && !["0.0.0.0", "::"].includes(configuredHost)
						? configuredHost
						: "localhost";
				const hostForUrl =
					publicHost.includes(":") && !publicHost.startsWith("[")
						? `[${publicHost}]`
						: publicHost;
				const address = server.listening ? server.address() : null;
				const port =
					state.settings.LocalDownloadServerPort === 0 &&
					address &&
					typeof address === "object"
						? address.port
						: state.settings.LocalDownloadServerPort;
				const protocol = ensureDownloadServer.protocol || "http";
				url = `${protocol}://${hostForUrl}:${port}/${token}/${encodeURIComponent(fileName)}`;
			}
		} else {
			url = pathToFileURL(absPath).href;
		}
		return this.formatDownloadMessage(
			absPath,
			path.resolve(state.settings.DownloadDir),
			fileName,
			url,
		);
	},
	formatDownloadMessage(absPath, resolvedDownloadDir, fileName, url) {
		return state.settings.LocalDownloadMessage.replaceAll("{abs}", absPath)
			.replaceAll("{resolvedDownloadDir}", resolvedDownloadDir)
			.replaceAll("{downloadDir}", state.settings.DownloadDir)
			.replaceAll("{fileName}", fileName)
			.replaceAll("{url}", url);
	},
};

const whatsapp = {
	jidToPhone(jid = "") {
		if (!jid) return "";
		return String(jid).split(":")[0].split("@")[0];
	},
	ensurePrivacySalt() {
		return ensurePrivacySaltKey();
	},
	isPhoneLike(value) {
		if (typeof value !== "string") return false;
		const trimmed = value.trim();
		if (!trimmed) return false;
		if (/[a-z]/i.test(trimmed)) return false;
		const digits = trimmed.replace(/\D/g, "");
		return digits.length >= 7 && digits.length <= 15;
	},
	privacyTagForJid(jid) {
		const key = ensurePrivacySaltKey();
		const normalized = this.formatJid(jid) || String(jid || "");
		if (!normalized) return "unknown";
		const digest = crypto
			.createHmac("sha256", key)
			.update(normalized, "utf8")
			.digest("base64url");
		return digest.slice(0, 10);
	},
	anonymousName(jid) {
		const tag = this.privacyTagForJid(jid);
		return `WA User ${tag}`;
	},
	anonymousChannelName(jid) {
		const normalized = this.formatJid(jid) || String(jid || "");
		const tag = this.privacyTagForJid(normalized);
		if (normalized === "status@broadcast") return "status";
		if (typeof normalized === "string" && normalized.endsWith("@g.us"))
			return `wa-group-${tag}`;
		return `wa-user-${tag}`;
	},
	formatJidForDisplay(jid) {
		const formatted = this.formatJid(jid) || String(jid || "");
		if (!formatted) return "";
		if (!state.settings?.HidePhoneNumbers) return formatted;
		if (!this.isPhoneJid(formatted)) return formatted;
		return `pn:redacted:${this.privacyTagForJid(formatted)}`;
	},
	formatJid(jid) {
		if (!jid) return null;
		const [userPart, serverPart] = String(jid).split("@");
		if (!serverPart) return String(jid);
		const cleanUser = userPart.split(":")[0];
		const normalizedUser = (() => {
			const server = String(serverPart).trim();
			if (server !== "s.whatsapp.net" && server !== "lid") return cleanUser;
			const digitsOnly = String(cleanUser).replace(/\D/g, "");
			return digitsOnly || cleanUser;
		})();
		return `${normalizedUser}@${serverPart}`;
	},
	isPhoneJid(jid = "") {
		return typeof jid === "string" && jid.endsWith("@s.whatsapp.net");
	},
	isLidJid(jid = "") {
		return typeof jid === "string" && jid.endsWith("@lid");
	},
	normalizeMentionLinks() {
		const links = state.settings?.WhatsAppDiscordMentionLinks;
		if (!links || typeof links !== "object" || Array.isArray(links))
			return false;

		let changed = false;
		for (const [jidRaw, discordId] of Object.entries({ ...links })) {
			const normalized = this.formatJid(jidRaw);
			if (!normalized || normalized === jidRaw) continue;

			if (!Object.hasOwn(links, normalized)) {
				links[normalized] = discordId;
			} else if (links[normalized] !== discordId) {
				state.logger?.warn?.(
					{ from: jidRaw, to: normalized },
					"Conflicting mention link keys; keeping normalized entry",
				);
			}

			delete links[jidRaw];
			changed = true;
		}
		return changed;
	},
	migrateLegacyJid(oldJid, newJid) {
		const legacy = this.formatJid(oldJid);
		const fresh = this.formatJid(newJid);
		if (!legacy || !fresh || legacy === fresh) return;
		const migrateKey = (container) => {
			if (!container || !Object.hasOwn(container, legacy)) return;
			if (!Object.hasOwn(container, fresh)) {
				container[fresh] = container[legacy];
			}
			delete container[legacy];
		};
		migrateKey(state.chats);
		migrateKey(state.contacts);
		migrateKey(state.goccRuns);
		migrateKey(state.settings?.WhatsAppDiscordMentionLinks);
		const whitelist = state.settings?.Whitelist;
		if (Array.isArray(whitelist) && whitelist.length) {
			const normalized = whitelist.map((jid) => {
				const formatted = this.formatJid(jid);
				return formatted === legacy ? fresh : formatted;
			});
			state.settings.Whitelist = [...new Set(normalized.filter(Boolean))];
		}
	},
	resolveKnownJid(...candidates) {
		const flat = candidates.flat().filter(Boolean);
		for (const jid of flat) {
			if (state.chats[jid]) return jid;
		}
		for (const jid of flat) {
			if (state.contacts[jid]) return jid;
		}
		return flat.find(Boolean) || null;
	},
	async generateLinkPreview(text, { uploadImage, logger } = {}) {
		return discord.generateLinkPreview(text, { uploadImage, logger });
	},
	getChatJidCandidates(rawMsg = {}) {
		const { key = {} } = rawMsg;
		const remoteJid = this.formatJid(
			key.remoteJid ||
				rawMsg.chatId ||
				rawMsg.attrs?.from ||
				rawMsg.from ||
				rawMsg.jid,
		);
		const remoteJidAlt = this.formatJid(
			key.remoteJidAlt || rawMsg.remoteJidAlt,
		);
		const candidates = [];
		if (remoteJid) candidates.push(remoteJid);
		if (remoteJidAlt && !candidates.includes(remoteJidAlt))
			candidates.push(remoteJidAlt);
		return candidates;
	},
	isStatusBroadcast(rawMsg = {}) {
		const [candidatePrimary] = this.getChatJidCandidates(rawMsg);
		return candidatePrimary === "status@broadcast";
	},
	isMe(myJID, jid) {
		return jid.startsWith(this.jidToPhone(myJID)) && !jid.endsWith("@g.us");
	},
	jidToName(jid, pushName) {
		const formatted = this.formatJid(jid) || String(jid || "");
		const myJid = state.waClient?.user?.id;
		if (myJid && formatted && this.isMe(myJid, formatted)) {
			return "You";
		}
		const contactName =
			(formatted &&
				(state.waClient?.contacts?.[formatted] ??
					state.contacts?.[formatted])) ||
			null;
		const hidePhones = Boolean(state.settings?.HidePhoneNumbers);
		const candidates = [contactName, pushName];
		for (const candidate of candidates) {
			if (typeof candidate !== "string") continue;
			const trimmed = candidate.trim();
			if (!trimmed) continue;
			if (hidePhones && this.isPhoneLike(trimmed)) continue;
			return trimmed;
		}
		if (!hidePhones) {
			const fallback = this.jidToPhone(formatted);
			return fallback ? fallback : "Unknown";
		}
		return formatted ? this.anonymousName(formatted) : "Unknown";
	},
	toJid(name) {
		if (!name) return null;
		const trimmed = String(name).trim();
		const isPhoneLike = /^\+?[\d\s().-]+$/.test(trimmed);
		if (isPhoneLike) {
			const digits = trimmed.replace(/\D/g, "");
			if (digits) return this.formatJid(`${digits}@s.whatsapp.net`);
		}

		if (/^\d+$/.test(trimmed)) {
			return this.formatJid(`${trimmed}@s.whatsapp.net`);
		}
		if (trimmed.includes("@")) {
			return this.formatJid(trimmed);
		}
		if (state.settings?.HidePhoneNumbers) {
			const match =
				trimmed.match(/^wa-(?:user|group)-([a-z0-9_-]{6,})$/i) ||
				trimmed.match(/^wa\s+(?:user|group)\s+([a-z0-9_-]{6,})$/i);
			const tag = match?.[1];
			if (tag) {
				const jidCandidates = new Set([
					...Object.keys(state.waClient?.contacts || {}),
					...Object.keys(state.contacts || {}),
					...Object.keys(state.chats || {}),
				]);
				for (const jidCandidate of jidCandidates) {
					if (!jidCandidate) continue;
					if (this.privacyTagForJid(jidCandidate) === tag) {
						return this.formatJid(jidCandidate);
					}
				}
			}
		}
		const normalized = trimmed.toLowerCase();
		const contactStore = state.waClient?.contacts || state.contacts || {};
		const matches = Object.keys(contactStore).filter(
			(key) =>
				contactStore[key] &&
				contactStore[key].toLowerCase().trim() === normalized,
		);
		const preferred = matches.find((jid) => this.isPhoneJid(jid)) || matches[0];
		return this.formatJid(preferred);
	},
	jidToChannelName(jid, pushName) {
		const hidePhones = Boolean(state.settings?.HidePhoneNumbers);
		if (!hidePhones) return this.jidToName(jid, pushName);
		const formatted = this.formatJid(jid) || String(jid || "");
		const name = this.jidToName(formatted, pushName);
		if (!name || name === "Unknown")
			return this.anonymousChannelName(formatted);
		if (formatted && name === this.anonymousName(formatted))
			return this.anonymousChannelName(formatted);
		if (this.isPhoneLike(name)) return this.anonymousChannelName(formatted);
		return name;
	},
	contacts() {
		return Object.values(state.waClient?.contacts || {});
	},
	convertDiscordFormatting(text = "") {
		if (!text) return text;
		let converted = text;
		converted = converted.replace(/```(\w+)\n/g, "```\n");
		converted = converted.replace(
			/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g,
			"_$1_",
		);
		converted = converted.replace(/\*\*\*(.+?)\*\*\*/g, "_*$1*_");
		converted = converted.replace(/\*\*(.+?)\*\*/g, "*$1*");
		converted = converted.replace(/~~(.+?)~~/g, "~$1~");
		return converted;
	},
	getMentionedJids(text) {
		const mentions = new Set();
		if (!text) return [];

		const cleaned = text.replace(/<@!?\d+>|<@&\d+>/g, "");
		const lower = cleaned.toLowerCase();
		const contactStore = state.waClient?.contacts || state.contacts || {};

		for (const [jid, name] of Object.entries(contactStore)) {
			if (!name) continue;
			if (lower.includes(`@${String(name).toLowerCase()}`)) {
				const formatted = this.formatJid(jid);
				if (formatted) mentions.add(formatted);
			}
		}
		const phoneMentionRegex = /@(\+?\d{7,15})(?=\W|$)/g;
		for (const match of cleaned.matchAll(phoneMentionRegex)) {
			const digits = String(match[1] || "").replace(/\D/g, "");
			if (!digits) continue;
			const jid = this.formatJid(`${digits}@s.whatsapp.net`);
			if (jid) mentions.add(jid);
		}

		return [...mentions];
	},
	getLinkedJidsForDiscordUserId(discordUserId) {
		const links = state.settings?.WhatsAppDiscordMentionLinks;
		if (!links || typeof links !== "object" || Array.isArray(links)) return [];
		const normalizedId = normalizeDiscordUserId(discordUserId, {
			coerce: true,
		});
		if (!normalizedId) return [];

		const results = new Set();
		for (const [jidRaw, discordIdRaw] of Object.entries(links)) {
			const storedId =
				typeof discordIdRaw === "string" ? discordIdRaw.trim() : "";
			if (storedId !== normalizedId) continue;
			const formatted = this.formatJid(jidRaw);
			if (formatted) results.add(formatted);
		}
		return [...results];
	},
	async preferMentionJidForChat(mentionJid, chatJid = null) {
		void chatJid;
		const formatted = this.formatJid(mentionJid);
		if (!formatted) return null;

		const store = state.waClient?.signalRepository?.lidMapping;
		if (this.isPhoneJid(formatted)) return formatted;
		if (
			this.isLidJid(formatted) &&
			store &&
			typeof store.getPNForLID === "function"
		) {
			try {
				const pn = this.formatJid(await store.getPNForLID(formatted));
				if (pn) return pn;
			} catch (err) {
				state.logger?.debug?.({ err }, "Failed to resolve PN JID for mention");
			}
		}
		return formatted;
	},
	async applyDiscordMentionLinks(
		text,
		mentionDescriptors = [],
		{ appendTrailing = false, chatJid = null } = {},
	) {
		if (!text) return { text, mentionJids: [] };
		if (!Array.isArray(mentionDescriptors) || mentionDescriptors.length === 0) {
			return { text, mentionJids: [] };
		}

		const mentionJids = new Set();
		let nextText = text;
		const appended = new Set();

		for (const descriptor of mentionDescriptors) {
			const discordUserId = descriptor?.discordUserId;
			const displayTokens = Array.isArray(descriptor?.displayTokens)
				? descriptor.displayTokens
				: [];
			const rawTokens = Array.isArray(descriptor?.rawTokens)
				? descriptor.rawTokens
				: [];
			if (!discordUserId) continue;

			const linked = this.getLinkedJidsForDiscordUserId(discordUserId);
			if (!linked.length) continue;

			const preferred = linked.find((jid) => this.isPhoneJid(jid)) || linked[0];

			const mentionJid = await this.preferMentionJidForChat(preferred, chatJid);
			if (!mentionJid) continue;

			const normalizedDisplayTokens = [
				...new Set(
					displayTokens
						.map((token) => (typeof token === "string" ? token.trim() : ""))
						.filter(Boolean),
				),
			];
			const linkedContactName = this.jidToName(mentionJid);
			const preferredDisplayName =
				linkedContactName &&
				!isUnknownDisplayName(linkedContactName) &&
				!this.isPhoneLike(linkedContactName)
					? linkedContactName
					: normalizedDisplayTokens[0] || null;
			const replacementLabel = this.isPhoneJid(mentionJid)
				? this.jidToPhone(mentionJid)
				: preferredDisplayName || this.jidToName(mentionJid);
			const replacementToken = `@${String(replacementLabel || "").replace(/^@+/, "")}`;

			let replaced = false;
			const candidates = normalizedDisplayTokens;

			const rawCandidates = [
				...new Set(
					rawTokens
						.map((t) => (typeof t === "string" ? t.trim() : ""))
						.filter(Boolean),
				),
			];
			for (const token of rawCandidates) {
				const regex = new RegExp(escapeRegex(token), "g");
				const updated = nextText.replace(regex, replacementToken);
				if (updated === nextText) continue;
				nextText = updated;
				replaced = true;
			}

			for (const token of candidates) {
				const regex = buildUnicodeMentionRegex(token);
				const updated = nextText.replace(regex, replacementToken);
				if (updated === nextText) continue;
				nextText = updated;
				replaced = true;
			}

			if (replaced) {
				mentionJids.add(mentionJid);
			} else if (appendTrailing && !appended.has(mentionJid)) {
				nextText = nextText
					? `${nextText} ${replacementToken}`
					: replacementToken;
				appended.add(mentionJid);
				mentionJids.add(mentionJid);
			}
		}

		return { text: nextText, mentionJids: [...mentionJids] };
	},
	async sendQR(qrString) {
		await (await discord.getControlChannel()).send({
			files: [
				new AttachmentBuilder(await QRCode.toBuffer(qrString), {
					name: "qrcode.png",
				}),
			],
		});
	},
	async hydrateJidPair(primary, alternate) {
		let preferred = this.formatJid(primary);
		let fallback = this.formatJid(alternate);
		if (preferred && fallback) {
			const phone = this.isPhoneJid(preferred)
				? preferred
				: this.isPhoneJid(fallback)
					? fallback
					: null;
			const lid = this.isLidJid(preferred)
				? preferred
				: this.isLidJid(fallback)
					? fallback
					: null;
			if (phone && lid) {
				this.migrateLegacyJid(lid, phone);
				return [phone, lid];
			}
			return [preferred, fallback];
		}

		const store = state.waClient?.signalRepository?.lidMapping;
		if (!store || !preferred) {
			return [preferred, fallback];
		}

		try {
			if (
				!fallback &&
				this.isLidJid(preferred) &&
				typeof store.getPNForLID === "function"
			) {
				const pnJid = this.formatJid(await store.getPNForLID(preferred));
				if (pnJid) {
					fallback = preferred;
					preferred = pnJid;
					this.migrateLegacyJid(fallback, preferred);
				}
			} else if (
				!fallback &&
				this.isPhoneJid(preferred) &&
				typeof store.getLIDForPN === "function"
			) {
				const lidJid = this.formatJid(await store.getLIDForPN(preferred));
				if (lidJid) {
					fallback = lidJid;
					this.migrateLegacyJid(lidJid, preferred);
				}
			}
		} catch (err) {
			state.logger?.warn(
				{ err },
				"Failed to hydrate JID pair from LID mapping store",
			);
		}

		return [preferred, fallback];
	},
	async getChannelJid(rawMsg) {
		if (this.isStatusBroadcast(rawMsg)) {
			return "status@broadcast";
		}
		const [candidatePrimary, candidateAlternate] =
			this.getChatJidCandidates(rawMsg);
		const [primary, alternate] = await this.hydrateJidPair(
			candidatePrimary,
			candidateAlternate,
		);
		return this.resolveKnownJid(primary, alternate);
	},
	async getSenderJid(rawMsg, fromMe) {
		if (fromMe) {
			return this.formatJid(state.waClient.user.id);
		}
		const { key = {} } = rawMsg || {};
		const participant = this.formatJid(key.participant || rawMsg?.participant);
		const participantAlt = this.formatJid(
			key.participantAlt || rawMsg?.participantAlt || key.remoteJidAlt,
		);
		const [primary, alternate] = await this.hydrateJidPair(
			participant,
			participantAlt,
		);
		const resolved = this.resolveKnownJid(primary, alternate);
		if (resolved) return resolved;
		const [chatCandidatePrimary, chatCandidateAlternate] =
			this.getChatJidCandidates(rawMsg);
		const [chatPrimary, chatAlternate] = await this.hydrateJidPair(
			chatCandidatePrimary,
			chatCandidateAlternate,
		);
		return (
			this.resolveKnownJid(chatPrimary, chatAlternate) ||
			chatPrimary ||
			chatAlternate
		);
	},
	async getSenderName(rawMsg) {
		return this.jidToName(
			await this.getSenderJid(rawMsg, rawMsg.key.fromMe),
			rawMsg.pushName,
		);
	},
	isGroup(rawMsg) {
		if (this.isStatusBroadcast(rawMsg)) return false;
		return rawMsg?.key?.participant != null;
	},
	isForwarded(msg, explicitContextInfo = null) {
		const context =
			explicitContextInfo ||
			msg?.contextInfo ||
			msg?.messageContextInfo ||
			msg?.message?.messageContextInfo;
		if (context?.isForwarded) return true;
		if (!msg || typeof msg !== "object") return false;
		const nested = Object.values(msg).find(
			(value) => value?.contextInfo?.isForwarded,
		);
		return Boolean(nested);
	},
	isQuoted(msg, explicitContextInfo = null) {
		const context =
			explicitContextInfo ||
			msg?.contextInfo ||
			msg?.messageContextInfo ||
			msg?.message?.messageContextInfo;
		if (context?.quotedMessage) return true;
		if (!msg || typeof msg !== "object") return false;
		const nested = Object.values(msg).find(
			(value) => value?.contextInfo?.quotedMessage,
		);
		return Boolean(nested);
	},
	async getQuote(rawMsg) {
		const msgType = this.getMessageType(rawMsg);
		const [, msg] = this.getMessage(rawMsg, msgType);

		if (!msgType || !msg) return null;

		const context = msg?.contextInfo || rawMsg?.message?.messageContextInfo;
		if (!context) return null;

		const qMsg = context.quotedMessage;
		const quoteId =
			context?.stanzaId ||
			context?.placeholderKey?.id ||
			context?.questionReplyQuotedMessage?.stanzaId ||
			null;
		const quoteSourceJid = this.formatJid(
			context?.remoteJid || context?.placeholderKey?.remoteJid,
		);
		const quoteParticipant = this.formatJid(
			context?.participant || context?.placeholderKey?.participant,
		);
		const quoteParticipantAlt = this.formatJid(context?.participantAlt);

		const getStoredQuoteMessage = async () => {
			if (!quoteId) return null;
			const rawRemote = this.formatJid(rawMsg?.key?.remoteJid);
			const rawRemoteAlt = this.formatJid(
				rawMsg?.key?.remoteJidAlt ||
					rawMsg?.key?.participantAlt ||
					rawMsg?.remoteJidAlt,
			);
			const candidates = [
				...new Set([rawRemote, rawRemoteAlt, quoteSourceJid].filter(Boolean)),
			];
			for (const remoteCandidate of [...candidates]) {
				try {
					const [primary, alternate] =
						await this.hydrateJidPair(remoteCandidate);
					[primary, alternate]
						.map((entry) => this.formatJid(entry))
						.forEach((entry) => {
							if (entry && !candidates.includes(entry)) candidates.push(entry);
						});
				} catch (err) {
					state.logger?.debug?.(
						{ err },
						"Failed to hydrate quote remote candidate",
					);
				}
			}
			for (const remoteJid of candidates) {
				const stored = messageStore.get({ remoteJid, id: quoteId });
				if (stored) return stored;
			}
			return null;
		};

		if (!qMsg && !quoteId) return null;

		const quoteNameFromParticipant = async () => {
			const [primary, alternate] = await this.hydrateJidPair(
				quoteParticipant,
				quoteParticipantAlt,
			);
			const resolved =
				this.resolveKnownJid(
					primary,
					alternate,
					quoteParticipant,
					quoteParticipantAlt,
				) ||
				primary ||
				alternate ||
				quoteParticipant ||
				quoteParticipantAlt ||
				"";
			return this.jidToName(resolved);
		};

		const quoteNameFromStore = async () => {
			const stored = await getStoredQuoteMessage();
			if (stored) {
				return this.getSenderName(stored);
			}
			return null;
		};

		if (!qMsg) {
			const stored = await getStoredQuoteMessage();
			let content = "";
			if (stored) {
				const storedType = this.getMessageType(stored);
				if (storedType) {
					const [storedInnerType, storedMessage] = this.getMessage(
						stored,
						storedType,
					);
					const parsed = await this.getContent(
						storedMessage,
						storedInnerType,
						storedType,
						{ mentionTarget: "name" },
					);
					content = parsed?.content || "";
				}
			}
			const quote = {
				name:
					(await quoteNameFromStore()) || (await quoteNameFromParticipant()),
				content,
				file: null,
			};
			if (quoteId) quote.id = quoteId;
			if (quoteSourceJid) quote.sourceJid = quoteSourceJid;
			return quote;
		}

		const qMsgType = this.getMessageType({ message: qMsg });
		const [nMsgType, message] = this.getMessage({ message: qMsg }, qMsgType);
		const { content } = await this.getContent(message, nMsgType, qMsgType, {
			mentionTarget: "name",
		});

		const quoteName =
			(await quoteNameFromStore()) || (await quoteNameFromParticipant());
		let file = null;
		if (qMsgType && quoteId) {
			const quoteDownloadParticipant = this.formatJid(
				context?.participant ||
					context?.participantAlt ||
					context?.placeholderKey?.participant,
			);
			if (context?.participant && context?.participantAlt) {
				this.migrateLegacyJid(context.participantAlt, context.participant);
			}
			const downloadCtx = {
				key: {
					remoteJid:
						quoteSourceJid ||
						(await this.getChannelJid(rawMsg)) ||
						rawMsg.key.remoteJid,
					id: quoteId,
					fromMe: rawMsg.key.fromMe,
					participant: quoteDownloadParticipant,
				},
				message: qMsg,
			};
			file = await this.getFile(downloadCtx, qMsgType);
		}

		const quote = {
			name: quoteName,
			content,
			file,
		};

		if (quoteId) quote.id = quoteId;
		if (quoteSourceJid) quote.sourceJid = quoteSourceJid;

		return quote;
	},
	getMessage(rawMsg, msgType) {
		if (msgType === "documentWithCaptionMessage") {
			return [
				"documentMessage",
				rawMsg.message[msgType].message.documentMessage,
			];
		} else if (isWhatsAppViewOnceMessageType(msgType)) {
			const nMsgType = this.getMessageType(rawMsg.message[msgType]);
			return [nMsgType, rawMsg.message[msgType].message[nMsgType]];
		} else if (msgType === "editedMessage") {
			const nMsgType = this.getMessageType({
				message: rawMsg.message[msgType].message.protocolMessage.editedMessage,
			});
			return [
				nMsgType,
				rawMsg.message[msgType].message.protocolMessage.editedMessage[nMsgType],
			];
		}
		return [msgType, rawMsg.message[msgType]];
	},
	getFilename(msg, msgType) {
		if (msgType === "audioMessage") {
			return "audio.ogg";
		} else if ("documentMessage" === msgType) {
			return msg.fileName;
		}
		const ext = msg.mimetype?.split("/")?.[1] || "bin";
		return `${msgType}.${ext}`;
	},
	async getFile(rawMsg, msgType) {
		const [nMsgType, msg] = this.getMessage(rawMsg, msgType);
		if (msg.fileLength == null) return;
		const remoteJid = this.formatJid(
			rawMsg?.key?.remoteJid ||
				rawMsg?.chatId ||
				rawMsg?.attrs?.from ||
				rawMsg?.remoteJid,
		);
		const isNewsletter =
			typeof remoteJid === "string" && remoteJid.endsWith("@newsletter");
		const hasMediaPath = Boolean(
			msg?.url || msg?.directPath || msg?.direct_path,
		);
		const mediaKeyLength = (() => {
			const mediaKey = msg?.mediaKey;
			if (!mediaKey) return 0;
			if (typeof mediaKey === "string") return mediaKey.length;
			if (Buffer.isBuffer(mediaKey) || mediaKey instanceof Uint8Array)
				return mediaKey.length;
			if (Array.isArray(mediaKey)) return mediaKey.length;
			if (typeof mediaKey === "object") {
				if (Array.isArray(mediaKey.data)) return mediaKey.data.length;
				if (typeof mediaKey.length === "number") return mediaKey.length;
				if (typeof mediaKey.byteLength === "number") return mediaKey.byteLength;
			}
			return 0;
		})();
		if (isNewsletter && hasMediaPath && mediaKeyLength === 0) {
			state.logger?.warn?.(
				{
					jid: remoteJid,
					id: this.getId(rawMsg),
					msgType: nMsgType,
				},
				"Skipping newsletter media download because media key is missing",
			);
			return null;
		}
		const fileLength =
			typeof msg.fileLength === "object"
				? (msg.fileLength.low ?? msg.fileLength.toNumber())
				: msg.fileLength;
		const largeFile = fileLength > state.settings.DiscordFileSizeLimit;
		if (largeFile && !state.settings.LocalDownloads) return -1;
		try {
			const baseName = this.getFilename(msg, nMsgType);
			const viewOnce = isWhatsAppViewOnceMediaMessage(rawMsg, msgType, msg);
			const fileName = viewOnce ? asDiscordSpoilerFileName(baseName) : baseName;
			if (largeFile && state.settings.LocalDownloads) {
				return {
					name: fileName,
					downloadCtx: rawMsg,
					msgType: nMsgType,
					largeFile: true,
					spoiler: viewOnce,
				};
			}
			if (nMsgType === "videoMessage" && msg.gifPlayback) {
				const attachmentBuffer = Buffer.from(
					await downloadMediaMessage(
						rawMsg,
						"buffer",
						{},
						{
							logger: state.logger,
							reuploadRequest: state.waClient.updateMediaMessage,
						},
					),
				);
				const normalizedGif = await normalizeWhatsAppGifFileForDiscord({
					attachmentBuffer,
					fileName: baseName,
					mimetype: msg.mimetype,
					jid: remoteJid,
					messageId: this.getId(rawMsg),
				});
				return {
					name: viewOnce
						? asDiscordSpoilerFileName(normalizedGif.fileName)
						: normalizedGif.fileName,
					attachment: normalizedGif.attachmentBuffer,
					contentType: normalizedGif.contentType,
					largeFile,
					downloadCtx: rawMsg,
					msgType: nMsgType,
					spoiler: viewOnce,
				};
			}
			if (
				nMsgType === "audioMessage" &&
				state.settings.WhatsAppAudioConversionFormat === "mp3"
			) {
				const attachmentBuffer = Buffer.from(
					await downloadMediaMessage(
						rawMsg,
						"buffer",
						{},
						{
							logger: state.logger,
							reuploadRequest: state.waClient.updateMediaMessage,
						},
					),
				);
				const normalizedAudio = await normalizeWhatsAppAudioFileForDiscord({
					attachmentBuffer,
					fileName: baseName,
					mimetype: msg.mimetype,
					targetFormat: state.settings.WhatsAppAudioConversionFormat,
					jid: remoteJid,
					messageId: this.getId(rawMsg),
					maxBytes: state.settings.DiscordFileSizeLimit,
				});
				return {
					name: viewOnce
						? asDiscordSpoilerFileName(normalizedAudio.fileName)
						: normalizedAudio.fileName,
					attachment: normalizedAudio.attachmentBuffer,
					contentType: normalizedAudio.contentType,
					largeFile,
					downloadCtx: rawMsg,
					msgType: nMsgType,
					spoiler: viewOnce,
				};
			}
			return {
				name: fileName,

				attachment: await downloadMediaMessage(
					rawMsg,
					"stream",
					{},
					{
						logger: state.logger,
						reuploadRequest: state.waClient.updateMediaMessage,
					},
				),
				largeFile,
				downloadCtx: rawMsg,
				msgType: nMsgType,
				spoiler: viewOnce,
			};
		} catch (err) {
			if (
				err?.message?.includes("Unrecognised filter type") ||
				err?.message?.includes("Unrecognized filter type")
			) {
				state.logger?.warn(
					"Skipped sending attachment due to an invalid PNG file",
				);
			} else {
				state.logger?.error(err);
			}
			return null;
		}
	},
	inWhitelist(rawMsg) {
		const whitelist = state.settings.Whitelist || [];
		if (!whitelist.length) return true;
		const normalized = whitelist
			.map((jid) => this.formatJid(jid))
			.filter(Boolean);
		const candidates = this.getChatJidCandidates(rawMsg);
		return candidates.some((jid) => normalized.includes(jid));
	},
	getTimestamp(rawMsg) {
		if (rawMsg?.messageTimestamp) return rawMsg.messageTimestamp;
		if (rawMsg?.reaction?.senderTimestampMs)
			return Math.round(rawMsg.reaction.senderTimestampMs / 1000);
		if (rawMsg?.date) return Math.round(rawMsg.date.getTime() / 1000);
		return 0;
	},
	sentAfterStart(rawMsg) {
		const ts = this.getTimestamp(rawMsg);
		const id = this.getId(rawMsg);
		return (
			ts > state.startTime ||
			id == null ||
			!Object.hasOwn(state.lastMessages, id)
		);
	},
	getMessageType(rawMsg) {
		return [
			"conversation",
			"extendedTextMessage",
			"imageMessage",
			"videoMessage",
			"audioMessage",
			"documentMessage",
			"documentWithCaptionMessage",
			"viewOnceMessage",
			"viewOnceMessageV2",
			"viewOnceMessageV2Extension",
			"stickerMessage",
			"editedMessage",
			"pollCreationMessage",
			"pollCreationMessageV2",
			"pollCreationMessageV3",
			"pollCreationMessageV4",
			"pollUpdateMessage",
			"pollResultSnapshotMessage",
			"pinInChatMessage",
		].find((el) => Object.hasOwn(rawMsg.message || {}, el));
	},
	_profilePicsCache: {},
	async getProfilePic(rawMsg) {
		const jid = await this.getSenderJid(rawMsg, rawMsg?.key?.fromMe);
		if (this._profilePicsCache[jid] === undefined) {
			this._profilePicsCache[jid] = await state.waClient
				.profilePictureUrl(jid, "preview")
				.catch(() => null);
		}
		return this._profilePicsCache[jid];
	},
	getId(rawMsg) {
		return (
			rawMsg?.message?.editedMessage?.message?.protocolMessage?.key?.id ||
			rawMsg?.key?.server_id ||
			rawMsg?.key?.serverId ||
			rawMsg?.key?.newsletterServerId ||
			rawMsg?.key?.newsletter_server_id ||
			rawMsg?.messageServerID ||
			rawMsg?.server_id ||
			rawMsg?.serverId ||
			rawMsg?.newsletterServerId ||
			rawMsg?.newsletter_server_id ||
			rawMsg?.message?.newsletterServerId ||
			rawMsg?.message?.newsletter_server_id ||
			rawMsg?.key?.id ||
			rawMsg?.id
		);
	},
	async getContent(msg, nMsgType, msgType, { mentionTarget = "name" } = {}) {
		let content = "";
		const discordMentions = new Set();
		let discordMentionEveryone = false;
		if (isWhatsAppViewOnceMessageType(msgType)) {
			content += "View once message:\n";
		}
		if (msg == null) {
			return { content, discordMentions: [], discordMentionEveryone };
		}
		switch (nMsgType) {
			case "conversation":
				content += msg;
				break;
			case "extendedTextMessage":
				content += msg.text;
				break;
			case "imageMessage":
			case "videoMessage":
			case "audioMessage":
			case "documentMessage":
			case "documentWithCaptionMessage":
			case "stickerMessage":
				content += msg.caption || "";
				break;
			case "pollCreationMessage":
			case "pollCreationMessageV2":
			case "pollCreationMessageV3":
			case "pollCreationMessageV4": {
				const options = Array.isArray(msg.options) ? msg.options : [];
				const optionText = options
					.map((opt, idx) => `${idx + 1}. ${opt.optionName || "Option"}`)
					.join("\n");
				const selectable = msg.selectableOptionsCount || msg.selectableCount;
				content += `Poll: ${msg.name || "Untitled poll"}`;
				if (selectable && selectable > 1) {
					content += ` (select up to ${selectable})`;
				}
				if (optionText) {
					content += `\n${optionText}`;
				}
				break;
			}
			case "pinInChatMessage":
				content += "Pinned a message";
				break;
		}
		const contextInfo =
			typeof msg === "object" && msg !== null ? msg.contextInfo : undefined;
		const mentions = contextInfo?.mentionedJid || [];
		const links = state.settings?.WhatsAppDiscordMentionLinks;
		const hasLinks = links && typeof links === "object";
		const nonJidMentionCount = Number(contextInfo?.nonJidMentions || 0);
		const hasWhatsAppMentionAll =
			Number.isFinite(nonJidMentionCount) && nonJidMentionCount > 0;

		if (mentionTarget === "discord" && hasWhatsAppMentionAll) {
			const nextContent = content.replace(
				WHATSAPP_MENTION_ALL_REGEX,
				"@everyone",
			);
			if (nextContent !== content) {
				content = nextContent;
				discordMentionEveryone = true;
			}
		}

		const resolveLinkedDiscordUserId = async (jid) => {
			if (!hasLinks) return null;
			const formatted = this.formatJid(jid);
			if (!formatted) return null;

			const normalizeNameForMatch = (value) => {
				if (typeof value !== "string") return null;
				const trimmed = value.trim();
				if (!trimmed) return null;
				return trimmed.normalize("NFKC").toLowerCase().replace(/\s+/g, " ");
			};

			const getStoredContactName = (candidateJid) => {
				const normalized = this.formatJid(candidateJid);
				if (!normalized) return null;
				const stored =
					state.contacts?.[normalized] ||
					state.waClient?.contacts?.[normalized];
				const normalizedName = normalizeNameForMatch(stored);
				if (!normalizedName) return null;
				if (isUnknownOrSelfDisplayName(normalizedName)) return null;
				if (/^\d+$/.test(normalizedName)) return null;
				return normalizedName;
			};

			const lookup = (candidate) => {
				if (!candidate) return null;
				return normalizeDiscordUserId(links[candidate]);
			};

			const lookupCandidates = (candidate) => {
				const normalized = this.formatJid(candidate);
				if (!normalized) return [];
				const [userPart, serverPart] = normalized.split("@");
				const candidates = [normalized];
				if (
					(serverPart === "s.whatsapp.net" || serverPart === "lid") &&
					/^\d+$/.test(userPart)
				) {
					candidates.push(`+${userPart}@${serverPart}`);
				}
				return [...new Set(candidates)];
			};

			const tryLookup = (candidate) => {
				for (const key of lookupCandidates(candidate)) {
					const found = lookup(key);
					if (found)
						return { discordUserId: found, keys: lookupCandidates(candidate) };
				}
				return null;
			};

			const direct = tryLookup(formatted);
			if (direct)
				return {
					discordUserId: direct.discordUserId,
					jids: [formatted, ...direct.keys],
				};

			const [primary, alternate] = await this.hydrateJidPair(formatted, null);
			const resolved = this.resolveKnownJid(primary, alternate);
			const resolvedCandidate = resolved || primary || alternate;
			const found =
				tryLookup(resolvedCandidate) ||
				tryLookup(primary) ||
				tryLookup(alternate);
			const jids = [formatted, primary, alternate, resolved].filter(Boolean);
			if (found)
				return {
					discordUserId: found.discordUserId,
					jids: [...jids, ...found.keys],
				};
			const mentionName =
				getStoredContactName(formatted) ||
				getStoredContactName(resolvedCandidate) ||
				getStoredContactName(primary) ||
				getStoredContactName(alternate);
			if (!mentionName) return null;

			const matchingKeys = [];
			const candidateDiscordIds = new Set();
			for (const [linkJid, discordIdRaw] of Object.entries(links)) {
				const discordUserId = normalizeDiscordUserId(discordIdRaw);
				if (!discordUserId) continue;
				const linkName = getStoredContactName(linkJid);
				if (!linkName) continue;
				if (linkName !== mentionName) continue;
				matchingKeys.push(linkJid);
				candidateDiscordIds.add(discordUserId);
			}
			if (candidateDiscordIds.size !== 1) return null;

			return {
				discordUserId: [...candidateDiscordIds][0],
				jids: [...new Set([...jids, ...matchingKeys].filter(Boolean))],
			};
		};

		const normalizeMentionName = (value, { allowPhone = true } = {}) => {
			if (typeof value !== "string") return null;
			const trimmed = value.trim();
			if (!trimmed || isUnknownOrSelfDisplayName(trimmed)) return null;
			if (!allowPhone && this.isPhoneLike(trimmed)) return null;
			return trimmed;
		};

		const getDiscordNameForUserId = (discordUserId) => {
			const normalized = normalizeDiscordUserId(discordUserId);
			if (!normalized) return null;
			const guildId =
				typeof state.settings?.GuildID === "string"
					? state.settings.GuildID.trim()
					: "";
			const guild = guildId
				? state.dcClient?.guilds?.cache?.get(guildId)
				: null;
			const member = guild?.members?.cache?.get(normalized);
			const memberName = normalizeMentionName(member?.displayName, {
				allowPhone: false,
			});
			if (memberName) return memberName;
			const user =
				member?.user || state.dcClient?.users?.cache?.get(normalized);
			return (
				normalizeMentionName(user?.globalName, { allowPhone: false }) ||
				normalizeMentionName(user?.username, { allowPhone: false }) ||
				null
			);
		};

		const resolveBestMentionName = (
			jidCandidates,
			linkedDiscordUserId = null,
		) => {
			const normalizedCandidates = [
				...new Set(
					(Array.isArray(jidCandidates) ? jidCandidates : [jidCandidates])
						.map((candidate) => this.formatJid(candidate))
						.filter(Boolean),
				),
			];

			if (linkedDiscordUserId) {
				const discordName = getDiscordNameForUserId(linkedDiscordUserId);
				if (discordName) return discordName;
			}

			for (const candidate of normalizedCandidates) {
				const display = normalizeMentionName(this.jidToName(candidate), {
					allowPhone: false,
				});
				if (display) return display;
			}

			for (const candidate of normalizedCandidates) {
				const fallback = normalizeMentionName(this.jidToName(candidate));
				if (fallback) return fallback;
			}

			const phoneFallback = normalizedCandidates
				.map((candidate) => this.jidToPhone(candidate))
				.find(Boolean);
			return phoneFallback || UNKNOWN_DISPLAY_NAME;
		};

		const trailingMentions = new Set();

		for (const jid of mentions) {
			const formattedMentionJid = this.formatJid(jid);
			if (!formattedMentionJid) continue;

			const linked = await resolveLinkedDiscordUserId(formattedMentionJid);
			const [primary, alternate] = await this.hydrateJidPair(
				formattedMentionJid,
				null,
			);
			const resolved =
				this.resolveKnownJid(primary, alternate) ||
				primary ||
				alternate ||
				formattedMentionJid;
			const tokenCandidates = [
				...new Set(
					[
						formattedMentionJid,
						primary,
						alternate,
						resolved,
						...(Array.isArray(linked?.jids) ? linked.jids : []),
					].filter(Boolean),
				),
			];

			let replacement = `@${resolveBestMentionName(
				tokenCandidates,
				mentionTarget === "name" ? linked?.discordUserId : null,
			)}`;
			const nameToken = resolveBestMentionName(tokenCandidates);
			let shouldAppendIfNotFound = false;

			if (mentionTarget === "discord" && linked?.discordUserId) {
				discordMentions.add(linked.discordUserId);
				replacement = `<@${linked.discordUserId}>`;
				shouldAppendIfNotFound = true;
			}

			const mentionTokens = [
				...new Set(
					tokenCandidates
						.map((candidate) => this.jidToPhone(candidate))
						.filter(Boolean),
				),
			];
			const mentionTextCandidates = new Set();
			for (const token of mentionTokens) {
				if (!token) continue;
				mentionTextCandidates.add(token);
				if (/^\d+$/.test(token)) mentionTextCandidates.add(`+${token}`);
			}
			if (typeof nameToken === "string") {
				const trimmed = nameToken.trim();
				if (trimmed && !isUnknownOrSelfDisplayName(trimmed))
					mentionTextCandidates.add(trimmed);
			}

			let replaced = false;
			for (const token of mentionTextCandidates) {
				const regex = buildWordBoundaryMentionRegex(token);
				const next = content.replace(regex, replacement);
				if (next === content) continue;
				content = next;
				replaced = true;
			}
			if (!replaced && shouldAppendIfNotFound) {
				trailingMentions.add(replacement);
			}
		}

		if (mentionTarget === "discord" && trailingMentions.size) {
			const suffix = [...trailingMentions].join(" ");
			content = content ? `${content} ${suffix}` : suffix;
		}

		return {
			content,
			discordMentions: [...discordMentions],
			discordMentionEveryone,
		};
	},
	updateContacts(rawContacts) {
		const contacts = rawContacts.chats || rawContacts.contacts || rawContacts;
		for (const contact of contacts) {
			const nameCandidates = [
				{ value: contact?.subject, rank: 0 },
				{ value: contact?.name, rank: 0 },
				{ value: contact?.verifiedName, rank: 1 },
				{ value: contact?.notify, rank: 2 },
				{ value: contact?.pushName, rank: 3 },
			];
			const normalizeCandidateName = (value) => {
				if (typeof value !== "string") return null;
				const trimmed = value.trim();
				return trimmed ? trimmed : null;
			};
			const selectedName = nameCandidates
				.map((entry) => ({
					...entry,
					normalized: normalizeCandidateName(entry.value),
				}))
				.find((entry) => entry.normalized);
			if (!selectedName) continue;
			const name = selectedName.normalized;
			const id = this.formatJid(contact?.id);
			const pnFromField = contact?.phoneNumber
				? this.formatJid(`${contact.phoneNumber}@s.whatsapp.net`)
				: null;
			const pnFromId = id && this.isPhoneJid(id) ? id : null;
			const lidFromField = contact?.lid ? this.formatJid(contact.lid) : null;
			const lidFromId = id && this.isLidJid(id) ? id : null;

			const pnJid = pnFromField || pnFromId;
			const lidJid = lidFromField || lidFromId;

			const preferredId = pnJid || id || lidJid;
			const alternateId =
				preferredId === pnJid
					? lidJid && lidJid !== preferredId
						? lidJid
						: id && id !== preferredId
							? id
							: null
					: pnJid && pnJid !== preferredId
						? pnJid
						: lidJid && lidJid !== preferredId
							? lidJid
							: null;

			if (
				preferredId &&
				alternateId &&
				this.isPhoneJid(preferredId) &&
				this.isLidJid(alternateId)
			) {
				this.migrateLegacyJid(alternateId, preferredId);
			}

			const targetId = preferredId || alternateId;
			if (!targetId) continue;

			const applyNameUpdate = (jid) => {
				if (!jid) return;
				const existingName = state.contacts[jid];
				const existingFallback =
					typeof existingName === "string" && /^\d+$/.test(existingName.trim());
				const shouldOverwrite =
					!existingName || existingFallback || selectedName.rank <= 1;
				if (!shouldOverwrite) return;
				state.contacts[jid] = name;
				if (state.waClient?.contacts) {
					state.waClient.contacts[jid] = name;
				}
			};

			applyNameUpdate(targetId);
			if (alternateId && alternateId !== targetId) {
				applyNameUpdate(alternateId);
			}
		}
	},
	createDocumentContent(attachment) {
		const mimetype =
			attachment.contentType?.split(";")?.[0] || "application/octet-stream";
		let contentType = mimetype.split("/")?.[0] || "application";
		contentType = ["image", "video", "audio"].includes(contentType)
			? contentType
			: "document";
		const documentContent = {};
		documentContent.mimetype = mimetype;
		documentContent[contentType] = { url: attachment.url };
		if (contentType === "document") {
			documentContent.fileName = attachment.name;
		}
		if (contentType === "video" && attachment.gifPlayback) {
			documentContent.gifPlayback = true;
		}
		if (attachment.name.toLowerCase().endsWith(".ogg")) {
			documentContent.ptt = true;
		}
		return documentContent;
	},
	async createQuoteMessage(message, jid) {
		const { channelId, messageId } = message.reference || {};
		if (!channelId || !messageId) return null;
		const normalizedChatJid = this.formatJid(jid);
		if (!normalizedChatJid) return null;

		try {
			const channel = await message.client.channels.fetch(channelId);
			const refMessage = await channel.messages.fetch(messageId);
			const mappedWaId = state.lastMessages[refMessage.id];

			if (typeof mappedWaId !== "string" || !mappedWaId) return null;

			const candidates = new Set([normalizedChatJid]);
			try {
				const [primary, alternate] =
					await this.hydrateJidPair(normalizedChatJid);
				[primary, alternate]
					.map((entry) => this.formatJid(entry))
					.forEach((entry) => {
						if (entry) candidates.add(entry);
					});
			} catch (err) {
				state.logger?.debug?.(
					{ err },
					"Failed to hydrate JID candidates while creating quote message",
				);
			}

			let storedMessage = null;
			for (const remoteJid of candidates) {
				storedMessage = messageStore.get({ remoteJid, id: mappedWaId });
				if (storedMessage) break;
			}

			const storedKey = storedMessage?.key || {};
			const remoteJid =
				this.formatJid(storedKey.remoteJid) || normalizedChatJid;
			if (!remoteJid) return null;

			const fromMe =
				typeof storedKey.fromMe === "boolean"
					? storedKey.fromMe
					: !(refMessage.webhookId && refMessage.author?.username !== "You");
			const key = {
				remoteJid,
				id: mappedWaId,
				fromMe,
			};

			if (remoteJid.endsWith("@g.us")) {
				const participantFromStore = this.formatJid(
					storedKey.participant || storedKey.participantAlt,
				);
				if (participantFromStore) {
					key.participant = participantFromStore;
				} else {
					const participantFallback =
						refMessage.webhookId && refMessage.author?.username !== "You"
							? this.toJid(refMessage.author.username)
							: this.formatJid(state.waClient?.user?.id);
					if (participantFallback) {
						key.participant = participantFallback;
					}
				}
			}

			return {
				key,
				message: {
					conversation: this.convertDiscordFormatting(
						refMessage.content ?? refMessage.cleanContent ?? "",
					),
				},
			};
		} catch (err) {
			state.logger?.error(err);
			return null;
		}
	},

	async deleteSession() {
		await storage.clearAuthState();
		const dir = "./storage/baileys";
		const files = await fs.promises.readdir(dir).catch(() => []);
		for (const file of files) {
			const fullPath = path.join(dir, file);

			await fs.promises
				.rm(fullPath, { recursive: true, force: true })
				.catch(() => {});
		}
	},
};

const requests = {
	async fetchJson(url, options) {
		return fetch(url, options)
			.then((resp) => resp.json())
			.then((result) => ({ result }))
			.catch((error) => {
				state.logger?.error(error);
				return { error };
			});
	},

	async fetchText(url, options) {
		return fetch(url, options)
			.then((resp) => resp.text())
			.then((result) => ({ result }))
			.catch((error) => {
				state.logger?.error(error);
				return { error };
			});
	},

	async fetchBuffer(url, options) {
		return fetch(url, options)
			.then((resp) => resp.arrayBuffer())
			.then((buffer) => Buffer.from(buffer))
			.then((result) => ({ result }))
			.catch((error) => {
				state.logger?.error(error);
				return { error };
			});
	},

	async fetchPublicBuffer(url, options) {
		return fetchPreviewBuffer(url, options);
	},

	async downloadFile(path, url, options) {
		const readable = await fetch(url, options)
			.then((resp) => resp.body)
			.catch((error) => {
				state.logger?.error(error);
				return null;
			});
		if (readable == null) return false;

		return pipeline(readable, fs.createWriteStream(path))
			.then(() => true)
			.catch((error) => {
				state.logger?.error(error);
				return false;
			});
	},
};

const ui = {
	async input(query) {
		return new Promise((resolve) => {
			const rl = readline.createInterface({
				input: process.stdin,
				output: process.stdout,
			});
			rl.question(query, (answer) => {
				resolve(answer);
				rl.close();
			});
		});
	},
};

const utils = {
	updater,
	discord,
	requests,
	whatsapp,
	sqliteToJson,
	ensureDownloadServer,
	stopDownloadServer,
};

export default utils;
