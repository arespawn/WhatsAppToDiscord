import { loadAttachmentBuffer } from "./attachmentBuffer.js";
import { transcodeBufferWithFfmpeg } from "./ffmpeg.js";

const DISCORD_AUDIO_FETCH_MAX_BYTES = 25 * 1024 * 1024;
const DISCORD_AUDIO_TRANSCODE_TIMEOUT_MS = 20 * 1000;
const DISCORD_VOICE_NAME_HINT_REGEX = /(voice|ptt|push-?to-?talk)/i;

const normalizeMimeType = (value = "") => {
	if (typeof value !== "string") return "";
	return value.split(";")[0].trim().toLowerCase();
};

const isDiscordVoiceLikeAttachment = (attachment = {}, mimetype = "") => {
	const normalizedMime = normalizeMimeType(mimetype || attachment?.contentType);
	const name = typeof attachment?.name === "string" ? attachment.name : "";
	const durationCandidates = [
		attachment?.duration,
		attachment?.duration_secs,
		attachment?.durationSeconds,
	];
	const hasDuration = durationCandidates.some((entry) => {
		const value = Number(entry);
		return Number.isFinite(value) && value > 0;
	});
	return (
		hasDuration ||
		DISCORD_VOICE_NAME_HINT_REGEX.test(name) ||
		normalizedMime === "audio/ogg" ||
		normalizedMime === "audio/opus"
	);
};

const transcodeAudioBufferToOggOpus = (inputBuffer) =>
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
			"-c:a",
			"libopus",
			"-ar",
			"48000",
			"-avoid_negative_ts",
			"make_zero",
			"-f",
			"ogg",
			"pipe:1",
		],
		DISCORD_AUDIO_TRANSCODE_TIMEOUT_MS,
	);

export const createAudioSendContentNormalizer = ({
	getLogger = null,
	normalizeBridgeMessageId = (value) => value,
} = {}) => {
	let ffmpegMissingLogged = false;
	const loggerForCall = () =>
		typeof getLogger === "function" ? getLogger() : getLogger;

	return async ({ attachment, content, jid, discordMessageId } = {}) => {
		if (!content || typeof content !== "object" || !content.audio) {
			return content;
		}
		const normalizedMime = normalizeMimeType(
			content?.mimetype || attachment?.contentType,
		);
		if (!normalizedMime.startsWith("audio/")) {
			return content;
		}

		const logger = loggerForCall();
		const normalizedContent = { ...content };
		const isVoiceLike = isDiscordVoiceLikeAttachment(
			attachment,
			normalizedMime,
		);
		if (isVoiceLike) {
			normalizedContent.ptt = true;
			const duration =
				Number(attachment?.duration) ||
				Number(attachment?.duration_secs) ||
				Number(attachment?.durationSeconds) ||
				0;
			if (Number.isFinite(duration) && duration > 0) {
				normalizedContent.seconds = Math.max(1, Math.round(duration));
			}
		}

		let sourceBuffer = null;
		try {
			sourceBuffer = await loadAttachmentBuffer(attachment, {
				maxBytes: DISCORD_AUDIO_FETCH_MAX_BYTES,
			});
		} catch (err) {
			logger?.debug?.(
				{
					err,
					jid,
					discordMessageId: normalizeBridgeMessageId(discordMessageId),
					attachmentName: attachment?.name || null,
					mimetype: normalizedMime,
				},
				"Failed to fetch Discord audio attachment before WhatsApp send",
			);
		}
		if (!sourceBuffer?.length) {
			return normalizedContent;
		}

		normalizedContent.audio = sourceBuffer;
		if (!isVoiceLike) {
			return normalizedContent;
		}

		try {
			const transcoded = await transcodeAudioBufferToOggOpus(sourceBuffer);
			if (transcoded?.length) {
				normalizedContent.audio = transcoded;
				normalizedContent.mimetype = "audio/ogg; codecs=opus";
			}
		} catch (err) {
			if (err?.code === "ENOENT") {
				if (!ffmpegMissingLogged) {
					ffmpegMissingLogged = true;
					logger?.warn?.(
						"ffmpeg is not installed; sending Discord voice messages without opus transcode",
					);
				}
			} else {
				logger?.debug?.(
					{
						err,
						jid,
						discordMessageId: normalizeBridgeMessageId(discordMessageId),
						attachmentName: attachment?.name || null,
					},
					"Failed to transcode Discord voice message to WhatsApp-compatible opus",
				);
			}
		}

		return normalizedContent;
	};
};
