import sqliteStore from "./persistence/sqliteStore.js";

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 10000;

const buildKey = (key = {}) => {
	const id = key.id || key?.keyId || null;
	if (!id) return null;
	const remoteJid =
		key.remoteJid || key?.participant || key?.participantId || "";
	return `${remoteJid}|${id}`;
};

class MessageStore {
	constructor({
		ttlMs = DEFAULT_TTL_MS,
		maxEntries = DEFAULT_MAX_ENTRIES,
	} = {}) {
		this.ttlMs = ttlMs;
		this.maxEntries = maxEntries;
		this.cache = {
			clear: () => {
				this.clear();
			},
		};
	}

	get(key) {
		const cacheKey = buildKey(key);
		if (!cacheKey) return null;
		const row = sqliteStore.getMessageStore(cacheKey);
		if (!row) return null;
		try {
			return JSON.parse(row.value);
		} catch {
			return null;
		}
	}

	set(message) {
		const cacheKey = buildKey(message?.key);
		if (!cacheKey || !message) return null;
		const expiresAt = Date.now() + this.ttlMs;
		sqliteStore.setMessageStore(cacheKey, JSON.stringify(message), expiresAt);
		this.prune();
		return message;
	}

	prune() {
		sqliteStore.pruneMessageStore(this.maxEntries);
	}

	clear() {
		sqliteStore.clearMessageStore();
	}
}

const messageStore = new MessageStore();

export default messageStore;
