import "./loadRuntimeEnvironment.js";

import nodeCrypto from "node:crypto";
import fs from "node:fs/promises";
import pino from "pino";
import pretty from "pino-pretty";
import packageInfo from "../package.json" with { type: "json" };
import { closeDiscordRestAgent } from "./clientFactories.js";
import {
	readTextFileTail,
	replayQueuedCrashReport,
	writePendingCrashReportAtomic,
} from "./crashReportQueue.js";
import discordHandler from "./discordHandler.js";
import { cleanupActiveWhatsAppDiscordMediaStaging } from "./internal/whatsappDiscordMediaStaging.js";
import { resolveLogLevel } from "./logLevel.js";
import { shouldIgnoreProcessError } from "./processErrors.js";
import {
	buildProcessExitReportContent,
	getProcessExitCode,
	getProcessReportFileName,
	isShutdownEvent,
} from "./processExitReporting.js";
import {
	createPersistenceShutdownGate,
	createWorkerShutdownController,
	getInternalShutdownSignal,
	quiesceRuntimeIngress,
} from "./shutdown.js";
import state from "./state.js";
import storage from "./storage.js";
import utils from "./utils.js";
import whatsappHandler from "./whatsappHandler.js";

const isSmokeTest = process.env.WA2DC_SMOKE_TEST === "1";
const waitForSmokeSignal =
	isSmokeTest && process.env.WA2DC_SMOKE_WAIT_FOR_SIGNAL === "1";

if (!globalThis.crypto) {
	globalThis.crypto = nodeCrypto.webcrypto;
}

const suppressSecretBearingDependencyConsoleLogs = () => {
	const shouldSuppress = (args) =>
		args[0] === "Closing stale open session for new outgoing prekey bundle" ||
		args[0] === "Closing session:";
	const wrap = (method) => {
		const original = console[method].bind(console);
		console[method] = (...args) => {
			if (shouldSuppress(args)) {
				return;
			}
			original(...args);
		};
	};
	wrap("info");
	wrap("warn");
};

suppressSecretBearingDependencyConsoleLogs();

(async () => {
	const packageVersion =
		typeof packageInfo?.version === "string" ? packageInfo.version : "0.0.0";
	const version = packageVersion.startsWith("v")
		? packageVersion
		: `v${packageVersion}`;
	state.version = version;
	const streams = [
		{ stream: pino.destination("logs.txt") },
		{ stream: pretty({ colorize: true }) },
	];
	state.logger = pino(
		{
			level: resolveLogLevel(),
			mixin() {
				return { version };
			},
		},
		pino.multistream(streams),
	);
	let autoSaver = null;
	let updaterTimer = null;
	const persistenceShutdown = createPersistenceShutdownGate({
		save: () => storage.save(),
		close: () => storage.close(),
	});
	const stopScheduledWork = () => {
		state.shutdownRequested = true;
		if (autoSaver) {
			clearInterval(autoSaver);
			autoSaver = null;
		}
		if (updaterTimer) {
			clearInterval(updaterTimer);
			updaterTimer = null;
		}
	};
	const reportProcessExit = async ({ eventName, reason }) => {
		let logs = "";
		try {
			logs = await readTextFileTail("logs.txt");
			logs = logs.split("\n").slice(-20).join("\n");
		} catch (readErr) {
			void readErr;
		}
		const content = buildProcessExitReportContent({
			eventName,
			reason,
			logs,
		});
		const isShutdown = isShutdownEvent(eventName);
		const reportFileName = getProcessReportFileName(eventName);
		const crashFile = "crash-report.txt";
		let claimedCrashFile = null;
		if (!isShutdown) {
			claimedCrashFile = await writePendingCrashReportAtomic(
				crashFile,
				content,
			);
		}
		let sent = false;
		try {
			const ctrl = discordHandler.getCachedControlChannel();
			if (ctrl) {
				if (content.length > 2000) {
					await ctrl.send({
						content: `${content.slice(0, 1997)}...`,
						files: [
							{
								attachment: Buffer.from(content, "utf8"),
								name: reportFileName,
							},
						],
					});
				} else {
					await ctrl.send(content);
				}
				sent = true;
			}
		} catch (error) {
			state.logger.error("Failed to send process exit info to Discord");
			state.logger.error(error);
		}
		if (sent && claimedCrashFile) {
			try {
				await fs.unlink(claimedCrashFile);
			} catch (error) {
				state.logger.error("Failed to remove delivered crash report");
				state.logger.error(error);
			}
		}
	};
	const quiesceRuntime = () =>
		quiesceRuntimeIngress({
			stopDownloadServer: () => utils.stopDownloadServer(),
			cleanupDiscordUploadStaging: () =>
				cleanupActiveWhatsAppDiscordMediaStaging({ logger: state.logger }),
			endWhatsApp: () =>
				state.waClient?.end?.(new Error("Process shutting down")),
			closeWhatsAppSocket: () => state.waClient?.ws?.close?.(),
			onError(stage, error) {
				state.logger.warn({ error, stage }, "Shutdown cleanup step failed");
			},
		});
	const shutdownController = createWorkerShutdownController({
		isShutdownEvent,
		getExitCode: getProcessExitCode,
		onStart: stopScheduledWork,
		quiesce: quiesceRuntime,
		save: () => persistenceShutdown.save(),
		report: reportProcessExit,
		destroyDiscord: async () => {
			state.dcClient?.destroy?.();
			await closeDiscordRestAgent();
		},
		finalSave: () => persistenceShutdown.save(),
		closePersistence: () => persistenceShutdown.close(),
		onStageError(stage, error) {
			state.logger.error(
				{ error, stage },
				`Failed during ${stage} shutdown stage`,
			);
		},
		onStageTimeout(stage) {
			state.logger.warn(`${stage} shutdown stage timed out`);
		},
	});
	const handleProcessShutdown = (eventName, reason, source) => {
		if (!shutdownController.isShuttingDown()) {
			if (reason != null) {
				if (isShutdownEvent(eventName)) {
					state.logger.info(reason);
				} else {
					state.logger.error(reason);
				}
			}
			state.logger.info("Exiting!");
		}
		void shutdownController.handle(eventName, reason, { source });
	};
	["SIGINT", "SIGTERM", "uncaughtException", "unhandledRejection"].forEach(
		(eventName) => {
			process.on(eventName, (err) => {
				if (shouldIgnoreProcessError(eventName, err)) {
					state.logger.warn(
						{ err, eventName },
						"Ignoring recoverable Undici network error",
					);
					return;
				}
				handleProcessShutdown(eventName, err, "os");
			});
		},
	);
	process.on("message", (message) => {
		const signal = getInternalShutdownSignal(message);
		if (!signal) return;
		handleProcessShutdown(signal, signal, "supervisor-ipc");
	});

	state.logger.info("Starting");

	if (process.pkg) {
		await utils.updater.ensureRuntimeSidecar(version);
	}

	try {
		await storage.ensureInitialized();
		state.logger.info("SQLite storage initialized.");
	} catch (err) {
		state.logger.error({ err }, "Failed to initialize SQLite storage");
		process.exit(1);
	}

	state.settings = await storage.parseSettings();
	state.logger.info("Loaded settings.");
	if (isSmokeTest) {
		state.logger.info(
			"Running in smoke-test mode; external clients are skipped.",
		);
	}
	if (utils.whatsapp.normalizeMentionLinks()) {
		await storage.saveSettings().catch(() => {});
		state.logger.info("Normalized WhatsApp→Discord mention links.");
	}

	utils.ensureDownloadServer();

	state.contacts = await storage.parseContacts();
	state.logger.info("Loaded contacts.");

	state.chats = await storage.parseChats();
	state.logger.info("Loaded chats.");

	state.startTime = await storage.parseStartTime();
	state.logger.info("Loaded last timestamp.");

	state.lastMessages = await storage.parseLastMessages();
	persistenceShutdown.markHydrated();
	state.logger.info("Loaded last messages.");
	if (shutdownController.isShuttingDown()) return;
	autoSaver = setInterval(
		() => storage.save(),
		state.settings.autoSaveInterval * 1000,
	);
	state.logger.info("Changed auto save interval.");

	if (!isSmokeTest) {
		state.dcClient = await discordHandler.start();
		state.logger.info("Discord client started.");

		await utils.discord.repairChannels();
		await discordHandler.setControlChannel();
		state.logger.info("Repaired channels.");
	} else {
		state.logger.info("Skipping Discord bootstrap for smoke test.");
	}

	if (!isSmokeTest) {
		const crashFile = "crash-report.txt";
		void replayQueuedCrashReport({
			filePath: crashFile,
			async send(queued) {
				const ctrl = discordHandler.getCachedControlChannel();
				if (!ctrl) throw new Error("Discord control channel is unavailable");
				if (queued.length > 2000) {
					await ctrl.send({
						content: `${queued.slice(0, 1997)}...`,
						files: [
							{ attachment: Buffer.from(queued, "utf8"), name: "crash.txt" },
						],
					});
				} else {
					await ctrl.send(queued);
				}
			},
		})
			.then((result) => {
				if (result.status === "sent-and-removed") {
					state.logger.info("Queued crash report sent.");
				}
			})
			.catch((error) => {
				state.logger.error("Failed to send queued crash report");
				state.logger.error(error);
			});
	} else {
		state.logger.info("Skipping crash report replay for smoke test.");
	}

	if (!isSmokeTest) {
		await whatsappHandler.start();
		state.logger.info("WhatsApp client started.");
	} else {
		state.logger.info("Skipping WhatsApp bootstrap for smoke test.");
	}

	if (!isSmokeTest) {
		await utils.updater.run(version, { prompt: false });
		state.logger.info("Update checked.");
		await utils.discord.syncUpdatePrompt();
		await utils.discord.syncRollbackPrompt();

		updaterTimer = setInterval(
			async () => {
				await utils.updater.run(version, { prompt: false });
				await utils.discord.syncUpdatePrompt();
				await utils.discord.syncRollbackPrompt();
			},
			2 * 24 * 60 * 60 * 1000,
		);
	} else {
		state.logger.info("Skipping update checks for smoke test.");
	}

	state.logger.info("Bot is now running. Press CTRL-C to exit.");

	if (isSmokeTest && !waitForSmokeSignal) {
		clearInterval(autoSaver);
		state.logger.info("Smoke test completed successfully.");
		process.exit(0);
	} else if (waitForSmokeSignal) {
		state.logger.info("Smoke test is waiting for a shutdown signal.");
	}
})();
