const normalizeDiscordChannelId = (value) => {
	if (value == null) return null;
	const trimmed = String(value).trim();
	return trimmed ? trimmed : null;
};

export const normalizeChatLink = (rawLink = {}) => {
	if (typeof rawLink === "string") {
		const channelId = normalizeDiscordChannelId(rawLink);
		return channelId ? { channelId } : null;
	}
	if (!rawLink || typeof rawLink !== "object" || Array.isArray(rawLink)) {
		return null;
	}

	const normalized = { ...rawLink };
	const id = normalizeDiscordChannelId(rawLink.id);
	const token = normalizeDiscordChannelId(rawLink.token);
	const channelId = normalizeDiscordChannelId(rawLink.channelId);
	const threadId = normalizeDiscordChannelId(rawLink.threadId);

	if (id) normalized.id = id;
	else delete normalized.id;

	if (token) normalized.token = token;
	else delete normalized.token;

	if (channelId) normalized.channelId = channelId;
	else delete normalized.channelId;

	if (threadId) normalized.threadId = threadId;
	else delete normalized.threadId;

	return normalized;
};

export const normalizeChatLinks = (rawLinks = {}) => {
	if (!rawLinks || typeof rawLinks !== "object" || Array.isArray(rawLinks)) {
		return {};
	}

	return Object.fromEntries(
		Object.entries(rawLinks)
			.map(([jid, rawLink]) => [jid, normalizeChatLink(rawLink)])
			.filter(([, link]) => link != null),
	);
};

export const getChatHostChannelId = (chatLink = {}) =>
	normalizeDiscordChannelId(chatLink?.channelId);

export const getChatTargetChannelId = (chatLink = {}) =>
	normalizeDiscordChannelId(chatLink?.threadId) ||
	normalizeDiscordChannelId(chatLink?.channelId);

export const isThreadChatLink = (chatLink = {}) =>
	getChatTargetChannelId(chatLink) != null &&
	getChatHostChannelId(chatLink) != null &&
	getChatTargetChannelId(chatLink) !== getChatHostChannelId(chatLink);

export const chatTargetsChannelId = (chatLink = {}, channelId) =>
	getChatTargetChannelId(chatLink) === normalizeDiscordChannelId(channelId);

export const chatUsesHostChannelId = (chatLink = {}, channelId) =>
	getChatHostChannelId(chatLink) === normalizeDiscordChannelId(channelId);
