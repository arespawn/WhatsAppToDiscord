import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import state from "../src/state.js";
import storage from "../src/storage.js";

const snapshotObject = (value) => ({ ...value });
const restoreObject = (target, snapshot) => {
	Object.keys(target).forEach((key) => {
		delete target[key];
	});
	Object.assign(target, snapshot);
};

const withTempStorage = async (fn) => {
	const originalDir = storage._storageDir;
	const tempBase = await fs.mkdtemp(
		path.join(os.tmpdir(), "wa2dc-sqlite-storage-"),
	);
	const sandboxDir = path.join(tempBase, "storage");

	storage._storageDir = sandboxDir;
	await storage.close();
	try {
		await fn({ tempBase, sandboxDir });
	} finally {
		await storage.close();
		storage._storageDir = originalDir;
		await fs.rm(tempBase, { recursive: true, force: true });
	}
};

test("SQLite storage initializes with expected file and restrictive permissions", async () => {
	await withTempStorage(async ({ sandboxDir }) => {
		await storage.ensureInitialized();

		const dbPath = path.join(sandboxDir, "wa2dc.sqlite");
		await fs.stat(dbPath);

		if (process.platform !== "win32") {
			const dirMode = (await fs.stat(sandboxDir)).mode & 0o777;
			const fileMode = (await fs.stat(dbPath)).mode & 0o777;
			assert.equal(dirMode, 0o700);
			assert.equal(fileMode, 0o600);
		}
	});
});

test("SQLite storage round-trips app state via save/parse APIs", async () => {
	const settingsSnapshot = snapshotObject(state.settings);
	const chatsSnapshot = snapshotObject(state.chats);
	const contactsSnapshot = snapshotObject(state.contacts);
	const originalStartTime = state.startTime;
	const originalLastMessages = state.lastMessages;

	await withTempStorage(async () => {
		state.settings.Token = "TOK";
		state.settings.GuildID = "guild";
		state.settings.ControlChannelID = "control";
		state.chats = {
			"123@s.whatsapp.net": { id: "webhook-1", channelId: "chan-1" },
		};
		state.contacts = { "123@s.whatsapp.net": "Alice" };
		state.startTime = 1712345678;
		state.lastMessages = { a: "b", b: "a" };

		await storage.save();

		const parsedSettings = await storage.parseSettings();
		const parsedChats = await storage.parseChats();
		const parsedContacts = await storage.parseContacts();
		const parsedStart = await storage.parseStartTime();
		const parsedLast = await storage.parseLastMessages();

		assert.equal(parsedSettings.Token, "TOK");
		assert.deepEqual(parsedChats, {
			"123@s.whatsapp.net": { id: "webhook-1", channelId: "chan-1" },
		});
		assert.deepEqual(parsedContacts, { "123@s.whatsapp.net": "Alice" });
		assert.equal(parsedStart, 1712345678);
		assert.equal(parsedLast.a, "b");
		assert.equal(parsedLast.b, "a");
	});

	restoreObject(state.settings, settingsSnapshot);
	restoreObject(state.chats, chatsSnapshot);
	restoreObject(state.contacts, contactsSnapshot);
	state.startTime = originalStartTime;
	state.lastMessages = originalLastMessages;
});
