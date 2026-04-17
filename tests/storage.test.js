import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
	resetClientFactoryOverrides,
	setClientFactoryOverrides,
} from "../src/clientFactories.js";
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
	const tempBase = await fs.mkdtemp(path.join(os.tmpdir(), "wa2dc-storage-"));
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

test("storage upsert sanitizes keys and rejects invalid names", async () => {
	await withTempStorage(async () => {
		await storage.upsert("../evil", "ok");

		const roundTrip = await storage.get("../evil");
		assert.equal(roundTrip.toString("utf8"), "ok");

		await assert.rejects(
			() => storage.upsert("..", "x"),
			/Invalid storage key/,
		);
		await assert.rejects(
			() => storage.upsert("\0\0", "x"),
			/Invalid storage key/,
		);
	});
});

test("parseSettings merges defaults when older settings are missing keys", async () => {
	const settingsSnapshot = snapshotObject(state.settings);
	await withTempStorage(async () => {
		await storage.upsert(
			"settings",
			JSON.stringify({ Token: "TOK", GuildID: "G", ControlChannelID: "C" }),
		);

		const settings = await storage.parseSettings();
		assert.equal(settings.Token, "TOK");
		assert.equal(settings.DownloadDir, "./downloads");
		assert.equal(settings.DiscordEmbedsToWhatsApp, false);
		assert.equal(settings.redirectAnnouncementWebhooks, false);
		assert.equal(settings.LocalDownloads, false);
		assert.equal(settings.NewsletterMediaUrlFallback, false);
		assert.equal(settings.PinDurationSeconds, 7 * 24 * 60 * 60);
		assert.equal(settings.WhatsAppDiscordMediaBurstSize, 10);
		assert.equal(settings.DefaultChatType, "channel");
		assert.equal(settings.ThreadNotificationsEnabled, false);
		assert.deepEqual(settings.ThreadNotificationRoles, []);
		assert.deepEqual(settings.ThreadNotificationUsers, []);
	});
	restoreObject(state.settings, settingsSnapshot);
});

test("parseChats normalizes legacy chat links and thread metadata", async () => {
	const chatsSnapshot = snapshotObject(state.chats);
	await withTempStorage(async () => {
		await storage.upsert(
			"chats",
			JSON.stringify({
				"123@s.whatsapp.net": {
					id: " wh-1 ",
					token: " tok-1 ",
					channelId: " chan-1 ",
				},
				"456@s.whatsapp.net": {
					id: "wh-2",
					token: "tok-2",
					channelId: "forum-1",
					threadId: " thread-2 ",
				},
			}),
		);

		const chats = await storage.parseChats();
		assert.deepEqual(chats["123@s.whatsapp.net"], {
			id: "wh-1",
			token: "tok-1",
			channelId: "chan-1",
		});
		assert.deepEqual(chats["456@s.whatsapp.net"], {
			id: "wh-2",
			token: "tok-2",
			channelId: "forum-1",
			threadId: "thread-2",
		});
	});
	restoreObject(state.chats, chatsSnapshot);
});

test("parseSettings recovers via firstRun on corrupted JSON (mocked Discord bootstrap)", async () => {
	const settingsSnapshot = snapshotObject(state.settings);
	const originalLogger = state.logger;
	const originalEnvToken = process.env.WA2DC_TOKEN;

	process.env.WA2DC_TOKEN = "TOK";
	state.logger = { info() {}, warn() {}, error() {}, debug() {} };

	let capturedToken = null;
	let clientDestroyed = false;
	const createdChannels = [];

	const fakeGuild = {
		id: "guild-1",
		channels: {
			async create(payload) {
				const name =
					typeof payload === "string" ? payload : payload?.name || "";
				const id = name === "whatsapp" ? "cat-1" : "ctrl-1";
				createdChannels.push({ name, id });
				return { id };
			},
		},
	};

	class FakeDiscordClient extends EventEmitter {
		constructor() {
			super();
			this.user = { id: "bot-1" };
		}

		async login(token) {
			capturedToken = token;
			queueMicrotask(() => this.emit("ready"));
			queueMicrotask(() => this.emit("guildCreate", fakeGuild));
			return this;
		}

		destroy() {
			clientDestroyed = true;
		}
	}

	setClientFactoryOverrides({
		createDiscordClient: () => new FakeDiscordClient(),
	});

	try {
		await withTempStorage(async () => {
			await storage.upsert("settings", "{not-json");
			const settings = await storage.parseSettings();

			assert.equal(capturedToken, "TOK");
			assert.ok(clientDestroyed);
			assert.deepEqual(
				createdChannels.map((entry) => entry.name),
				["whatsapp", "control-room"],
			);

			assert.equal(settings.Token, "TOK");
			assert.equal(settings.GuildID, "guild-1");
			assert.deepEqual(settings.Categories, ["cat-1"]);
			assert.equal(settings.ControlChannelID, "ctrl-1");
		});
	} finally {
		resetClientFactoryOverrides();
		restoreObject(state.settings, settingsSnapshot);
		state.logger = originalLogger;
		if (originalEnvToken === undefined) {
			delete process.env.WA2DC_TOKEN;
		} else {
			process.env.WA2DC_TOKEN = originalEnvToken;
		}
	}
});

test("parseLastMessages tolerates null JSON payloads", async () => {
	const settingsSnapshot = snapshotObject(state.settings);
	const originalLastMessages = state.lastMessages;

	await withTempStorage(async () => {
		await storage.upsert("lastMessages", "null");

		const map = await storage.parseLastMessages();
		assert.equal(typeof map, "object");
		assert.deepEqual(Object.keys(map), []);

		map["wa-1"] = "dc-1";
		assert.equal(map["wa-1"], "dc-1");
		assert.equal(map["dc-1"], "wa-1");
	});

	restoreObject(state.settings, settingsSnapshot);
	state.lastMessages = originalLastMessages;
});

test("storage.save never persists lastMessages as null", async () => {
	const settingsSnapshot = snapshotObject(state.settings);
	const originalLastMessages = state.lastMessages;

	await withTempStorage(async () => {
		state.lastMessages = null;
		await storage.save();

		const saved = await storage.get("lastMessages");
		assert.notEqual(saved.toString("utf8").trim(), "null");
		assert.equal(saved.toString("utf8").trim(), "{}");
	});

	restoreObject(state.settings, settingsSnapshot);
	state.lastMessages = originalLastMessages;
});
