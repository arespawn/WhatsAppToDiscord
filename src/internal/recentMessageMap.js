const DEFAULT_CAPACITY = 1000;

const metadataByMap = new WeakMap();

const normalizeCapacity = (value) => {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return DEFAULT_CAPACITY;
	return Math.max(2, Math.floor(parsed));
};

const toPropertyKey = (value) =>
	typeof value === "symbol" ? value : String(value);

const touch = (order, key) => {
	order.delete(key);
	order.set(key, true);
};

export const createRecentMessageMap = (capacity, data = {}) => {
	const limit = normalizeCapacity(capacity);
	const backing = Object.create(null);
	if (data && typeof data === "object" && !Array.isArray(data)) {
		for (const [key, value] of Object.entries(data)) {
			Reflect.set(backing, key, value);
		}
	}

	const order = new Map(Object.keys(backing).map((key) => [key, true]));
	const metadata = {
		capacity: limit,
		deleteOperations: 0,
		evictedEntries: 0,
		initiallyPrunedEntries: 0,
		setOperations: 0,
	};

	const evictOverflow = (initializing = false) => {
		while (order.size > limit) {
			const oldest = order.keys().next().value;
			order.delete(oldest);
			if (Reflect.deleteProperty(backing, oldest)) {
				if (initializing) metadata.initiallyPrunedEntries += 1;
				else metadata.evictedEntries += 1;
			}
		}
	};

	evictOverflow(true);

	const proxy = new Proxy(backing, {
		deleteProperty(target, property) {
			const key = toPropertyKey(property);
			const existed = Object.hasOwn(target, key);
			const deleted = Reflect.deleteProperty(target, key);
			if (deleted) {
				order.delete(key);
				if (existed) metadata.deleteOperations += 1;
			}
			return deleted;
		},
		set(target, property, value) {
			if (typeof property === "symbol") {
				return Reflect.set(target, property, value);
			}

			const key = toPropertyKey(property);
			const reverseKey = toPropertyKey(value);
			Reflect.set(target, key, value);
			touch(order, key);

			Reflect.set(target, reverseKey, key);
			touch(order, reverseKey);
			metadata.setOperations += 1;
			evictOverflow();
			return true;
		},
	});

	metadataByMap.set(proxy, { metadata, order });
	return proxy;
};

export const getRecentMessageMapStats = (value) => {
	const managed = metadataByMap.get(value);
	if (!managed) {
		return {
			managed: false,
			capacity: null,
			entryCount:
				value && typeof value === "object" ? Object.keys(value).length : 0,
			deleteOperations: 0,
			evictedEntries: 0,
			initiallyPrunedEntries: 0,
			setOperations: 0,
		};
	}

	return {
		managed: true,
		capacity: managed.metadata.capacity,
		entryCount: managed.order.size,
		deleteOperations: managed.metadata.deleteOperations,
		evictedEntries: managed.metadata.evictedEntries,
		initiallyPrunedEntries: managed.metadata.initiallyPrunedEntries,
		setOperations: managed.metadata.setOperations,
	};
};
