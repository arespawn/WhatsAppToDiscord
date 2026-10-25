import assert from "node:assert/strict";
import test from "node:test";

import { createWhatsAppGifToDiscordFileNormalizer } from "../src/internal/whatsappGifToDiscordNormalization.js";

test("WhatsApp GIF normalizer leaves non-video media unchanged", async () => {
	const normalizeWhatsAppGifFileForDiscord =
		createWhatsAppGifToDiscordFileNormalizer();
	const sourceBuffer = Buffer.from("not-a-video", "utf8");
	const normalized = await normalizeWhatsAppGifFileForDiscord({
		attachmentBuffer: sourceBuffer,
		fileName: "photo.png",
		mimetype: "image/png",
	});

	assert.equal(normalized.converted, false);
	assert.equal(normalized.fileName, "photo.png");
	assert.equal(normalized.contentType, "image/png");
	assert.equal(normalized.attachmentBuffer, sourceBuffer);
});

test("WhatsApp GIF normalizer converts video buffers into Discord GIF attachments", async () => {
	const outputBuffer = Buffer.from("gif89a", "utf8");
	const normalizeWhatsAppGifFileForDiscord =
		createWhatsAppGifToDiscordFileNormalizer({
			transcodeBufferToGif: async (inputBuffer) => {
				assert.equal(inputBuffer.toString("utf8"), "mp4-bytes");
				return outputBuffer;
			},
		});

	const normalized = await normalizeWhatsAppGifFileForDiscord({
		attachmentBuffer: Buffer.from("mp4-bytes", "utf8"),
		fileName: "videoMessage.mp4",
		mimetype: "video/mp4",
	});

	assert.equal(normalized.converted, true);
	assert.equal(normalized.fileName, "videoMessage.gif");
	assert.equal(normalized.contentType, "image/gif");
	assert.equal(normalized.attachmentBuffer, outputBuffer);
});

test("WhatsApp GIF normalizer falls back to video when ffmpeg is unavailable", async () => {
	const warnings = [];
	const normalizeWhatsAppGifFileForDiscord =
		createWhatsAppGifToDiscordFileNormalizer({
			getLogger: () => ({
				warn(message) {
					warnings.push(message);
				},
				debug() {},
			}),
			transcodeBufferToGif: async () => {
				const err = new Error("spawn ffmpeg ENOENT");
				err.code = "ENOENT";
				throw err;
			},
		});
	const sourceBuffer = Buffer.from("mp4-bytes", "utf8");

	const first = await normalizeWhatsAppGifFileForDiscord({
		attachmentBuffer: sourceBuffer,
		fileName: "clip.mp4",
		mimetype: "video/mp4",
	});
	const second = await normalizeWhatsAppGifFileForDiscord({
		attachmentBuffer: sourceBuffer,
		fileName: "clip.mp4",
		mimetype: "video/mp4",
	});

	assert.equal(first.converted, false);
	assert.equal(first.fileName, "clip.mp4");
	assert.equal(first.contentType, "video/mp4");
	assert.equal(first.attachmentBuffer, sourceBuffer);
	assert.equal(second.converted, false);
	assert.deepEqual(warnings, [
		"ffmpeg is not installed; WhatsApp GIFs will be mirrored to Discord as videos",
	]);
});

test("WhatsApp GIF normalizer preserves injected callback arguments and falls back above the upload limit", async () => {
	const source = Buffer.from("video");
	const normalize = createWhatsAppGifToDiscordFileNormalizer({
		transcodeBufferToGif: async (...args) => {
			assert.deepEqual(args, [source]);
			return Buffer.from("large-gif");
		},
	});
	const result = await normalize({
		attachmentBuffer: source,
		fileName: "video.mp4",
		mimetype: "video/mp4",
		maxBytes: 3,
	});
	assert.equal(result.converted, false);
	assert.equal(result.attachmentBuffer, source);
});
