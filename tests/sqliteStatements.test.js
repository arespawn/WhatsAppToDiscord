import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import store from "../src/persistence/sqliteStore.js";

const withStore = async (work) => {
	const originalDir = store.getStorageDir();
	const directory = await fs.mkdtemp(
		path.join(os.tmpdir(), "wa2dc-statements-"),
	);
	store.setStorageDir(directory);
	try {
		await store.init();
		await work();
	} finally {
		store.close();
		store.setStorageDir(originalDir);
		await fs.rm(directory, { recursive: true, force: true });
	}
};

test("SQLite reuses statement compilation across hot reads and writes", async (t) => {
	await withStore(() => {
		const prepare = t.mock.method(store._db, "prepare");
		for (let i = 0; i < 100; i += 1) {
			store.setAppState("key", String(i));
			assert.equal(store.getAppState("key"), String(i));
			store.setAuthKeys({ key: String(i) });
			assert.equal(store.getAuthKeys(["key"]).key, String(i));
			store.setMessageStore("key", String(i), Date.now() + 60000);
			assert.equal(store.getMessageStore("key").value, String(i));
			store.pruneMessageStore(10000);
		}
		assert.equal(prepare.mock.callCount(), 8);
	});
});

test("SQLite statements remain usable after rollback and are released on close", async () => {
	await withStore(async () => {
		store.setAppState("key", "before");
		assert.throws(
			() =>
				store.transaction(() => {
					store.setAppState("key", "rolled-back");
					throw new Error("rollback");
				}),
			/rollback/,
		);
		assert.equal(store.getAppState("key"), "before");
		store.transaction(() => store.setAppState("key", "after"));
		assert.equal(store.getAppState("key"), "after");
		store.close();
		assert.equal(store._statements.size, 0);
		assert.throws(() => store.getAppState("key"), /not initialized/);
		await store.init();
		assert.equal(store.getAppState("key"), "after");
	});
});

test("SQLite statement reuse preserves message TTL, replacement and oldest-entry pruning", async (t) => {
	await withStore(() => {
		t.mock.timers.enable({ apis: ["Date"], now: 10000 });
		store.setMessageStore("old", "old", 20000);
		t.mock.timers.tick(1);
		store.setMessageStore("new", "new", 20000);
		t.mock.timers.tick(1);
		store.setMessageStore("expired", "expired", 10000);
		assert.equal(store.getMessageStore("expired"), null);
		store.pruneMessageStore(1);
		assert.equal(store.getMessageStore("old"), null);
		assert.equal(store.getMessageStore("new").value, "new");
		store.setMessageStore("new", "replacement", 20000);
		assert.equal(store.getMessageStore("new").value, "replacement");
		t.mock.timers.tick(10000);
		store.pruneMessageStore(1);
		assert.equal(store.getMessageStore("new"), null);
		store.clearMessageStore();
	});
});

test("message capacity pruning preserves timestamp ties, disabled limits and fractional-limit behavior", async (t) => {
	await withStore(() => {
		t.mock.timers.enable({ apis: ["Date"], now: 10000 });
		for (const key of ["a", "b", "c", "d"])
			store.setMessageStore(key, key, 20000);
		store.pruneMessageStore(2);
		assert.equal(store.getMessageStore("a"), null);
		assert.equal(store.getMessageStore("b"), null);
		assert.equal(store.getMessageStore("c").value, "c");
		assert.equal(store.getMessageStore("d").value, "d");
		for (const disabled of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
			store.pruneMessageStore(disabled);
		assert.equal(store.getMessageStore("c").value, "c");
		store.pruneMessageStore(2.5);
		assert.throws(() => store.pruneMessageStore(1.5), /datatype mismatch/);
		assert.equal(store.getMessageStore("d").value, "d");
	});
});
