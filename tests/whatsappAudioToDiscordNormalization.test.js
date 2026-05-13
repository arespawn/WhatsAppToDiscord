import assert from "node:assert/strict";
import test from "node:test";

import { createWhatsAppAudioToDiscordFileNormalizer } from "../src/internal/whatsappAudioToDiscordNormalization.js";

test("WhatsApp audio normalizer leaves audio unchanged by default", async () => {
	const normalizeWhatsAppAudioFileForDiscord =
		createWhatsAppAudioToDiscordFileNormalizer();
	const sourceBuffer = Buffer.from("ogg-opus-bytes", "utf8");
	const normalized = await normalizeWhatsAppAudioFileForDiscord({
		attachmentBuffer: sourceBuffer,
		fileName: "audio.ogg",
		mimetype: "audio/ogg; codecs=opus",
	});

	assert.equal(normalized.converted, false);
	assert.equal(normalized.fileName, "audio.ogg");
	assert.equal(normalized.contentType, "audio/ogg");
	assert.equal(normalized.attachmentBuffer, sourceBuffer);
});

test("WhatsApp audio normalizer converts opted-in audio buffers into MP3 attachments", async () => {
	const outputBuffer = Buffer.from("mp3-bytes", "utf8");
	const normalizeWhatsAppAudioFileForDiscord =
		createWhatsAppAudioToDiscordFileNormalizer({
			transcodeBufferToMp3: async (inputBuffer) => {
				assert.equal(inputBuffer.toString("utf8"), "ogg-opus-bytes");
				return outputBuffer;
			},
		});

	const normalized = await normalizeWhatsAppAudioFileForDiscord({
		attachmentBuffer: Buffer.from("ogg-opus-bytes", "utf8"),
		fileName: "audio.ogg",
		mimetype: "audio/ogg; codecs=opus",
		targetFormat: "mp3",
		maxBytes: 1024,
	});

	assert.equal(normalized.converted, true);
	assert.equal(normalized.fileName, "audio.mp3");
	assert.equal(normalized.contentType, "audio/mpeg");
	assert.equal(normalized.attachmentBuffer, outputBuffer);
});

test("WhatsApp audio normalizer falls back when MP3 output exceeds the upload limit", async () => {
	const sourceBuffer = Buffer.from("ogg-opus-bytes", "utf8");
	const normalizeWhatsAppAudioFileForDiscord =
		createWhatsAppAudioToDiscordFileNormalizer({
			getLogger: () => ({ debug() {}, warn() {} }),
			transcodeBufferToMp3: async () => Buffer.from("too-large", "utf8"),
		});

	const normalized = await normalizeWhatsAppAudioFileForDiscord({
		attachmentBuffer: sourceBuffer,
		fileName: "audio.ogg",
		mimetype: "audio/ogg",
		targetFormat: "mp3",
		maxBytes: 3,
	});

	assert.equal(normalized.converted, false);
	assert.equal(normalized.fileName, "audio.ogg");
	assert.equal(normalized.contentType, "audio/ogg");
	assert.equal(normalized.attachmentBuffer, sourceBuffer);
});

test("WhatsApp audio normalizer falls back when ffmpeg is unavailable", async () => {
	const warnings = [];
	const normalizeWhatsAppAudioFileForDiscord =
		createWhatsAppAudioToDiscordFileNormalizer({
			getLogger: () => ({
				warn(message) {
					warnings.push(message);
				},
				debug() {},
			}),
			transcodeBufferToMp3: async () => {
				const err = new Error("spawn ffmpeg ENOENT");
				err.code = "ENOENT";
				throw err;
			},
		});
	const sourceBuffer = Buffer.from("ogg-opus-bytes", "utf8");

	const first = await normalizeWhatsAppAudioFileForDiscord({
		attachmentBuffer: sourceBuffer,
		fileName: "audio.ogg",
		mimetype: "audio/ogg",
		targetFormat: "mp3",
	});
	const second = await normalizeWhatsAppAudioFileForDiscord({
		attachmentBuffer: sourceBuffer,
		fileName: "audio.ogg",
		mimetype: "audio/ogg",
		targetFormat: "mp3",
	});

	assert.equal(first.converted, false);
	assert.equal(first.fileName, "audio.ogg");
	assert.equal(first.contentType, "audio/ogg");
	assert.equal(first.attachmentBuffer, sourceBuffer);
	assert.equal(second.converted, false);
	assert.deepEqual(warnings, [
		"ffmpeg is not installed; WhatsApp audio will be mirrored to Discord without MP3 conversion",
	]);
});
