import { transcodeBufferWithFfmpeg } from "./ffmpeg.js";

const WHATSAPP_GIF_TRANSCODE_TIMEOUT_MS = 20 * 1000;

const normalizeMimeType = (value = "") => {
	if (typeof value !== "string") return "";
	return value.split(";")[0].trim().toLowerCase();
};

const replaceFileExtension = (fileName = "", extension = "gif") => {
	const trimmed = typeof fileName === "string" ? fileName.trim() : "";
	if (!trimmed) return `videoMessage.${extension}`;
	if (!trimmed.includes(".")) {
		return `${trimmed}.${extension}`;
	}
	return trimmed.replace(/\.[^.]+$/u, `.${extension}`);
};

const transcodeVideoBufferToGif = (inputBuffer, maxBytes) =>
	transcodeBufferWithFfmpeg(
		inputBuffer,
		[
			"-hide_banner",
			"-loglevel",
			"error",
			"-i",
			"pipe:0",
			"-an",
			"-vf",
			"fps=12,split[s0][s1];[s0]palettegen=reserve_transparent=0[p];[s1][p]paletteuse",
			"-loop",
			"0",
			"-f",
			"gif",
			"pipe:1",
		],
		WHATSAPP_GIF_TRANSCODE_TIMEOUT_MS,
		Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : Infinity,
	);

export const createWhatsAppGifToDiscordFileNormalizer = ({
	getLogger = null,
	transcodeBufferToGif = transcodeVideoBufferToGif,
} = {}) => {
	let ffmpegMissingLogged = false;
	const loggerForCall = () =>
		typeof getLogger === "function" ? getLogger() : getLogger;

	return async ({
		attachmentBuffer,
		fileName,
		mimetype,
		jid,
		messageId,
		maxBytes = 0,
	} = {}) => {
		const normalizedMime = normalizeMimeType(mimetype);
		const normalizedName =
			typeof fileName === "string" && fileName.trim()
				? fileName.trim()
				: "videoMessage.mp4";
		if (!attachmentBuffer?.length || !normalizedMime.startsWith("video/")) {
			return {
				attachmentBuffer,
				fileName: normalizedName,
				contentType: normalizedMime || "application/octet-stream",
				converted: false,
			};
		}

		const logger = loggerForCall();
		try {
			const gifBuffer = await (transcodeBufferToGif ===
			transcodeVideoBufferToGif
				? transcodeVideoBufferToGif(attachmentBuffer, maxBytes)
				: transcodeBufferToGif(attachmentBuffer));
			if (
				Number.isFinite(maxBytes) &&
				maxBytes > 0 &&
				gifBuffer?.length > maxBytes
			) {
				throw new Error("ffmpeg_output_limit_exceeded");
			}
			if (gifBuffer?.length) {
				return {
					attachmentBuffer: gifBuffer,
					fileName: replaceFileExtension(normalizedName, "gif"),
					contentType: "image/gif",
					converted: true,
				};
			}
		} catch (err) {
			if (err?.code === "ENOENT") {
				if (!ffmpegMissingLogged) {
					ffmpegMissingLogged = true;
					logger?.warn?.(
						"ffmpeg is not installed; WhatsApp GIFs will be mirrored to Discord as videos",
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
					"Failed to transcode WhatsApp GIF to a Discord GIF attachment",
				);
			}
		}

		return {
			attachmentBuffer,
			fileName: normalizedName,
			contentType: normalizedMime || "video/mp4",
			converted: false,
		};
	};
};
