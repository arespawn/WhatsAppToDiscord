import state from "./state.js";

const NEWSLETTER_ACK_ERROR_TTL_MS = 30 * 1000;
const DEFAULT_NEWSLETTER_ACK_WAIT_MS = 1200;
const NEWSLETTER_PENDING_SEND_TTL_MS = 2 * 60 * 1000;
const NEWSLETTER_PENDING_SEND_FALLBACK_WINDOW_MS = 20 * 1000;
const NEWSLETTER_PENDING_SEND_MAX_PER_JID = 64;
const NEWSLETTER_MESSAGE_DEBUG_TTL_MS = 30 * 60 * 1000;
const NEWSLETTER_MESSAGE_DEBUG_MAX_PER_MESSAGE = 50;

const newsletterAckErrors = new Map();
const newsletterAckWaiters = new Map();
const newsletterPendingSends = new Map();
const newsletterMessageDebug = new Map();
let newsletterPruneTimer = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const normalizeBridgeMessageId = (value) => {
	if (typeof value === "string") return value.trim();
	if (typeof value === "number") return String(value);
	return String(value || "").trim();
};

const BAILEYS_OUTBOUND_MESSAGE_ID_REGEX = /^3E[A-F0-9]{20,}$/i;

const isLikelyNewsletterServerId = (value) => {
	const normalized = normalizeBridgeMessageId(value);
	if (!normalized) return false;
	if (BAILEYS_OUTBOUND_MESSAGE_ID_REGEX.test(normalized)) {
		return false;
	}
	return true;
};

const getNewsletterServerIdFromMessage = (message) => {
	const candidates = [
		message?.key?.server_id,
		message?.key?.serverId,
		message?.key?.newsletterServerId,
		message?.key?.newsletter_server_id,
		message?.messageServerID,
		message?.server_id,
		message?.serverId,
		message?.newsletterServerId,
		message?.newsletter_server_id,
		message?.message?.newsletterServerId,
		message?.message?.newsletter_server_id,
	];
	for (const candidate of candidates) {
		const normalized = normalizeBridgeMessageId(candidate);
		if (normalized) return normalized;
	}
	return null;
};

const normalizeSignatureText = (value) => {
	if (typeof value !== "string") {
		return "";
	}
	return value.replace(/\s+/g, " ").trim().slice(0, 512);
};

const buildOutgoingNewsletterContentShape = (content = {}) => {
	if (!content || typeof content !== "object") {
		return null;
	}
	if (typeof content.text === "string") {
		return {
			type: "text",
			text: normalizeSignatureText(content.text),
		};
	}
	if (content.image) {
		return {
			type: "image",
			text: normalizeSignatureText(content.caption || ""),
		};
	}
	if (content.video) {
		return {
			type: "video",
			text: normalizeSignatureText(content.caption || ""),
		};
	}
	if (content.audio) {
		return {
			type: "audio",
			text: "",
		};
	}
	if (content.document) {
		return {
			type: "document",
			text: normalizeSignatureText(content.caption || ""),
		};
	}
	return null;
};

const unwrapIncomingMessage = (rawMessage = {}) => {
	let message = rawMessage?.message || rawMessage;
	let guard = 0;
	while (message && guard < 5) {
		guard += 1;
		if (message.ephemeralMessage?.message) {
			message = message.ephemeralMessage.message;
			continue;
		}
		if (message.viewOnceMessage?.message) {
			message = message.viewOnceMessage.message;
			continue;
		}
		if (message.viewOnceMessageV2?.message) {
			message = message.viewOnceMessageV2.message;
			continue;
		}
		if (message.viewOnceMessageV2Extension?.message) {
			message = message.viewOnceMessageV2Extension.message;
			continue;
		}
		if (message.documentWithCaptionMessage?.message) {
			message = message.documentWithCaptionMessage.message;
			continue;
		}
		break;
	}
	return message || {};
};

const buildIncomingNewsletterMessageShape = (rawMessage = {}) => {
	const message = unwrapIncomingMessage(rawMessage);
	if (typeof message?.conversation === "string") {
		return {
			type: "text",
			text: normalizeSignatureText(message.conversation),
		};
	}
	if (typeof message?.extendedTextMessage?.text === "string") {
		return {
			type: "text",
			text: normalizeSignatureText(message.extendedTextMessage.text),
		};
	}
	if (message?.imageMessage) {
		return {
			type: "image",
			text: normalizeSignatureText(message.imageMessage.caption || ""),
		};
	}
	if (message?.videoMessage) {
		return {
			type: "video",
			text: normalizeSignatureText(message.videoMessage.caption || ""),
		};
	}
	if (message?.audioMessage) {
		return {
			type: "audio",
			text: "",
		};
	}
	if (message?.documentMessage) {
		return {
			type: "document",
			text: normalizeSignatureText(message.documentMessage.caption || ""),
		};
	}
	return null;
};

const prunePendingNewsletterSends = (jid = "") => {
	const cutoff = Date.now() - NEWSLETTER_PENDING_SEND_TTL_MS;
	const normalizedJid = normalizeBridgeMessageId(jid);
	const keys = normalizedJid
		? [normalizedJid]
		: [...newsletterPendingSends.keys()];
	for (const key of keys) {
		const existing = newsletterPendingSends.get(key);
		if (!Array.isArray(existing) || !existing.length) {
			newsletterPendingSends.delete(key);
			continue;
		}
		const next = existing.filter(
			(entry) =>
				entry &&
				typeof entry === "object" &&
				typeof entry.timestamp === "number" &&
				entry.timestamp >= cutoff,
		);
		if (next.length) {
			newsletterPendingSends.set(key, next);
		} else {
			newsletterPendingSends.delete(key);
		}
	}
};

const notePendingNewsletterSend = ({
	jid,
	discordMessageId,
	outboundId = null,
	content = null,
} = {}) => {
	const normalizedJid = normalizeBridgeMessageId(jid);
	const normalizedDiscordMessageId = normalizeBridgeMessageId(discordMessageId);
	const normalizedOutboundId = normalizeBridgeMessageId(outboundId);
	if (!normalizedJid || !normalizedDiscordMessageId) {
		return;
	}
	prunePendingNewsletterSends(normalizedJid);
	const queue = newsletterPendingSends.get(normalizedJid) || [];
	const shape = buildOutgoingNewsletterContentShape(content) || {};
	queue.push({
		discordMessageId: normalizedDiscordMessageId,
		outboundId: normalizedOutboundId || null,
		type: typeof shape.type === "string" ? shape.type : "",
		text: typeof shape.text === "string" ? shape.text : "",
		timestamp: Date.now(),
	});
	while (queue.length > NEWSLETTER_PENDING_SEND_MAX_PER_JID) {
		queue.shift();
	}
	newsletterPendingSends.set(normalizedJid, queue);
	scheduleNewsletterPrune();
};

const getPendingNewsletterSend = ({
	jid = null,
	outboundId = null,
	discordMessageId = null,
} = {}) => {
	const normalizedJid = normalizeBridgeMessageId(jid);
	const normalizedOutboundId = normalizeBridgeMessageId(outboundId);
	const normalizedDiscordMessageId = normalizeBridgeMessageId(discordMessageId);
	const keys = normalizedJid
		? [normalizedJid]
		: [...newsletterPendingSends.keys()];
	prunePendingNewsletterSends(normalizedJid);

	for (const key of keys) {
		const queue = newsletterPendingSends.get(key);
		if (!Array.isArray(queue) || !queue.length) continue;

		if (normalizedOutboundId) {
			const foundByOutbound = queue.find(
				(entry) =>
					normalizeBridgeMessageId(entry?.outboundId) === normalizedOutboundId,
			);
			if (foundByOutbound) {
				return {
					jid: key,
					discordMessageId: normalizeBridgeMessageId(
						foundByOutbound.discordMessageId,
					),
					outboundId: normalizeBridgeMessageId(foundByOutbound.outboundId),
					type:
						typeof foundByOutbound.type === "string"
							? foundByOutbound.type
							: "",
					text:
						typeof foundByOutbound.text === "string"
							? foundByOutbound.text
							: "",
					timestamp: Number(foundByOutbound.timestamp) || 0,
				};
			}
		}

		if (normalizedDiscordMessageId) {
			const foundByDiscordId = queue.find(
				(entry) =>
					normalizeBridgeMessageId(entry?.discordMessageId) ===
					normalizedDiscordMessageId,
			);
			if (foundByDiscordId) {
				return {
					jid: key,
					discordMessageId: normalizeBridgeMessageId(
						foundByDiscordId.discordMessageId,
					),
					outboundId: normalizeBridgeMessageId(foundByDiscordId.outboundId),
					type:
						typeof foundByDiscordId.type === "string"
							? foundByDiscordId.type
							: "",
					text:
						typeof foundByDiscordId.text === "string"
							? foundByDiscordId.text
							: "",
					timestamp: Number(foundByDiscordId.timestamp) || 0,
				};
			}
		}
	}

	return null;
};

const clearPendingNewsletterSends = ({
	jid = null,
	discordMessageId = null,
	outboundId = null,
} = {}) => {
	const normalizedJid = normalizeBridgeMessageId(jid);
	const normalizedDiscordMessageId = normalizeBridgeMessageId(discordMessageId);
	const normalizedOutboundId = normalizeBridgeMessageId(outboundId);
	const keys = normalizedJid
		? [normalizedJid]
		: [...newsletterPendingSends.keys()];

	for (const key of keys) {
		const queue = newsletterPendingSends.get(key);
		if (!Array.isArray(queue) || !queue.length) {
			newsletterPendingSends.delete(key);
			continue;
		}
		const next = queue.filter((entry) => {
			if (!entry || typeof entry !== "object") return false;
			if (
				normalizedDiscordMessageId &&
				entry.discordMessageId === normalizedDiscordMessageId
			) {
				return false;
			}
			if (normalizedOutboundId && entry.outboundId === normalizedOutboundId) {
				return false;
			}
			return true;
		});
		if (next.length) {
			newsletterPendingSends.set(key, next);
		} else {
			newsletterPendingSends.delete(key);
		}
	}
};

const resolvePendingNewsletterSend = ({
	jid,
	serverId,
	message = null,
} = {}) => {
	const normalizedJid = normalizeBridgeMessageId(jid);
	const normalizedServerId = normalizeBridgeMessageId(serverId);
	if (
		!normalizedJid ||
		!normalizedServerId ||
		!isLikelyNewsletterServerId(normalizedServerId)
	) {
		return null;
	}

	prunePendingNewsletterSends(normalizedJid);
	const queue = newsletterPendingSends.get(normalizedJid);
	if (!Array.isArray(queue) || !queue.length) {
		return null;
	}

	const incomingShape = buildIncomingNewsletterMessageShape(message) || {};
	const now = Date.now();
	const withinFallbackWindow = (entry) =>
		typeof entry?.timestamp === "number" &&
		now - entry.timestamp <= NEWSLETTER_PENDING_SEND_FALLBACK_WINDOW_MS;

	const findMatch = (predicate) =>
		queue.findIndex((entry) => {
			if (!entry || typeof entry !== "object") return false;
			return predicate(entry);
		});

	let index = -1;
	if (incomingShape.type && incomingShape.text) {
		index = findMatch(
			(entry) =>
				entry.type === incomingShape.type && entry.text === incomingShape.text,
		);
	}
	if (index < 0 && incomingShape.type) {
		index = findMatch(
			(entry) =>
				entry.type === incomingShape.type && withinFallbackWindow(entry),
		);
	}
	if (index < 0 && incomingShape.text) {
		index = findMatch(
			(entry) =>
				entry.text === incomingShape.text && withinFallbackWindow(entry),
		);
	}
	if (index < 0) {
		index = findMatch((entry) => withinFallbackWindow(entry));
	}

	if (index < 0) {
		return null;
	}
	const [matched] = queue.splice(index, 1);
	if (queue.length) {
		newsletterPendingSends.set(normalizedJid, queue);
	} else {
		newsletterPendingSends.delete(normalizedJid);
	}

	return {
		discordMessageId: normalizeBridgeMessageId(matched?.discordMessageId),
		outboundId: normalizeBridgeMessageId(matched?.outboundId),
		type: matched?.type || "",
	};
};

const resolveNewsletterServerIdForDiscordMessage = (
	discordMessageId,
	fallbackId = null,
	lastMessages = state.lastMessages,
) => {
	const normalizedDiscordMessageId = normalizeBridgeMessageId(discordMessageId);
	const normalizedFallbackId = normalizeBridgeMessageId(fallbackId);
	const directLookup =
		normalizedDiscordMessageId && lastMessages
			? normalizeBridgeMessageId(lastMessages[normalizedDiscordMessageId])
			: "";
	if (isLikelyNewsletterServerId(directLookup)) {
		return directLookup;
	}
	if (isLikelyNewsletterServerId(normalizedFallbackId)) {
		return normalizedFallbackId;
	}
	if (!normalizedDiscordMessageId || !lastMessages) {
		return normalizedFallbackId || null;
	}
	for (const [waId, dcId] of Object.entries(lastMessages)) {
		if (normalizeBridgeMessageId(dcId) !== normalizedDiscordMessageId) continue;
		if (isLikelyNewsletterServerId(waId)) {
			return normalizeBridgeMessageId(waId);
		}
	}
	return normalizedFallbackId || null;
};

const waitForNewsletterServerId = async ({
	discordMessageId,
	candidateId = null,
	timeoutMs = 8000,
	pollMs = 150,
	lastMessages = state.lastMessages,
} = {}) => {
	const immediate = resolveNewsletterServerIdForDiscordMessage(
		discordMessageId,
		candidateId,
		lastMessages,
	);
	if (isLikelyNewsletterServerId(immediate)) {
		return immediate;
	}
	if (!timeoutMs || timeoutMs <= 0) {
		return null;
	}

	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		await sleep(Math.max(1, pollMs));
		const resolved = resolveNewsletterServerIdForDiscordMessage(
			discordMessageId,
			candidateId,
			lastMessages,
		);
		if (isLikelyNewsletterServerId(resolved)) {
			return resolved;
		}
	}
	return null;
};

const pruneNewsletterAckErrors = () => {
	const cutoff = Date.now() - NEWSLETTER_ACK_ERROR_TTL_MS;
	for (const [messageId, payload] of newsletterAckErrors.entries()) {
		if (!payload || payload.timestamp < cutoff) {
			newsletterAckErrors.delete(messageId);
		}
	}
};

const resolveNewsletterAckWaiters = (messageId, errorCode) => {
	const waiters = newsletterAckWaiters.get(messageId);
	if (!waiters?.size) return;
	newsletterAckWaiters.delete(messageId);
	for (const resolve of waiters) {
		try {
			resolve(errorCode);
		} catch {}
	}
};

const noteNewsletterAckError = ({ messageId, jid, errorCode }) => {
	const normalizedMessageId = normalizeBridgeMessageId(messageId);
	if (!normalizedMessageId) return;
	const normalizedError = normalizeBridgeMessageId(errorCode) || "unknown";
	const normalizedJid =
		typeof jid === "string" ? jid.trim() : normalizeBridgeMessageId(jid);
	pruneNewsletterAckErrors();
	newsletterAckErrors.set(normalizedMessageId, {
		errorCode: normalizedError,
		jid: normalizedJid || null,
		timestamp: Date.now(),
	});
	resolveNewsletterAckWaiters(normalizedMessageId, normalizedError);
	scheduleNewsletterPrune();
};

const waitForNewsletterAckError = async (
	messageId,
	timeoutMs = DEFAULT_NEWSLETTER_ACK_WAIT_MS,
) => {
	const normalizedMessageId = normalizeBridgeMessageId(messageId);
	if (!normalizedMessageId) return null;
	pruneNewsletterAckErrors();
	const cached = newsletterAckErrors.get(normalizedMessageId);
	if (cached?.errorCode) {
		return cached.errorCode;
	}
	return await new Promise((resolve) => {
		const existing = newsletterAckWaiters.get(normalizedMessageId) || new Set();
		const settle = (errorCode = null) => {
			clearTimeout(timer);
			existing.delete(settle);
			if (existing.size) {
				newsletterAckWaiters.set(normalizedMessageId, existing);
			} else {
				newsletterAckWaiters.delete(normalizedMessageId);
			}
			resolve(errorCode || null);
		};
		existing.add(settle);
		newsletterAckWaiters.set(normalizedMessageId, existing);
		const timer = setTimeout(() => settle(null), timeoutMs);
		if (typeof timer?.unref === "function") {
			timer.unref();
		}
	});
};

const getNewsletterAckError = (messageId) => {
	const normalizedMessageId = normalizeBridgeMessageId(messageId);
	if (!normalizedMessageId) return null;
	pruneNewsletterAckErrors();
	return newsletterAckErrors.get(normalizedMessageId)?.errorCode || null;
};

const pruneNewsletterMessageDebug = (discordMessageId = null) => {
	const cutoff = Date.now() - NEWSLETTER_MESSAGE_DEBUG_TTL_MS;
	const normalizedDiscordMessageId = normalizeBridgeMessageId(discordMessageId);
	const keys = normalizedDiscordMessageId
		? [normalizedDiscordMessageId]
		: [...newsletterMessageDebug.keys()];
	for (const key of keys) {
		const existing = newsletterMessageDebug.get(key);
		if (!Array.isArray(existing) || !existing.length) {
			newsletterMessageDebug.delete(key);
			continue;
		}
		const next = existing.filter(
			(entry) =>
				entry &&
				typeof entry === "object" &&
				typeof entry.timestamp === "number" &&
				entry.timestamp >= cutoff,
		);
		if (next.length) {
			newsletterMessageDebug.set(key, next);
		} else {
			newsletterMessageDebug.delete(key);
		}
	}
};

const noteNewsletterMessageDebug = ({
	discordMessageId,
	jid = null,
	operation = "",
	phase = "",
	details = {},
} = {}) => {
	const normalizedDiscordMessageId = normalizeBridgeMessageId(discordMessageId);
	if (!normalizedDiscordMessageId) return;
	pruneNewsletterMessageDebug(normalizedDiscordMessageId);
	const queue = newsletterMessageDebug.get(normalizedDiscordMessageId) || [];
	const normalizedJid = normalizeBridgeMessageId(jid) || null;
	const normalizedOperation =
		typeof operation === "string" ? operation.trim() : "";
	const normalizedPhase = typeof phase === "string" ? phase.trim() : "";
	const normalizedDetails =
		details && typeof details === "object" ? details : {};

	queue.push({
		timestamp: Date.now(),
		jid: normalizedJid,
		operation: normalizedOperation,
		phase: normalizedPhase,
		...normalizedDetails,
	});
	while (queue.length > NEWSLETTER_MESSAGE_DEBUG_MAX_PER_MESSAGE) {
		queue.shift();
	}
	newsletterMessageDebug.set(normalizedDiscordMessageId, queue);
	scheduleNewsletterPrune();
};

const getNewsletterMessageDebug = ({
	discordMessageId,
	jid = null,
	limit = 25,
} = {}) => {
	const normalizedDiscordMessageId = normalizeBridgeMessageId(discordMessageId);
	if (!normalizedDiscordMessageId) return [];
	pruneNewsletterMessageDebug(normalizedDiscordMessageId);
	const queue = newsletterMessageDebug.get(normalizedDiscordMessageId) || [];
	const normalizedJid = normalizeBridgeMessageId(jid);
	const filtered = normalizedJid
		? queue.filter(
				(entry) => normalizeBridgeMessageId(entry?.jid) === normalizedJid,
			)
		: queue;
	const boundedLimit = Number.isFinite(limit)
		? Math.max(1, Math.trunc(limit))
		: 25;
	return filtered.slice(-boundedLimit);
};

const scheduleNewsletterPrune = () => {
	if (newsletterPruneTimer) return;
	newsletterPruneTimer = setTimeout(() => {
		newsletterPruneTimer = null;
		prunePendingNewsletterSends();
		pruneNewsletterAckErrors();
		pruneNewsletterMessageDebug();
		if (
			newsletterPendingSends.size ||
			newsletterAckErrors.size ||
			newsletterMessageDebug.size
		) {
			scheduleNewsletterPrune();
		}
	}, NEWSLETTER_ACK_ERROR_TTL_MS);
	newsletterPruneTimer.unref();
};

const resetNewsletterBridgeState = () => {
	clearTimeout(newsletterPruneTimer);
	newsletterPruneTimer = null;
	newsletterAckErrors.clear();
	newsletterAckWaiters.clear();
	newsletterPendingSends.clear();
	newsletterMessageDebug.clear();
};

export {
	clearPendingNewsletterSends,
	getNewsletterAckError,
	getNewsletterMessageDebug,
	getNewsletterServerIdFromMessage,
	getPendingNewsletterSend,
	isLikelyNewsletterServerId,
	normalizeBridgeMessageId,
	noteNewsletterAckError,
	noteNewsletterMessageDebug,
	notePendingNewsletterSend,
	resetNewsletterBridgeState,
	resolveNewsletterServerIdForDiscordMessage,
	resolvePendingNewsletterSend,
	waitForNewsletterAckError,
	waitForNewsletterServerId,
};
