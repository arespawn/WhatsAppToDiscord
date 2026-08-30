import assert from "node:assert/strict";
import test from "node:test";

import {
	createRecentMessageMap,
	getRecentMessageMapStats,
} from "../src/internal/recentMessageMap.js";

test("refreshing an existing mapping does not evict unrelated mappings", () => {
	const map = createRecentMessageMap(6, {
		a: "b",
		b: "a",
		c: "d",
		d: "c",
		e: "f",
		f: "e",
	});

	for (let index = 0; index < 20; index += 1) {
		map.a = "b";
		map.b = "a";
	}

	assert.deepEqual(Object.keys(map).sort(), ["a", "b", "c", "d", "e", "f"]);
	assert.equal(map.c, "d");
	assert.equal(map.f, "e");
	assert.deepEqual(getRecentMessageMapStats(map), {
		managed: true,
		capacity: 6,
		entryCount: 6,
		deleteOperations: 0,
		evictedEntries: 0,
		initiallyPrunedEntries: 0,
		setOperations: 40,
	});
});

test("capacity eviction is based on unique keys", () => {
	const map = createRecentMessageMap(4, {
		a: "b",
		b: "a",
		c: "d",
		d: "c",
	});

	map.e = "f";

	assert.deepEqual(Object.keys(map).sort(), ["c", "d", "e", "f"]);
	assert.equal(map.e, "f");
	assert.equal(map.f, "e");
	assert.equal(getRecentMessageMapStats(map).evictedEntries, 2);
});

test("album mappings keep every WhatsApp ID and one primary reverse mapping", () => {
	const map = createRecentMessageMap(100);

	for (let index = 1; index <= 10; index += 1) {
		map[`wa-image-${index}`] = "dc-album";
	}
	map["dc-album"] = "wa-image-1";

	for (let index = 1; index <= 10; index += 1) {
		assert.equal(map[`wa-image-${index}`], "dc-album");
	}
	assert.equal(map["dc-album"], "wa-image-1");
	assert.equal(getRecentMessageMapStats(map).entryCount, 11);
});
