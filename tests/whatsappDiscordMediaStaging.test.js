import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import {
	cleanupActiveWhatsAppDiscordMediaStaging,
	stageWhatsAppDiscordAttachments,
	WHATSAPP_DISCORD_MEDIA_DOWNLOAD_TIMEOUT_MS,
} from "../src/internal/whatsappDiscordMediaStaging.js";
import state from "../src/state.js";
import utils from "../src/utils.js";

const createTemporaryParent = () =>
	fs.promises.mkdtemp(path.join(os.tmpdir(), "wa2dc-media-test-"));

const removeTemporaryParent = (directory) =>
	fs.promises.rm(directory, { recursive: true, force: true });

const lazyAttachment = (index, declaredSize, overrides = {}) => ({
	name: `image-${index}.jpg`,
	downloadCtx: { index },
	declaredSize,
	msgType: "imageMessage",
	spoiler: false,
	wa2dcLazyWhatsAppMedia: true,
	...overrides,
});

const pathExists = async (candidate) =>
	fs.promises
		.access(candidate)
		.then(() => true)
		.catch(() => false);

const captureLogger = () => {
	const entries = [];
	const logger = {};
	for (const level of ["info", "warn", "error"]) {
		logger[level] = (metadata, message) => {
			entries.push({ level, metadata, message });
		};
	}
	return { logger, entries };
};

test("ten WhatsApp images are staged sequentially, uploaded as one replayable album, and cleaned", async () => {
	const temporaryParent = await createTemporaryParent();
	const originalLogger = state.logger;
	const originalLimit = state.settings.DiscordFileSizeLimit;
	const { logger, entries } = captureLogger();
	const totalBytes = 2_035_339;
	const sizes = Array.from({ length: 10 }, (_, index) =>
		index === 9 ? totalBytes - 9 * 203_533 : 203_533,
	);
	const files = sizes.map((size, index) =>
		lazyAttachment(index + 1, size, {
			...(index === 0 ? { name: "SPOILER_image-1.jpg", spoiler: true } : {}),
		}),
	);
	let activeDownloads = 0;
	let maximumActiveDownloads = 0;
	let downloadCalls = 0;
	const uploadedPaths = [];

	try {
		state.logger = logger;
		state.settings.DiscordFileSizeLimit = 8 * 1024 * 1024;
		const sent = await utils.discord.safeWebhookSend(
			{
				async send(args) {
					assert.equal(args.files.length, 10);
					assert.equal(args.files[0].name, "SPOILER_image-1.jpg");
					uploadedPaths.push(...args.files.map((file) => file.attachment));
					const uploadedBytes = (
						await Promise.all(
							args.files.map((file) => fs.promises.readFile(file.attachment)),
						)
					).reduce((total, buffer) => total + buffer.length, 0);
					assert.equal(uploadedBytes, totalBytes);

					if (process.platform !== "win32") {
						const directoryMode = (
							await fs.promises.stat(path.dirname(args.files[0].attachment))
						).mode;
						assert.equal(directoryMode & 0o777, 0o700);
						for (const file of args.files) {
							const fileMode = (await fs.promises.stat(file.attachment)).mode;
							assert.equal(fileMode & 0o777, 0o600);
						}
					}

					return { id: "dc-album" };
				},
			},
			{
				content: "synthetic production-shaped album",
				files,
			},
			"private-sender@s.whatsapp.net",
			{
				temporaryDirectory: temporaryParent,
				downloadWhatsAppMedia(file) {
					downloadCalls += 1;
					const bytes = sizes[file.downloadCtx.index - 1];
					return Readable.from(
						(async function* streamOneAttachment() {
							activeDownloads += 1;
							maximumActiveDownloads = Math.max(
								maximumActiveDownloads,
								activeDownloads,
							);
							await new Promise((resolve) => setImmediate(resolve));
							yield Buffer.alloc(bytes, file.downloadCtx.index);
							activeDownloads -= 1;
						})(),
					);
				},
			},
		);

		assert.equal(sent.id, "dc-album");
		assert.equal(downloadCalls, 10);
		assert.equal(maximumActiveDownloads, 1);
		assert.equal(
			entries.some(
				(entry) =>
					entry.metadata?.outcome === "success" &&
					entry.metadata?.attachmentCount === 10 &&
					entry.metadata?.declaredBytes === totalBytes &&
					entry.metadata?.stagedBytes === totalBytes,
			),
			true,
		);
		for (const uploadedPath of uploadedPaths) {
			assert.equal(await pathExists(uploadedPath), false);
		}
		assert.doesNotMatch(JSON.stringify(entries), /private-sender|synthetic/iu);
	} finally {
		state.logger = originalLogger;
		state.settings.DiscordFileSizeLimit = originalLimit;
		await cleanupActiveWhatsAppDiscordMediaStaging();
		await removeTemporaryParent(temporaryParent);
	}
});

test("a retry reuses staged files without downloading WhatsApp media again", async () => {
	const temporaryParent = await createTemporaryParent();
	const originalLogger = state.logger;
	const originalLimit = state.settings.DiscordFileSizeLimit;
	const { logger, entries } = captureLogger();
	const files = [lazyAttachment(1, 5), lazyAttachment(2, 5)];
	const attemptPaths = [];
	let downloadCalls = 0;
	let sendCalls = 0;

	try {
		state.logger = logger;
		state.settings.DiscordFileSizeLimit = 1024;
		const result = await utils.discord.safeWebhookSend(
			{
				async send(args) {
					sendCalls += 1;
					const paths = args.files.map((file) => file.attachment);
					attemptPaths.push(paths);
					for (const attachmentPath of paths) {
						assert.equal(
							(await fs.promises.readFile(attachmentPath)).length,
							5,
						);
					}
					if (sendCalls === 1) {
						const error = new Error(
							"aborted https://discord.com/api/webhooks/id/private-token",
						);
						error.name = "AbortError";
						throw error;
					}
					return { id: "dc-retried" };
				},
			},
			{ content: "private message", files },
			"private-jid@s.whatsapp.net",
			{
				temporaryDirectory: temporaryParent,
				downloadWhatsAppMedia(file) {
					downloadCalls += 1;
					return Readable.from([
						Buffer.alloc(file.declaredSize, file.downloadCtx.index),
					]);
				},
			},
		);

		assert.equal(result.id, "dc-retried");
		assert.equal(sendCalls, 2);
		assert.equal(downloadCalls, 2);
		assert.deepEqual(attemptPaths[1], attemptPaths[0]);
		for (const attachmentPath of attemptPaths.flat()) {
			assert.equal(await pathExists(attachmentPath), false);
		}
		const serializedLogs = JSON.stringify(entries);
		assert.doesNotMatch(
			serializedLogs,
			/private-token|private-jid|private message/iu,
		);
		assert.match(serializedLogs, /retryable-failure/u);
		assert.match(serializedLogs, /success/u);
	} finally {
		state.logger = originalLogger;
		state.settings.DiscordFileSizeLimit = originalLimit;
		await cleanupActiveWhatsAppDiscordMediaStaging();
		await removeTemporaryParent(temporaryParent);
	}
});

test("partial staging failure uploads remaining files with an explicit notice", async () => {
	const temporaryParent = await createTemporaryParent();
	const originalLimit = state.settings.DiscordFileSizeLimit;
	const files = [
		lazyAttachment(1, 3),
		lazyAttachment(2, 3),
		lazyAttachment(3, 3),
	];
	let sentArgs;

	try {
		state.settings.DiscordFileSizeLimit = 1024;
		await utils.discord.safeWebhookSend(
			{
				async send(args) {
					sentArgs = args;
					return { id: "dc-partial" };
				},
			},
			{ content: "caption", files },
			"123@s.whatsapp.net",
			{
				temporaryDirectory: temporaryParent,
				downloadWhatsAppMedia(file) {
					if (file.downloadCtx.index === 2) {
						throw new Error("synthetic download failure");
					}
					return Readable.from([Buffer.from("abc")]);
				},
			},
		);

		assert.equal(sentArgs.files.length, 2);
		assert.match(sentArgs.content, /1 of 3 WhatsApp attachments/iu);
		assert.match(sentArgs.content, /remaining attachments are included/iu);
		for (const file of sentArgs.files) {
			assert.equal(await pathExists(file.attachment), false);
		}
	} finally {
		state.settings.DiscordFileSizeLimit = originalLimit;
		await cleanupActiveWhatsAppDiscordMediaStaging();
		await removeTemporaryParent(temporaryParent);
	}
});

test("total staging failure preserves text and sends the check-WhatsApp fallback", async () => {
	const temporaryParent = await createTemporaryParent();
	const originalLimit = state.settings.DiscordFileSizeLimit;
	let sentArgs;

	try {
		state.settings.DiscordFileSizeLimit = 1024;
		await utils.discord.safeWebhookSend(
			{
				async send(args) {
					sentArgs = args;
					return { id: "dc-fallback" };
				},
			},
			{
				content: "caption must survive",
				files: [lazyAttachment(1, 3), lazyAttachment(2, 3)],
			},
			"123@s.whatsapp.net",
			{
				temporaryDirectory: temporaryParent,
				downloadWhatsAppMedia() {
					throw new Error("synthetic download failure");
				},
			},
		);

		assert.deepEqual(sentArgs.files, []);
		assert.match(sentArgs.content, /caption must survive/u);
		assert.match(
			sentArgs.content,
			/Please check WhatsApp for the original message/u,
		);
	} finally {
		state.settings.DiscordFileSizeLimit = originalLimit;
		await cleanupActiveWhatsAppDiscordMediaStaging();
		await removeTemporaryParent(temporaryParent);
	}
});

test("staging rejects actual-size overflow and enforces a per-attachment timeout", async () => {
	const temporaryParent = await createTemporaryParent();
	try {
		assert.equal(WHATSAPP_DISCORD_MEDIA_DOWNLOAD_TIMEOUT_MS, 60_000);
		const staged = await stageWhatsAppDiscordAttachments(
			[lazyAttachment(1, 5), lazyAttachment(2, 5)],
			{
				maxBytes: 10,
				timeoutMs: 25,
				temporaryDirectory: temporaryParent,
				download(file) {
					if (file.downloadCtx.index === 1) {
						return Readable.from([Buffer.alloc(11)]);
					}
					return new Readable({ read() {} });
				},
			},
		);

		assert.deepEqual(staged.files, []);
		assert.deepEqual(
			staged.failures.map((failure) => failure.code),
			["WA2DC_MEDIA_ACTUAL_SIZE_OVERFLOW", "WA2DC_MEDIA_DOWNLOAD_TIMEOUT"],
		);
		assert.equal(staged.stagedBytes, 0);
		await staged.cleanup();
	} finally {
		await cleanupActiveWhatsAppDiscordMediaStaging();
		await removeTemporaryParent(temporaryParent);
	}
});

test("temporary attachments are cleaned when the Discord upload fails", async () => {
	const temporaryParent = await createTemporaryParent();
	const originalLimit = state.settings.DiscordFileSizeLimit;
	let stagedPath;
	try {
		state.settings.DiscordFileSizeLimit = 1024;
		await assert.rejects(
			utils.discord.safeWebhookSend(
				{
					async send(args) {
						stagedPath = args.files[0].attachment;
						assert.equal(await pathExists(stagedPath), true);
						const error = new Error("Discord rejected the request");
						error.code = 50_013;
						throw error;
					},
				},
				{ files: [lazyAttachment(1, 3)] },
				"123@s.whatsapp.net",
				{
					temporaryDirectory: temporaryParent,
					downloadWhatsAppMedia: () => Readable.from([Buffer.from("abc")]),
				},
			),
			(error) => error?.code === 50_013,
		);

		assert.equal(await pathExists(stagedPath), false);
	} finally {
		state.settings.DiscordFileSizeLimit = originalLimit;
		await cleanupActiveWhatsAppDiscordMediaStaging();
		await removeTemporaryParent(temporaryParent);
	}
});

test("shutdown cleanup removes active Discord upload staging directories", async () => {
	const temporaryParent = await createTemporaryParent();
	try {
		const staged = await stageWhatsAppDiscordAttachments(
			[lazyAttachment(1, 3)],
			{
				maxBytes: 1024,
				temporaryDirectory: temporaryParent,
				download: () => Readable.from([Buffer.from("abc")]),
			},
		);
		const stagedPath = staged.files[0].attachment;
		assert.equal(await pathExists(stagedPath), true);

		await cleanupActiveWhatsAppDiscordMediaStaging();

		assert.equal(await pathExists(stagedPath), false);
		await staged.cleanup();
	} finally {
		await cleanupActiveWhatsAppDiscordMediaStaging();
		await removeTemporaryParent(temporaryParent);
	}
});
