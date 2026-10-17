import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

import {
	Browsers,
	downloadMediaMessage,
	getMediaKeys,
	proto,
} from "@whiskeysockets/baileys";
import { generateLoginNode } from "@whiskeysockets/baileys/lib/Utils/validate-connection.js";

test("QR registration refresh rotates the secret without consuming refs or changing timers", async () => {
	const source = fs.readFileSync(
		"node_modules/@whiskeysockets/baileys/lib/Socket/socket.js",
		"utf8",
	);
	const handlers = new Map();
	const timers = [];
	const events = [];
	const creds = {
		advSecretKey: randomBytes(32).toString("base64"),
		noiseKey: { public: Buffer.alloc(32) },
		signedIdentityKey: { public: Buffer.alloc(32) },
	};
	const ws = {
		isOpen: true,
		on: (name, handler) => handlers.set(name, handler),
	};
	const context = {
		ws,
		creds,
		Buffer,
		randomBytes,
		browser: ["13", "Android", ""],
		qrTimeout: undefined,
		S_WHATSAPP_NET: "s.whatsapp.net",
		ev: { emit: (name, payload) => events.push({ name, payload }) },
		getBinaryNodeChild: (node, tag) => node.content?.find((n) => n.tag === tag),
		getBinaryNodeChildren: (node, tag) =>
			node.content.filter((n) => n.tag === tag),
		buildPairingQRData: (...fields) => fields.slice(0, 4).join(","),
		sendNode: async () => {},
		setTimeout: (callback, ms) => timers.push({ callback, ms }),
		Boom: Error,
		DisconnectReason: { timedOut: 408 },
		end: () => assert.fail("refresh exhausted QR refs"),
	};
	vm.runInNewContext(
		`let qrTimer;\n${source.slice(source.indexOf("    let refreshPairingQR;"), source.indexOf("    // device paired for the first time"))}`,
		context,
	);
	const refresh = handlers.get("CB:notification,type:companion_reg_refresh");
	const notification = (tag) => ({ content: [{ tag }] });
	const originalSecret = creds.advSecretKey;
	refresh(notification("companion_reg_refresh"));
	assert.equal(creds.advSecretKey, originalSecret);
	await handlers.get("CB:iq,type:set,pair-device")({
		attrs: { id: "synthetic" },
		content: [
			{
				tag: "pair-device",
				content: ["first", "second"].map((ref) => ({
					tag: "ref",
					content: Buffer.from(ref),
				})),
			},
		],
	});
	refresh(notification("unexpected"));
	assert.equal(creds.advSecretKey, originalSecret);
	for (let i = 0; i < 50; i++) {
		const previous = creds.advSecretKey;
		refresh(
			notification(i % 2 ? "pair-device-rotate-qr" : "companion_reg_refresh"),
		);
		assert.notEqual(creds.advSecretKey, previous);
		assert.equal(Buffer.from(creds.advSecretKey, "base64").length, 32);
		assert.equal(events.at(-1).payload.qr.split(",")[0], "first");
		assert.equal(events.at(-1).payload.qr.split(",")[3], creds.advSecretKey);
		assert.equal(events.at(-2).payload.advSecretKey, creds.advSecretKey);
	}
	assert.equal(timers.length, 1);
	assert.equal(timers[0].ms, 60000);
	timers[0].callback();
	assert.equal(events.at(-1).payload.qr.split(",")[0], "second");
	assert.equal(timers[1].ms, 20000);
	const lastSecret = creds.advSecretKey;
	creds.me = { id: "synthetic" };
	refresh(notification("companion_reg_refresh"));
	assert.equal(creds.advSecretKey, lastSecret);
	delete creds.me;
	ws.isOpen = false;
	refresh(notification("companion_reg_refresh"));
	assert.equal(creds.advSecretKey, lastSecret);
});

test("Baileys sticker downloads avoid obsolete hosts and preserve other URLs", async (t) => {
	const mediaKey = Buffer.alloc(32, 7);
	const plaintext = Buffer.from("synthetic sticker bytes");
	const { cipherKey, iv } = await getMediaKeys(mediaKey, "sticker");
	const cipher = createCipheriv("aes-256-cbc", cipherKey, iv);
	const encrypted = Buffer.concat([
		cipher.update(plaintext),
		cipher.final(),
		Buffer.alloc(10),
	]);
	const directPath = "/synthetic-sticker.enc";
	const cases = [
		["https://a.whatsapp.net/old", directPath, {}, "mmg.whatsapp.net"],
		["https://web.whatsapp.net", directPath, {}, "mmg.whatsapp.net"],
		["https://mmg.whatsapp.net/old", directPath, {}, "mmg.whatsapp.net"],
		["https://custom.example/old", directPath, {}, "custom.example"],
		[
			"https://a.whatsapp.net/old",
			directPath,
			{ host: "override.example" },
			"override.example",
		],
		["https://a.whatsapp.net/url-only", undefined, {}, "a.whatsapp.net"],
	];
	let requestedUrl;
	t.mock.method(globalThis, "fetch", async (url) => {
		requestedUrl = url;
		return new Response(encrypted);
	});
	for (const [url, mediaPath, options, expectedHost] of cases) {
		const message = {
			message: {
				stickerMessage: { url, directPath: mediaPath, mediaKey },
			},
		};
		const downloaded = await downloadMediaMessage(message, "buffer", options);
		assert.equal(
			requestedUrl,
			mediaPath ? `https://${expectedHost}${mediaPath}` : url,
		);
		assert.deepEqual(downloaded, plaintext);
	}
});

test("Baileys rc14 carries WA2DC Android browser patch", () => {
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

test("Baileys rc14 waits for initial sync on reconnects", () => {
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

test("Baileys rc14 skips startup buffering when history sync is disabled", () => {
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

test("Baileys rc14 logs summarized own LID migration probes", () => {
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

test("Baileys rc14 tctoken prune is bounded during startup", () => {
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

test("Baileys rc14 preserves delivered receipts while WA2DC stays unavailable", () => {
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

test("Baileys rc14 notification ack tolerates pre-auth pairing notifications", () => {
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

test("Baileys rc14 skips incomplete link code pairing notifications safely", () => {
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
