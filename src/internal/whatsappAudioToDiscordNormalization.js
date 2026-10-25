import { transcodeBufferWithFfmpeg } from "./ffmpeg.js";

const WHATSAPP_AUDIO_TRANSCODE_TIMEOUT_MS = 20 * 1000;

const normalizeMimeType = (value = "") => {
	if (typeof value !== "string") return "";
	return value.split(";")[0].trim().toLowerCase();
};

const replaceFileExtension = (fileName = "", extension = "mp3") => {
	const trimmed = typeof fileName === "string" ? fileName.trim() : "";
	if (!trimmed) return `audio.${extension}`;
	if (!trimmed.includes(".")) {
		return `${trimmed}.${extension}`;
	}
	return trimmed.replace(/\.[^.]+$/u, `.${extension}`);
};

const transcodeAudioBufferToMp3 = (inputBuffer, maxBytes) =>
	transcodeBufferWithFfmpeg(
		inputBuffer,
		[
			"-hide_banner",
			"-loglevel",
			"error",
			"-i",
			"pipe:0",
			"-vn",
			"-ac",
			"1",
			"-ar",
			"44100",
			"-c:a",
			"libmp3lame",
			"-b:a",
			"96k",
			"-f",
			"mp3",
			"pipe:1",
		],
		WHATSAPP_AUDIO_TRANSCODE_TIMEOUT_MS,
		Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : Infinity,
	);

export const createWhatsAppAudioToDiscordFileNormalizer = ({
	getLogger = null,
	transcodeBufferToMp3 = transcodeAudioBufferToMp3,
} = {}) => {
	let ffmpegMissingLogged = false;
	const loggerForCall = () =>
		typeof getLogger === "function" ? getLogger() : getLogger;

	return async ({
		attachmentBuffer,
		fileName,
		mimetype,
		targetFormat = "original",
		jid,
		messageId,
		maxBytes = 0,
	} = {}) => {
		const normalizedMime = normalizeMimeType(mimetype);
		const normalizedName =
			typeof fileName === "string" && fileName.trim()
				? fileName.trim()
				: "audio.ogg";
		const fallback = {
			attachmentBuffer,
			fileName: normalizedName,
			contentType: normalizedMime || "audio/ogg",
			converted: false,
		};

		if (
			targetFormat !== "mp3" ||
			!attachmentBuffer?.length ||
			!normalizedMime.startsWith("audio/")
		) {
			return fallback;
		}

		const logger = loggerForCall();
		try {
			const mp3Buffer = await (transcodeBufferToMp3 ===
			transcodeAudioBufferToMp3
				? transcodeAudioBufferToMp3(attachmentBuffer, maxBytes)
				: transcodeBufferToMp3(attachmentBuffer));
			if (!mp3Buffer?.length) {
				return fallback;
			}
			if (
				Number.isFinite(maxBytes) &&
				maxBytes > 0 &&
				mp3Buffer.length > maxBytes
			) {
				logger?.debug?.(
					{
						jid,
						messageId: messageId || null,
						fileName: normalizedName,
						outputBytes: mp3Buffer.length,
						maxBytes,
					},
					"Skipping WhatsApp audio MP3 conversion because output exceeds Discord upload limit",
				);
				return fallback;
			}
			return {
				attachmentBuffer: mp3Buffer,
				fileName: replaceFileExtension(normalizedName, "mp3"),
				contentType: "audio/mpeg",
				converted: true,
			};
		} catch (err) {
			if (err?.code === "ENOENT") {
				if (!ffmpegMissingLogged) {
					ffmpegMissingLogged = true;
					logger?.warn?.(
						"ffmpeg is not installed; WhatsApp audio will be mirrored to Discord without MP3 conversion",
					);
				}
			} else {
				logger?.debug?.(
					{
						err,
						jid,
						messageId: messageId || null,
						fileName: normalizedName,
					},
					"Failed to transcode WhatsApp audio to a Discord MP3 attachment",
				);
			}
		}

		return fallback;
	};
};
