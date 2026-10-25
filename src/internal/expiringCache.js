import { performance } from "node:perf_hooks";

export class ExpiringCache {
	constructor(ttlMs, { now = () => performance.now() } = {}) {
		this.ttlMs = ttlMs;
		this.now = now;
		this.entries = new Map();
		this.timer = null;
	}

	get size() {
		return this.entries.size;
	}

	get(key) {
		const entry = this.entries.get(key);
		if (!entry) return undefined;
		if (entry.expiresAt <= this.now()) {
			this.delete(key);
			return undefined;
		}
		return entry.value;
	}

	has(key) {
		const entry = this.entries.get(key);
		if (!entry) return false;
		if (entry.expiresAt <= this.now()) {
			this.delete(key);
			return false;
		}
		return true;
	}

	set(key, value) {
		if (!key) return this;
		const normalizedKey = String(key);
		this.entries.delete(normalizedKey);
		this.entries.set(normalizedKey, {
			value,
			expiresAt: this.now() + this.ttlMs,
		});
		this.schedule();
		return this;
	}

	delete(key) {
		if (!key) return false;
		const deleted = this.entries.delete(String(key));
		if (!this.entries.size) this.clear();
		return deleted;
	}

	clear() {
		clearTimeout(this.timer);
		this.timer = null;
		this.entries.clear();
	}

	schedule() {
		if (this.timer || !this.entries.size) return;
		const first = this.entries.values().next().value;
		const delay = Math.max(1, Math.ceil(first.expiresAt - this.now()));
		this.timer = setTimeout(() => {
			this.timer = null;
			const now = this.now();
			for (const [key, entry] of this.entries) {
				if (entry.expiresAt > now) break;
				this.entries.delete(key);
			}
			this.schedule();
		}, delay);
		this.timer.unref();
	}
}
