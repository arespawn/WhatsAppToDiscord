import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { Browsers, proto } from "@whiskeysockets/baileys";
import { generateLoginNode } from "@whiskeysockets/baileys/lib/Utils/validate-connection.js";

test("Baileys rc13 carries WA2DC Android browser patch", () => {
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

test("Baileys rc13 waits for initial sync on reconnects", () => {
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

test("Baileys rc13 skips startup buffering when history sync is disabled", () => {
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

test("Baileys rc13 logs summarized own LID migration probes", () => {
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

test("Baileys rc13 tctoken prune is bounded during startup", () => {
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

test("Baileys rc13 preserves delivered receipts while WA2DC stays unavailable", () => {
	const messagesRecvSource = fs.readFileSync(
		"node_modules/@whiskeysockets/baileys/lib/Socket/messages-recv.js",
		"utf8",
	);

	assert.match(
		messagesRecvSource,
		/WA2DC stays unavailable on connect so the phone keeps getting notifications/u,
	);
	assert.doesNotMatch(
		messagesRecvSource,
		/else if \(!sendActiveReceipts\) \{\s*type = 'inactive';\s*\}/u,
	);
	assert.match(
		messagesRecvSource,
		/await sendReceipt\(msg\.key\.remoteJid, participant, \[msg\.key\.id\], type\)/u,
	);
});

test("Baileys rc13 notification ack tolerates pre-auth pairing notifications", () => {
	const messagesRecvSource = fs.readFileSync(
		"node_modules/@whiskeysockets/baileys/lib/Socket/messages-recv.js",
		"utf8",
	);

	assert.match(
		messagesRecvSource,
		/buildAckStanza\(node, errorCode, authState\.creds\.me\?\.id\)/u,
	);
	assert.doesNotMatch(
		messagesRecvSource,
		/buildAckStanza\(node, errorCode, authState\.creds\.me\.id\)/u,
	);
});

test("Baileys rc13 skips incomplete link code pairing notifications safely", () => {
	const messagesRecvSource = fs.readFileSync(
		"node_modules/@whiskeysockets/baileys/lib/Socket/messages-recv.js",
		"utf8",
	);
	const guardStart = messagesRecvSource.indexOf(
		"const requiredPairingBuffers = {",
	);
	const completePairingStart = messagesRecvSource.indexOf(
		"const ref = toRequiredBuffer(requiredPairingBuffers.link_code_pairing_ref);",
		guardStart,
	);
	const registeredIndex = messagesRecvSource.indexOf(
		"authState.creds.registered = true;",
		completePairingStart,
	);

	assert.notEqual(guardStart, -1);
	assert.ok(completePairingStart > guardStart);
	assert.ok(registeredIndex > completePairingStart);

	const guardSource = messagesRecvSource.slice(
		guardStart,
		completePairingStart,
	);
	assert.match(guardSource, /link_code_pairing_ref/u);
	assert.match(guardSource, /primary_identity_pub/u);
	assert.match(guardSource, /link_code_pairing_wrapped_primary_ephemeral_pub/u);
	assert.match(guardSource, /missingFields\.length > 0/u);
	assert.match(guardSource, /break;/u);
	assert.match(
		guardSource,
		/logger\.warn\(\{\s*missingFields,\s*stage: linkCodeCompanionReg\?\.attrs\?\.stage \?\? null,\s*childTags\s*\}/u,
	);
	assert.doesNotMatch(guardSource, /toRequiredBuffer/u);
	assert.doesNotMatch(guardSource, /logger\.warn\(\{\s*node/u);
	assert.doesNotMatch(guardSource, /node\.attrs/u);

	const completePairingSource = messagesRecvSource.slice(
		completePairingStart,
		registeredIndex + "authState.creds.registered = true;".length,
	);
	assert.match(
		completePairingSource,
		/toRequiredBuffer\(requiredPairingBuffers\.link_code_pairing_ref\)/u,
	);
	assert.match(
		completePairingSource,
		/toRequiredBuffer\(requiredPairingBuffers\.primary_identity_pub\)/u,
	);
	assert.match(
		completePairingSource,
		/toRequiredBuffer\(requiredPairingBuffers\.link_code_pairing_wrapped_primary_ephemeral_pub\)/u,
	);
	assert.match(completePairingSource, /authState\.creds\.registered = true/u);
});
