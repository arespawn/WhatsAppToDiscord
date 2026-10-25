import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import {
	loadAttachmentBuffer,
	readStreamToBuffer,
} from "../src/internal/attachmentBuffer.js";
import { createAudioSendContentNormalizer } from "../src/internal/audioSendNormalization.js";

test("attachment buffering preserves bytes and cancels a chunked response at the size limit", async (t) => {
	assert.equal(
		(
			await readStreamToBuffer(
				Readable.from([Buffer.from("ab"), Buffer.from("cd")]),
				4,
			)
		).toString(),
		"abcd",
	);
	let cancelled = false;
	let produced = 0;
	const body = new ReadableStream({
		pull(controller) {
			produced += 1024;
			controller.enqueue(new Uint8Array(1024));
		},
		cancel() {
			cancelled = true;
		},
	});
	t.mock.method(globalThis, "fetch", async () => new Response(body));
	await assert.rejects(
		loadAttachmentBuffer(
			{ url: "https://example.test/audio" },
			{ maxBytes: 1024 },
		),
		/buffer_length_exceeded/,
	);
	assert.equal(cancelled, true);
	assert.ok(produced <= 3 * 1024, `bytes produced: ${produced}`);
});

test("attachment HTTP errors and declared overflow cancel unused response bodies", async (t) => {
	for (const status of [200, 503]) {
		let cancelled = false;
		const response = new Response(
			new ReadableStream({
				cancel() {
					cancelled = true;
				},
			}),
			{
				status,
				headers: { "content-length": "1000" },
			},
		);
		t.mock.method(globalThis, "fetch", async () => response);
		await assert.rejects(
			loadAttachmentBuffer(
				{ url: "https://example.test/media" },
				{ maxBytes: 10 },
			),
			status === 200 ? /content_length_exceeded:1000/ : /HTTP 503/,
		);
		assert.equal(cancelled, true);
	}
});

test("attachment loading preserves data URLs, callback options and media fetch deadlines", async (t) => {
	assert.equal(
		(
			await loadAttachmentBuffer(
				{ url: "data:text/plain,a%20b" },
				{ maxBytes: 3 },
			)
		).toString(),
		"a b",
	);
	await assert.rejects(
		loadAttachmentBuffer(
			{ url: "data:text/plain;base64,YWJjZA==" },
			{ maxBytes: 3 },
		),
		/buffer_length_exceeded:4/,
	);
	assert.equal(
		await loadAttachmentBuffer({ url: "file:///ignored" }, { maxBytes: 3 }),
		null,
	);
	const injected = Buffer.from("abc");
	assert.equal(
		await loadAttachmentBuffer(
			{ url: "https://example.test/sticker" },
			{
				maxBytes: 3,
				accept: "image/*",
				fetchBuffer: async (url, options) => {
					assert.equal(url, "https://example.test/sticker");
					assert.deepEqual(options, { maxBytes: 3, accept: "image/*" });
					return { buffer: injected };
				},
			},
		),
		injected,
	);
	const timeout = t.mock.method(AbortSignal, "timeout");
	t.mock.method(globalThis, "fetch", async (_, options) => {
		assert.ok(options.signal instanceof AbortSignal);
		assert.deepEqual(options.headers, { accept: "audio/*" });
		return new Response("abc");
	});
	assert.equal(
		(
			await loadAttachmentBuffer(
				{ url: "https://example.test/audio" },
				{ maxBytes: 3, accept: "audio/*" },
			)
		).toString(),
		"abc",
	);
	assert.equal(timeout.mock.calls[0].arguments[0], 60000);
});

test("Discord audio streaming retains the existing URL fallback when actual bytes exceed 25 MiB", async (t) => {
	let cancelled = false;
	let produced = 0;
	t.mock.method(
		globalThis,
		"fetch",
		async () =>
			new Response(
				new ReadableStream({
					pull(controller) {
						produced += 1024 * 1024;
						controller.enqueue(new Uint8Array(1024 * 1024));
					},
					cancel() {
						cancelled = true;
					},
				}),
			),
	);
	const audio = { url: "https://example.test/audio.mp3" };
	const normalized = await createAudioSendContentNormalizer()({
		attachment: {
			url: audio.url,
			name: "audio.mp3",
			contentType: "audio/mpeg",
		},
		content: { audio, mimetype: "audio/mpeg" },
	});
	assert.equal(normalized.audio, audio);
	assert.equal(cancelled, true);
	assert.ok(produced <= 27 * 1024 * 1024);
});
