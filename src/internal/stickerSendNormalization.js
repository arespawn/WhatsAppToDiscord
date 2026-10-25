import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { loadAttachmentBuffer } from "./attachmentBuffer.js";

const require = createRequire(path.resolve(process.cwd(), "package.json"));

const DISCORD_STICKER_FETCH_MAX_BYTES = 8 * 1024 * 1024;
const DISCORD_STICKER_TARGET_SIZE = 512;
const DISCORD_STICKER_TARGET_FPS = 15;
const DISCORD_STICKER_MAX_FRAMES = 120;
const DISCORD_STICKER_WEBP_QUALITY = 72;
const DISCORD_STICKER_WEBP_EFFORT = 4;
const DISCORD_STICKER_LOTTIE_FORMAT = 3;

let packagedRuntimeRequire = null;
let stickerDependencyPromise = null;
let lottieBootstrapPromise = null;

const normalizeMimeType = (value = "") => {
	if (typeof value !== "string") return "";
	return value.split(";")[0].trim().toLowerCase();
};

const getStickerRuntimeRequire = () => {
	if (!process.pkg) {
		return require;
	}
	if (!packagedRuntimeRequire) {
		const runtimePackagePath = path.join(
			path.dirname(process.execPath),
			"runtime",
			"package.json",
		);
		packagedRuntimeRequire = createRequire(runtimePackagePath);
	}
	return packagedRuntimeRequire;
};

const loadStickerDependencies = async () => {
	if (!stickerDependencyPromise) {
		stickerDependencyPromise = (async () => {
			try {
				const runtimeRequire = getStickerRuntimeRequire();
				const jsdomMod = runtimeRequire("jsdom");
				const canvasMod = runtimeRequire("canvas");
				const JSDOM = jsdomMod?.JSDOM || null;
				const lottiePlayerPath = runtimeRequire.resolve(
					"lottie-web/build/player/lottie.js",
				);
				if (
					!JSDOM ||
					typeof canvasMod?.createCanvas !== "function" ||
					typeof canvasMod?.loadImage !== "function" ||
					!lottiePlayerPath
				) {
					return null;
				}
				return {
					JSDOM,
					canvasMod,
					lottiePlayerPath,
				};
			} catch {
				return null;
			}
		})();
	}
	return stickerDependencyPromise;
};

const loadLottieBootstrap = (lottiePlayerPath) => {
	if (!lottieBootstrapPromise) {
		lottieBootstrapPromise = fs.promises
			.readFile(lottiePlayerPath, "utf8")
			.then((playerSource) => {
				const patchedSource = playerSource.replace(
					"function ImagePreloaderFactory() {",
					`function createImgData(assetData) {
  var path = getAssetsPath(assetData, this.assetsPath, this.path);
  var ob = { assetData };
  loadImage(path).then(image => {
    ob.img = image;
    this._imageLoaded();
  });
  return ob;
}; function ImagePreloaderFactory() {`,
				);
				return new Function(
					"window",
					"document",
					"navigator",
					"Canvas",
					"loadImage",
					`const exports = undefined;
const module = undefined;
const self = window;
const global = window;
const globalThis = window;
const Image = Canvas.Image;
const setTimeout = window.setTimeout.bind(window);
const clearTimeout = window.clearTimeout.bind(window);
const setInterval = window.setInterval.bind(window);
const clearInterval = window.clearInterval.bind(window);
${patchedSource}
return window.lottie;`,
				);
			});
	}
	return lottieBootstrapPromise;
};

const buildLottieAnimationRenderer = async (animationData) => {
	const deps = await loadStickerDependencies();
	if (!deps) {
		return null;
	}
	const { JSDOM, canvasMod, lottiePlayerPath } = deps;
	const bootstrapLottie = await loadLottieBootstrap(lottiePlayerPath);

	const { Canvas, createCanvas, loadImage } = canvasMod;
	const width = Math.max(
		1,
		Number(animationData?.w) || DISCORD_STICKER_TARGET_SIZE,
	);
	const height = Math.max(
		1,
		Number(animationData?.h) || DISCORD_STICKER_TARGET_SIZE,
	);
	const { window } = new JSDOM("<!doctype html><body></body>", {
		pretendToBeVisual: true,
	});
	try {
		const { document } = window;
		const originalCreateElement = document.createElement.bind(document);
		document.createElement = (localName) =>
			localName === "canvas" ? new Canvas() : originalCreateElement(localName);

		bootstrapLottie(window, document, window.navigator, Canvas, loadImage);
		if (typeof window?.lottie?.loadAnimation !== "function") {
			throw new Error("lottie_player_unavailable");
		}
		const canvas = createCanvas(width, height);
		const animation = window.lottie.loadAnimation({
			animationData,
			renderer: "canvas",
			rendererSettings: {
				context: canvas.getContext("2d"),
				clearCanvas: true,
			},
		});
		return {
			window,
			canvas,
			animation,
			loadImage,
		};
	} catch (error) {
		window.close();
		throw error;
	}
};

const renderLottieStickerFrameBuffers = async (animationData) => {
	const renderer = await buildLottieAnimationRenderer(animationData);
	if (!renderer) {
		return null;
	}
	const { animation, canvas, window } = renderer;
	try {
		const totalFrames = Math.max(
			1,
			Math.round(
				Number(animation?.totalFrames) || Number(animationData?.op) || 1,
			),
		);
		const sourceFrameRate = Math.max(
			1,
			Math.round(
				Number(animation?.frameRate) || Number(animationData?.fr) || 1,
			),
		);
		const targetFrameRate = Math.max(
			1,
			Math.min(DISCORD_STICKER_TARGET_FPS, sourceFrameRate),
		);
		const estimatedFrameCount = Math.max(
			1,
			Math.round((totalFrames / sourceFrameRate) * targetFrameRate),
		);
		const frameCount = Math.max(
			1,
			Math.min(totalFrames, estimatedFrameCount, DISCORD_STICKER_MAX_FRAMES),
		);
		const frameBuffers = [];
		for (let index = 0; index < frameCount; index += 1) {
			const progress = frameCount === 1 ? 0 : index / (frameCount - 1);
			const sourceFrame = Math.round(progress * Math.max(0, totalFrames - 1));
			animation.goToAndStop(sourceFrame, true);
			await new Promise((resolve) => setImmediate(resolve));
			frameBuffers.push(canvas.toBuffer("image/png"));
		}
		return {
			frameBuffers,
			frameRate: targetFrameRate,
		};
	} finally {
		try {
			animation.destroy?.();
		} catch {}
		try {
			window.close?.();
		} catch {}
	}
};

const encodePngSequenceToAnimatedSticker = async ({
	frameBuffers = [],
	frameRate = DISCORD_STICKER_TARGET_FPS,
	getImageSharp,
} = {}) => {
	if (!frameBuffers.length) {
		return null;
	}
	if (typeof getImageSharp !== "function") {
		return null;
	}
	const sharp = await getImageSharp();
	if (!sharp) {
		return null;
	}
	const delayMs = Math.max(1, Math.round(1000 / Math.max(1, frameRate)));
	return await sharp(frameBuffers, {
		animated: true,
		join: { animated: true },
	})
		.resize({
			width: DISCORD_STICKER_TARGET_SIZE,
			height: DISCORD_STICKER_TARGET_SIZE,
			fit: "contain",
			background: { r: 0, g: 0, b: 0, alpha: 0 },
		})
		.webp({
			quality: DISCORD_STICKER_WEBP_QUALITY,
			effort: DISCORD_STICKER_WEBP_EFFORT,
			loop: 0,
			delay: new Array(frameBuffers.length).fill(delayMs),
		})
		.toBuffer();
};

const convertRasterStickerBufferToWebp = async ({
	sourceBuffer,
	getImageSharp,
} = {}) => {
	if (!sourceBuffer?.length || typeof getImageSharp !== "function") {
		return null;
	}
	const sharp = await getImageSharp();
	if (!sharp) {
		return null;
	}
	const sourceImage = sharp(sourceBuffer, { animated: true });
	const metadata = await sourceImage.metadata();
	const frameCount = Number(metadata?.pages) || 1;
	const webpBuffer = await sourceImage
		.resize({
			width: DISCORD_STICKER_TARGET_SIZE,
			height: DISCORD_STICKER_TARGET_SIZE,
			fit: "contain",
			background: { r: 0, g: 0, b: 0, alpha: 0 },
		})
		.webp({
			quality: DISCORD_STICKER_WEBP_QUALITY,
			effort: DISCORD_STICKER_WEBP_EFFORT,
			loop: 0,
		})
		.toBuffer();
	return {
		webpBuffer,
		isAnimated: frameCount > 1,
	};
};

const isLottieStickerAttachment = (attachment = {}, mimetype = "") =>
	Number(attachment?.discordStickerFormat) === DISCORD_STICKER_LOTTIE_FORMAT ||
	mimetype === "application/json";

export const createStickerSendContentNormalizer = ({
	getLogger = null,
	normalizeBridgeMessageId = (value) => value,
	getImageSharp = async () => null,
	fetchBuffer = null,
} = {}) => {
	let lottieDependencyMissingLogged = false;
	const loggerForCall = () =>
		typeof getLogger === "function" ? getLogger() : getLogger;
	return async ({ attachment, jid, discordMessageId } = {}) => {
		if (!attachment?.isSticker) {
			return null;
		}
		const logger = loggerForCall();
		const normalizedMime = normalizeMimeType(attachment?.contentType);
		let sourceBuffer = null;
		try {
			sourceBuffer = await loadAttachmentBuffer(attachment, {
				maxBytes: DISCORD_STICKER_FETCH_MAX_BYTES,
				accept: "image/*,application/json;q=0.9,*/*;q=0.8",
				fetchBuffer,
			});
		} catch (err) {
			logger?.debug?.(
				{
					err,
					jid,
					discordMessageId: normalizeBridgeMessageId(discordMessageId),
					attachmentName: attachment?.name || null,
					mimetype: normalizedMime || null,
				},
				"Failed to fetch Discord sticker attachment before WhatsApp send",
			);
			return null;
		}
		if (!sourceBuffer?.length) {
			return null;
		}

		try {
			if (isLottieStickerAttachment(attachment, normalizedMime)) {
				const animationData = JSON.parse(sourceBuffer.toString("utf8"));
				const renderedFrames =
					await renderLottieStickerFrameBuffers(animationData);
				if (!renderedFrames?.frameBuffers?.length) {
					if (!lottieDependencyMissingLogged) {
						lottieDependencyMissingLogged = true;
						logger?.warn?.(
							"Discord Lottie sticker support is unavailable because the runtime renderer dependencies could not be loaded",
						);
					}
					return null;
				}
				const animatedStickerBuffer = await encodePngSequenceToAnimatedSticker({
					frameBuffers: renderedFrames.frameBuffers,
					frameRate: renderedFrames.frameRate,
					getImageSharp,
				});
				if (!animatedStickerBuffer?.length) {
					return null;
				}
				return {
					sticker: animatedStickerBuffer,
					mimetype: "image/webp",
					isAnimated: true,
					width: DISCORD_STICKER_TARGET_SIZE,
					height: DISCORD_STICKER_TARGET_SIZE,
				};
			}

			const normalizedSticker = await convertRasterStickerBufferToWebp({
				sourceBuffer,
				getImageSharp,
			});
			if (!normalizedSticker?.webpBuffer?.length) {
				return null;
			}
			return {
				sticker: normalizedSticker.webpBuffer,
				mimetype: "image/webp",
				isAnimated: Boolean(normalizedSticker.isAnimated),
				width: DISCORD_STICKER_TARGET_SIZE,
				height: DISCORD_STICKER_TARGET_SIZE,
			};
		} catch (err) {
			logger?.debug?.(
				{
					err,
					jid,
					discordMessageId: normalizeBridgeMessageId(discordMessageId),
					attachmentName: attachment?.name || null,
					mimetype: normalizedMime || null,
				},
				"Failed to convert Discord sticker to WhatsApp sticker payload",
			);
			return null;
		}
	};
};
