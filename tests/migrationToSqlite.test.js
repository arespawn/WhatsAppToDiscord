import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BufferJSON, initAuthCreds } from "@whiskeysockets/baileys";
import useSQLiteAuthState from "../src/auth/sqliteAuthState.js";
import storage from "../src/storage.js";

const writeLegacyFile = async (filePath, value) => {
	await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
	await fs.writeFile(filePath, value, { mode: 0o600 });
};

test("one-time migration imports legacy JSON + Baileys files into SQLite and creates backup", async () => {
	const originalDir = storage._storageDir;
	const tempBase = await fs.mkdtemp(path.join(os.tmpdir(), "wa2dc-migrate-"));
	const sandboxDir = path.join(tempBase, "storage");

	storage._storageDir = sandboxDir;
	await storage.close();

	try {
		await fs.mkdir(sandboxDir, { recursive: true, mode: 0o700 });

		await writeLegacyFile(
			path.join(sandboxDir, "settings"),
			JSON.stringify({
				Token: "TOK",
				GuildID: "G",
				ControlChannelID: "C",
				Categories: ["cat"],
			}),
		);
		await writeLegacyFile(
			path.join(sandboxDir, "chats"),
			JSON.stringify({ "123@s.whatsapp.net": "chan-1" }),
		);
		await writeLegacyFile(
			path.join(sandboxDir, "contacts"),
			JSON.stringify({ "123@s.whatsapp.net": "Alice" }),
		);
		await writeLegacyFile(
			path.join(sandboxDir, "lastMessages"),
			JSON.stringify({ dc1: "wa1", wa1: "dc1" }),
		);
		await writeLegacyFile(path.join(sandboxDir, "lastTimestamp"), "1712345678");

		const creds = initAuthCreds();
		creds.registered = true;
		await writeLegacyFile(
			path.join(sandboxDir, "baileys", "creds.json"),
			JSON.stringify(creds, BufferJSON.replacer),
		);
		await writeLegacyFile(
			path.join(sandboxDir, "baileys", "tctoken-test.json"),
			JSON.stringify(Buffer.from("rc9"), BufferJSON.replacer),
		);
		await writeLegacyFile(
			path.join(sandboxDir, "baileys", "lid-mapping-pn.json"),
			JSON.stringify("161040050426060:29@lid", BufferJSON.replacer),
		);

		await storage.ensureInitialized();

		const sqlitePath = path.join(sandboxDir, "wa2dc.sqlite");
		await fs.stat(sqlitePath);

		const settings = await storage.parseSettings();
		const chats = await storage.parseChats();
		const contacts = await storage.parseContacts();
		const startTime = await storage.parseStartTime();
		const lastMessages = await storage.parseLastMessages();

		assert.equal(settings.Token, "TOK");
		assert.deepEqual(chats, {
			"123@s.whatsapp.net": {
				channelId: "chan-1",
			},
		});
		assert.deepEqual(contacts, { "123@s.whatsapp.net": "Alice" });
		assert.equal(startTime, 1712345678);
		assert.equal(lastMessages.dc1, "wa1");
		assert.equal(lastMessages.wa1, "dc1");

		const auth = await useSQLiteAuthState();
		assert.equal(auth.state.creds.registered, true);

		const tctoken = await auth.state.keys.get("tctoken", ["test"]);
		const lidMapping = await auth.state.keys.get("lid-mapping", ["pn"]);
		assert.equal(tctoken.test.toString("utf8"), "rc9");
		assert.equal(lidMapping.pn, "161040050426060:29@lid");

		await assert.rejects(
			() => fs.stat(path.join(sandboxDir, "settings")),
			/ENOENT/,
		);
		await assert.rejects(
			() => fs.stat(path.join(sandboxDir, "baileys")),
			/ENOENT/,
		);

		const entries = await fs.readdir(sandboxDir);
		const backupDirs = entries.filter((name) =>
			name.startsWith("legacy-backup-"),
		);
		assert.equal(backupDirs.length, 1);

		const backupPath = path.join(sandboxDir, backupDirs[0]);
		await fs.stat(path.join(backupPath, "settings"));
		await fs.stat(path.join(backupPath, "baileys", "creds.json"));
	} finally {
		await storage.close();
		storage._storageDir = originalDir;
		await fs.rm(tempBase, { recursive: true, force: true });
	}
});
