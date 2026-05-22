const GROUP_METADATA_TTL_MS = 5 * 60 * 1000;

const isExpired = (entry) => entry?.expiresAt <= Date.now();

class GroupMetadataCache {
	constructor({ ttlMs = GROUP_METADATA_TTL_MS } = {}) {
		this.ttlMs = ttlMs;
		this.cache = new Map();
	}

	get(jid) {
		if (!jid) return undefined;
		const entry = this.cache.get(jid);
		if (!entry) return undefined;
		if (isExpired(entry)) {
			this.cache.delete(jid);
			return undefined;
		}
		return entry.metadata;
	}

	set(jid, metadata) {
		if (!jid || !metadata) return undefined;
		const expiresAt = Date.now() + this.ttlMs;
		this.cache.set(jid, { metadata, expiresAt });
		return metadata;
	}

	invalidate(jid) {
		if (!jid) return;
		this.cache.delete(jid);
	}

	prune() {
		const now = Date.now();
		for (const [jid, entry] of this.cache.entries()) {
			if (!entry || entry.expiresAt <= now) {
				this.cache.delete(jid);
			}
		}
	}

	clear() {
		this.cache.clear();
	}

	prime(entries = {}) {
		for (const [jid, metadata] of Object.entries(entries || {})) {
			this.set(jid, metadata);
		}
	}
}

const groupMetadataCache = new GroupMetadataCache();

export { GroupMetadataCache };
export default groupMetadataCache;
