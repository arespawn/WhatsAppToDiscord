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
