import assert from "node:assert/strict";
import test from "node:test";

import state from "../src/state.js";
import utils from "../src/utils.js";

test("ordinary WhatsApp media is represented by a lazy Discord attachment descriptor", async () => {
	const originalLocalDownloads = state.settings.LocalDownloads;
	const originalLimit = state.settings.DiscordFileSizeLimit;
	try {
		state.settings.LocalDownloads = false;
		state.settings.DiscordFileSizeLimit = 8 * 1024 * 1024;
		const rawMessage = {
			key: {
				id: "wa-lazy-media",
				remoteJid: "123@s.whatsapp.net",
			},
			message: {
				imageMessage: {
					mimetype: "image/jpeg",
					fileLength: 2048,
				},
			},
		};

		const file = await utils.whatsapp.getFile(rawMessage, "imageMessage");

		assert.equal(file?.attachment, undefined);
		assert.equal(file?.downloadCtx, rawMessage);
		assert.equal(file?.declaredSize, 2048);
		assert.equal(file?.wa2dcLazyWhatsAppMedia, true);
	} finally {
		state.settings.LocalDownloads = originalLocalDownloads;
		state.settings.DiscordFileSizeLimit = originalLimit;
	}
});

test("Discord webhook transport classifier treats fetch timeout failures as retryable", () => {
	const timeoutError = new AggregateError([], "connect timed out");
	timeoutError.code = "ETIMEDOUT";

	const err = new TypeError("fetch failed");
	err.cause = timeoutError;
	err.stack =
		"TypeError: fetch failed\n    at node:internal/deps/undici/undici:16416:13";

	assert.equal(utils.discord.isRetryableWebhookTransportError(err), true);
});

test("Discord webhook transport classifier treats HTTP/2 protocol stream failures as retryable", () => {
	const err = new Error("Stream closed with error code NGHTTP2_PROTOCOL_ERROR");
	err.code = "ERR_HTTP2_STREAM_ERROR";
	err.stack =
		"Error [ERR_HTTP2_STREAM_ERROR]: Stream closed with error code NGHTTP2_PROTOCOL_ERROR\n    at ClientHttp2Stream._destroy (node:internal/http2/core:2463:13)";

	assert.equal(utils.discord.isRetryableWebhookTransportError(err), true);
});

test("WhatsApp-backed Discord uploads honor the configured burst size", () => {
	const originalBurstSize = state.settings.WhatsAppDiscordMediaBurstSize;
	try {
		state.settings.WhatsAppDiscordMediaBurstSize = 3;
		const files = Array.from({ length: 7 }, (_, idx) => ({
			name: `image-${idx + 1}.jpg`,
			downloadCtx: { id: `wa-${idx + 1}` },
			declaredSize: 5,
			wa2dcLazyWhatsAppMedia: true,
		}));

		const chunks = utils.discord.chunkWebhookFilesForSend(files);

		assert.deepEqual(
			chunks.map((chunk) => chunk.length),
			[3, 3, 1],
		);
	} finally {
		state.settings.WhatsAppDiscordMediaBurstSize = originalBurstSize;
	}
});

test("WhatsApp-backed Discord uploads default to Discord's full attachment batch size", () => {
	const originalBurstSize = state.settings.WhatsAppDiscordMediaBurstSize;
	try {
		state.settings.WhatsAppDiscordMediaBurstSize = 10;
		const files = Array.from({ length: 11 }, (_, idx) => ({
			name: `image-${idx + 1}.jpg`,
			downloadCtx: { id: `wa-${idx + 1}` },
			declaredSize: 5,
			wa2dcLazyWhatsAppMedia: true,
		}));

		const chunks = utils.discord.chunkWebhookFilesForSend(files);

		assert.deepEqual(
			chunks.map((chunk) => chunk.length),
			[10, 1],
		);
	} finally {
		state.settings.WhatsAppDiscordMediaBurstSize = originalBurstSize;
	}
});

test("Buffered Discord uploads still use the full Discord attachment batch size", () => {
	const files = Array.from({ length: 11 }, (_, idx) => ({
		name: `image-${idx + 1}.jpg`,
		attachment: Buffer.from("image"),
	}));

	const chunks = utils.discord.chunkWebhookFilesForSend(files);

	assert.deepEqual(
		chunks.map((chunk) => chunk.length),
		[10, 1],
	);
});
