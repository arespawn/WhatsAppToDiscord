const DEFAULT_DELAY_MS = 750;

const createGroupRefreshScheduler = ({
	refreshFn,
	delayMs = DEFAULT_DELAY_MS,
} = {}) => {
	const timers = new Map();

	const schedule = (jid) => {
		if (!jid || typeof refreshFn !== "function") return;
		const key = String(jid);
		if (timers.has(key)) {
			return;
		}
		const timer = setTimeout(async () => {
			timers.delete(key);
			try {
				await refreshFn(key);
			} catch (err) {
				void err;
			}
		}, delayMs);
		timers.set(key, timer);
	};

	const clearAll = () => {
		for (const timer of timers.values()) {
			clearTimeout(timer);
		}
		timers.clear();
	};

	return { schedule, clearAll, _size: () => timers.size };
};

export { createGroupRefreshScheduler };
