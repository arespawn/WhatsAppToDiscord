import assert from "node:assert/strict";
import { createCipheriv } from "node:crypto";
import test from "node:test";

import {
	downloadContentFromMessage,
	getHttpStream,
	getMediaKeys,
} from "@whiskeysockets/baileys";
import state from "../src/state.js";
import utils from "../src/utils.js";

const mediaKey = Buffer.alloc(32, 7);
const encrypt = async (plaintext, type = "video") => {
	const { cipherKey, iv } = await getMediaKeys(mediaKey, type);
	const cipher = createCipheriv("aes-256-cbc", cipherKey, iv);
	return Buffer.concat([
		cipher.update(plaintext),
		cipher.final(),
		Buffer.alloc(10),
	]);
};

test("Baileys forwards cancellation to pending media HTTP requests", async (t) => {
	const controller = new AbortController();
	t.mock.method(globalThis, "fetch", (_, options) => {
		assert.equal(options.signal, controller.signal);
		return new Promise((_, reject) =>
			options.signal.addEventListener(
				"abort",
				() => reject(options.signal.reason),
				{ once: true },
			),
		);
	});
	const result = getHttpStream("https://example.test/media", {
		signal: controller.signal,
	});
	controller.abort(new Error("synthetic media cancellation"));
	await assert.rejects(result, /synthetic media cancellation/);
});

test("destroying a decrypted media stream cancels its HTTP source", {
	timeout: 3000,
}, async (t) => {
	const cancelled = Promise.withResolvers();
	const encrypted = await encrypt(Buffer.alloc(256, 1));
	t.mock.method(
		globalThis,
		"fetch",
		async () =>
			new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(encrypted);
					},
					cancel() {
						cancelled.resolve();
					},
				}),
			),
	);
	const stream = await downloadContentFromMessage(
		{ url: "https://example.test/media", mediaKey },
		"video",
	);
	stream.destroy();
	await cancelled.promise;
	assert.equal(stream.destroyed, true);
});

test("media HTTP read failures reach the decrypt stream consumer and error responses are cancelled", async (t) => {
	t.mock.method(
		globalThis,
		"fetch",
		async () =>
			new Response(
				new ReadableStream({
					start(controller) {
						controller.error(new Error("synthetic media read failure"));
					},
				}),
			),
	);
	const stream = await downloadContentFromMessage(
		{ url: "https://example.test/media", mediaKey },
		"video",
	);
	await assert.rejects(async () => {
		for await (const _chunk of stream) {
		}
	}, /synthetic media read failure/);
	let cancelled = false;
	t.mock.method(
		globalThis,
		"fetch",
		async () =>
			new Response(
				new ReadableStream({
					cancel() {
						cancelled = true;
					},
				}),
				{ status: 503 },
			),
	);
	await assert.rejects(
		getHttpStream("https://example.test/media"),
		/Failed to fetch stream/,
	);
	assert.equal(cancelled, true);
});

test("GIF and MP3 input overflows preserve the large-file and local-download fallbacks", async (t) => {
	const settings = state.settings;
	const client = state.waClient;
	t.after(() => {
		state.settings = settings;
		state.waClient = client;
	});
	state.waClient = { updateMediaMessage: async () => {} };
	for (const type of ["video", "audio"]) {
		const encrypted = await encrypt(Buffer.alloc(64, 1), type);
		t.mock.method(globalThis, "fetch", async (_, options) => {
			assert.ok(options.signal instanceof AbortSignal);
			return new Response(encrypted);
		});
		for (const LocalDownloads of [false, true]) {
			state.settings = {
				...settings,
				DiscordFileSizeLimit: 16,
				LocalDownloads,
				WhatsAppAudioConversionFormat: "mp3",
			};
			const raw = {
				key: { id: "synthetic", remoteJid: "test@g.us" },
				message: {
					[`${type}Message`]: {
						fileLength: 1,
						url: "https://example.test/media",
						mimetype: type === "video" ? "video/mp4" : "audio/ogg",
						gifPlayback: true,
						mediaKey,
					},
				},
			};
			const result = await utils.whatsapp.getFile(raw, `${type}Message`);
			if (LocalDownloads) {
				assert.equal(result.largeFile, true);
				assert.equal(result.downloadCtx, raw);
				assert.equal(result.msgType, `${type}Message`);
			} else {
				assert.equal(result, -1);
			}
		}
	}
});
