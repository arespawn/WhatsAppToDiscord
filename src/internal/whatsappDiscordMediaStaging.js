import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export const WHATSAPP_DISCORD_MEDIA_DOWNLOAD_TIMEOUT_MS = 60_000;

const STAGING_DIRECTORY_PREFIX = "wa2dc-discord-upload-";
const activeStagingDirectories = new Set();

const asFiniteBytes = (value) => {
	const bytes = Number(value);
	return Number.isFinite(bytes) && bytes >= 0 ? Math.floor(bytes) : 0;
};

const asSafeErrorCode = (error, fallback) => {
	const candidate = String(error?.code || error?.name || "")
		.replace(/[^a-zA-Z0-9_-]/gu, "")
		.slice(0, 64);
	return candidate || fallback;
};

const createDownloadTimeoutError = () => {
	const error = new Error("WhatsApp attachment download timed out");
	error.name = "AbortError";
	error.code = "WA2DC_MEDIA_DOWNLOAD_TIMEOUT";
	return error;
};

const createActualSizeOverflowError = () => {
	const error = new Error("WhatsApp attachment exceeds Discord's upload limit");
	error.code = "WA2DC_MEDIA_ACTUAL_SIZE_OVERFLOW";
	return error;
};

export const isLazyWhatsAppDiscordAttachment = (file) =>
	Boolean(
		file &&
			typeof file === "object" &&
			file.wa2dcLazyWhatsAppMedia === true &&
			file.downloadCtx,
	);

const buildStagedAttachment = (file, attachmentPath) => {
	const staged = { ...file, attachment: attachmentPath };
	delete staged.downloadCtx;
	delete staged.declaredSize;
	delete staged.msgType;
	delete staged.wa2dcLazyWhatsAppMedia;
	return staged;
};

const removeStagingDirectory = async (directory, logger) => {
	if (!directory) return;
	activeStagingDirectories.delete(directory);
	try {
		await fs.promises.rm(directory, { recursive: true, force: true });
	} catch (error) {
		logger?.warn?.(
			{
				errorCode: asSafeErrorCode(error, "WA2DC_MEDIA_CLEANUP_FAILED"),
				outcome: "cleanup-failed",
			},
			"Failed to clean temporary Discord upload staging files.",
		);
	}
};

export const cleanupActiveWhatsAppDiscordMediaStaging = async ({
	logger,
} = {}) => {
	const directories = [...activeStagingDirectories];
	await Promise.allSettled(
		directories.map((directory) => removeStagingDirectory(directory, logger)),
	);
};

export const stageWhatsAppDiscordAttachments = async (
	files,
	{
		download,
		maxBytes,
		timeoutMs = WHATSAPP_DISCORD_MEDIA_DOWNLOAD_TIMEOUT_MS,
		logger,
		temporaryDirectory = os.tmpdir(),
		now = Date.now,
	} = {},
) => {
	const normalizedFiles = Array.isArray(files) ? files.filter(Boolean) : [];
	const lazyAttachments = normalizedFiles.filter(
		isLazyWhatsAppDiscordAttachment,
	);
	const attachmentCount = lazyAttachments.length;
	const declaredBytes = lazyAttachments.reduce(
		(total, file) => total + asFiniteBytes(file.declaredSize),
		0,
	);
	const startedAt = now();

	if (!attachmentCount) {
		return {
			files: normalizedFiles,
			failures: [],
			attachmentCount: 0,
			declaredBytes: 0,
			stagedBytes: 0,
			durationMs: 0,
			cleanup: async () => {},
		};
	}

	logger?.info?.(
		{
			attachmentCount,
			declaredBytes,
			stagedBytes: 0,
			durationMs: 0,
			outcome: "started",
		},
		"Staging WhatsApp attachments for Discord upload.",
	);

	let stagingDirectory;
	try {
		stagingDirectory = await fs.promises.mkdtemp(
			path.join(temporaryDirectory, STAGING_DIRECTORY_PREFIX),
		);
		await fs.promises.chmod(stagingDirectory, 0o700);
		activeStagingDirectories.add(stagingDirectory);
	} catch (error) {
		if (stagingDirectory) {
			await fs.promises
				.rm(stagingDirectory, { recursive: true, force: true })
				.catch(() => {});
		}
		const failures = lazyAttachments.map((_, index) => ({
			index,
			code: asSafeErrorCode(error, "WA2DC_MEDIA_STAGING_SETUP_FAILED"),
		}));
		const durationMs = Math.max(0, now() - startedAt);
		logger?.warn?.(
			{
				attachmentCount,
				declaredBytes,
				stagedBytes: 0,
				durationMs,
				failedCount: failures.length,
				outcome: "failed",
				errorCode: failures[0]?.code,
			},
			"Failed to create temporary Discord upload staging storage.",
		);
		return {
			files: normalizedFiles.filter(
				(file) => !isLazyWhatsAppDiscordAttachment(file),
			),
			failures,
			attachmentCount,
			declaredBytes,
			stagedBytes: 0,
			durationMs,
			cleanup: async () => {},
		};
	}

	const byteLimit = Number.isFinite(Number(maxBytes))
		? Math.max(0, Math.floor(Number(maxBytes)))
		: Number.POSITIVE_INFINITY;
	const perAttachmentTimeoutMs = Number.isFinite(Number(timeoutMs))
		? Math.max(1, Math.floor(Number(timeoutMs)))
		: WHATSAPP_DISCORD_MEDIA_DOWNLOAD_TIMEOUT_MS;
	const failures = [];
	const stagedByFile = new Map();
	let stagedBytes = 0;
	let lazyIndex = 0;

	for (const file of normalizedFiles) {
		if (!isLazyWhatsAppDiscordAttachment(file)) continue;
		const attachmentIndex = lazyIndex;
		lazyIndex += 1;
		const attachmentStartedAt = now();
		const attachmentPath = path.join(
			stagingDirectory,
			`${String(attachmentIndex + 1).padStart(2, "0")}.attachment`,
		);
		const abortController = new AbortController();
		const timeoutError = createDownloadTimeoutError();
		let timedOut = false;
		const timeout = setTimeout(() => {
			timedOut = true;
			abortController.abort(timeoutError);
		}, perAttachmentTimeoutMs);
		let attachmentBytes = 0;

		try {
			if (typeof download !== "function") {
				const error = new Error("WhatsApp media downloader is unavailable");
				error.code = "WA2DC_MEDIA_DOWNLOADER_UNAVAILABLE";
				throw error;
			}

			const abortPromise = new Promise((_, reject) => {
				abortController.signal.addEventListener(
					"abort",
					() => reject(abortController.signal.reason || timeoutError),
					{ once: true },
				);
			});
			const downloadPromise = Promise.resolve().then(() =>
				download(file, { signal: abortController.signal }),
			);
			downloadPromise.then(
				(source) => {
					if (abortController.signal.aborted) {
						source?.destroy?.(abortController.signal.reason);
					}
				},
				() => {},
			);
			const source = await Promise.race([downloadPromise, abortPromise]);
			const byteCounter = new Transform({
				transform(chunk, encoding, callback) {
					const chunkBytes = Buffer.isBuffer(chunk)
						? chunk.length
						: Buffer.byteLength(chunk, encoding);
					attachmentBytes += chunkBytes;
					if (attachmentBytes > byteLimit) {
						callback(createActualSizeOverflowError());
						return;
					}
					callback(null, chunk);
				},
			});
			const destination = fs.createWriteStream(attachmentPath, {
				flags: "wx",
				mode: 0o600,
			});
			await pipeline(source, byteCounter, destination, {
				signal: abortController.signal,
			});
			await fs.promises.chmod(attachmentPath, 0o600);
			stagedBytes += attachmentBytes;
			stagedByFile.set(file, buildStagedAttachment(file, attachmentPath));
		} catch (error) {
			await fs.promises.rm(attachmentPath, { force: true }).catch(() => {});
			const code = timedOut
				? "WA2DC_MEDIA_DOWNLOAD_TIMEOUT"
				: asSafeErrorCode(error, "WA2DC_MEDIA_DOWNLOAD_FAILED");
			failures.push({ index: attachmentIndex, code });
			logger?.warn?.(
				{
					attachmentCount,
					attachmentIndex: attachmentIndex + 1,
					declaredBytes: asFiniteBytes(file.declaredSize),
					stagedBytes: 0,
					durationMs: Math.max(0, now() - attachmentStartedAt),
					outcome: "failed",
					errorCode: code,
				},
				"Failed to stage a WhatsApp attachment for Discord upload.",
			);
		} finally {
			clearTimeout(timeout);
		}
	}

	const stagedFiles = normalizedFiles.flatMap((file) => {
		if (!isLazyWhatsAppDiscordAttachment(file)) return [file];
		const staged = stagedByFile.get(file);
		return staged ? [staged] : [];
	});
	const durationMs = Math.max(0, now() - startedAt);
	const outcome = failures.length
		? stagedByFile.size
			? "partial"
			: "failed"
		: "success";

	logger?.info?.(
		{
			attachmentCount,
			declaredBytes,
			stagedBytes,
			durationMs,
			failedCount: failures.length,
			outcome,
		},
		"Finished staging WhatsApp attachments for Discord upload.",
	);

	let cleaned = false;
	const cleanup = async () => {
		if (cleaned) return;
		cleaned = true;
		await removeStagingDirectory(stagingDirectory, logger);
	};

	return {
		files: stagedFiles,
		failures,
		attachmentCount,
		declaredBytes,
		stagedBytes,
		durationMs,
		cleanup,
	};
};
