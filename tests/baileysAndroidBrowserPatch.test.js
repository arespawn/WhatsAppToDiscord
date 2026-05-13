import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { Browsers, proto } from "@whiskeysockets/baileys";
import { generateLoginNode } from "@whiskeysockets/baileys/lib/Utils/validate-connection.js";

test("Baileys rc11 carries WA2DC Android browser patch", () => {
	assert.equal(typeof Browsers.android, "function");
	assert.deepEqual(Browsers.android("13"), ["13", "Android", ""]);

	const payload = generateLoginNode("12345:1@s.whatsapp.net", {
		browser: Browsers.android("13"),
		countryCode: "US",
		version: [2, 3000, 0],
	});
	const userAgent = proto.ClientPayload.toObject(payload).userAgent;

	assert.equal(
		userAgent.platform,
		proto.ClientPayload.UserAgent.Platform.ANDROID,
	);
});

test("Baileys rc11 waits for initial sync on reconnects", () => {
	const chatsSource = fs.readFileSync(
		"node_modules/@whiskeysockets/baileys/lib/Socket/chats.js",
		"utf8",
	);

	assert.match(
		chatsSource,
		/History sync is enabled, awaiting notification with a 20s timeout\./u,
	);
	assert.doesNotMatch(
		chatsSource,
		/Reconnection with existing sync data, skipping history sync wait/u,
	);
});

test("Baileys rc11 skips startup buffering when history sync is disabled", () => {
	const socketSource = fs.readFileSync(
		"node_modules/@whiskeysockets/baileys/lib/Socket/socket.js",
		"utf8",
	);
	const chatsSource = fs.readFileSync(
		"node_modules/@whiskeysockets/baileys/lib/Socket/chats.js",
		"utf8",
	);

	assert.match(
		socketSource,
		/WA2DC skipped Baileys initial event buffer because recent history sync is disabled/u,
	);
	assert.match(socketSource, /const wa2dcSkipInitialBuffer/u);
	assert.match(
		socketSource,
		/syncType: proto\.HistorySync\.HistorySyncType\.RECENT/u,
	);
	assert.match(
		socketSource,
		/if \(creds\.me\?\.id && !wa2dcSkipInitialBuffer\)/u,
	);
	assert.match(
		chatsSource,
		/WA2DC history sync disabled before Baileys event buffer/u,
	);
	assert.ok(
		chatsSource.indexOf("const willSyncHistory") <
			chatsSource.indexOf("ev.buffer();"),
	);
	assert.doesNotMatch(chatsSource, /setTimeout\(\(\) => ev\.flush\(\), 0\)/u);
});

test("Baileys rc11 logs summarized own LID migration probes", () => {
	const socketSource = fs.readFileSync(
		"node_modules/@whiskeysockets/baileys/lib/Socket/socket.js",
		"utf8",
	);

	assert.match(socketSource, /WA2DC starting own LID mapping store/u);
	assert.match(socketSource, /WA2DC starting own LID session migration/u);
	assert.match(socketSource, /WA2DC own LID session migration complete/u);
	assert.match(socketSource, /hasPN: Boolean\(myPN\)/u);
	assert.doesNotMatch(
		socketSource,
		/logger\.info\(\{ myPN, myLID \}, 'Own LID session created successfully'\)/u,
	);
});

test("Baileys rc11 tctoken prune is bounded during startup", () => {
	const messagesRecvSource = fs.readFileSync(
		"node_modules/@whiskeysockets/baileys/lib/Socket/messages-recv.js",
		"utf8",
	);

	assert.match(messagesRecvSource, /TC_TOKEN_PRUNE_BATCH_SIZE = 250/u);
	assert.match(messagesRecvSource, /starting bounded tctoken prune/u);
	assert.match(messagesRecvSource, /tctoken prune deferred during startup/u);
	assert.match(
		messagesRecvSource,
		/batchTokens = await authState\.keys\.get\('tctoken', batch\)/u,
	);
	assert.doesNotMatch(
		messagesRecvSource,
		/const allTokens = await authState\.keys\.get\('tctoken', jids\)/u,
	);
});
