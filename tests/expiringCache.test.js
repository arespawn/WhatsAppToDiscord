import assert from "node:assert/strict";
import test from "node:test";

import { ExpiringCache } from "../src/internal/expiringCache.js";

test("cache retention uses one unreferenced timer regardless of entry count", (t) => {
	const setTimer = t.mock.method(globalThis, "setTimeout");
	const cache = new ExpiringCache(60000);
	t.after(() => cache.clear());
	for (let i = 0; i < 10000; i += 1) cache.set(String(i), i);
	assert.equal(cache.size, 10000);
	assert.equal(cache.get("9999"), 9999);
	assert.equal(setTimer.mock.callCount(), 1);
	assert.equal(cache.timer.hasRef(), false);
	cache.clear();
	assert.equal(cache.timer, null);
	assert.equal(cache.size, 0);
});

test("cache expires old entries and retains refreshed entries for their full TTL", (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10000 });
	const cache = new ExpiringCache(100, { now: Date.now });
	t.after(() => cache.clear());
	cache.set("old", 1).set("refresh", 2);
	t.mock.timers.tick(50);
	cache.set("refresh", 3).set("new", 4);
	t.mock.timers.tick(50);
	assert.equal(cache.has("old"), false);
	assert.equal(cache.get("refresh"), 3);
	assert.equal(cache.get("new"), 4);
	assert.equal(cache.size, 2);
	t.mock.timers.tick(50);
	assert.equal(cache.size, 0);
	assert.equal(cache.timer, null);
});

test("cache clears deleted entries and never returns expired values before timer dispatch", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let now = 0;
	const cache = new ExpiringCache(100, { now: () => now });
	t.after(() => cache.clear());
	cache.set("undefined", undefined).set("second", 2);
	assert.equal(cache.has("undefined"), true);
	assert.equal(cache.delete("undefined"), true);
	assert.equal(cache.has("undefined"), false);
	now = 100;
	assert.equal(cache.get("second"), undefined);
	assert.equal(cache.timer, null);
	cache.set("last", 3);
	assert.equal(cache.has("last"), true);
	now = 201;
	assert.equal(cache.has("last"), false);
	assert.equal(cache.size, 0);
});
