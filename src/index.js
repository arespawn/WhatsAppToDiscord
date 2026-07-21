import "./loadRuntimeEnvironment.js";

import nodeCrypto from "node:crypto";
import fs from "node:fs";
import pino from "pino";
import pretty from "pino-pretty";
import packageInfo from "../package.json" with { type: "json" };
import discordHandler from "./discordHandler.js";
import { resolveLogLevel } from "./logLevel.js";
import { shouldIgnoreProcessError } from "./processErrors.js";
import {
	buildProcessExitReportContent,
	getProcessExitCode,
	getProcessReportFileName,
	isShutdownEvent,
} from "./processExitReporting.js";
import state from "./state.js";
import storage from "./storage.js";
import utils from "./utils.js";
import whatsappHandler from "./whatsappHandler.js";

const isSmokeTest = process.env.WA2DC_SMOKE_TEST === "1";

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
	let autoSaver = setInterval(() => storage.save(), 5 * 60 * 1000);
	let shuttingDown = false;
	["SIGINT", "SIGTERM", "uncaughtException", "unhandledRejection"].forEach(
		(eventName) => {
			process.on(eventName, async (err) => {
				if (shouldIgnoreProcessError(eventName, err)) {
					state.logger.warn(
						{ err, eventName },
						"Ignoring recoverable Undici network error",
					);
					return;
				}
				if (shuttingDown) {
					return;
				}
				shuttingDown = true;
				clearInterval(autoSaver);
				if (err != null) {
					if (isShutdownEvent(eventName)) {
						state.logger.info(err);
					} else {
						state.logger.error(err);
					}
				}
				state.logger.info("Exiting!");
				let logs = "";
				try {
					logs = await fs.promises.readFile("logs.txt", "utf8");
					logs = logs.split("\n").slice(-20).join("\n");
				} catch (readErr) {
					void readErr;
				}
				const content = buildProcessExitReportContent({
					eventName,
					reason: err,
					logs,
				});
				const isShutdown = isShutdownEvent(eventName);
				const reportFileName = getProcessReportFileName(eventName);
				let sent = false;
				try {
					const ctrl = await utils.discord.getControlChannel();
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
				} catch (e) {
					state.logger.error("Failed to send process exit info to Discord");
					state.logger.error(e);
				}
				if (!sent && !isShutdown) {
					try {
						await fs.promises.writeFile("crash-report.txt", content, "utf8");
					} catch (e) {
						state.logger.error("Failed to write crash report to disk");
						state.logger.error(e);
					}
				}
				try {
					await storage.save();
				} catch (e) {
					state.logger.error("Failed to save storage");
					state.logger.error(e);
				}
				process.exit(getProcessExitCode(eventName));
			});
		},
	);

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

	clearInterval(autoSaver);
	autoSaver = setInterval(
		() => storage.save(),
		state.settings.autoSaveInterval * 1000,
	);
	state.logger.info("Changed auto save interval.");

	state.contacts = await storage.parseContacts();
	state.logger.info("Loaded contacts.");

	state.chats = await storage.parseChats();
	state.logger.info("Loaded chats.");

	state.startTime = await storage.parseStartTime();
	state.logger.info("Loaded last timestamp.");

	state.lastMessages = await storage.parseLastMessages();
	state.logger.info("Loaded last messages.");

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
		try {
			const crashFile = "crash-report.txt";
			const queued = await fs.promises.readFile(crashFile, "utf8");
			const ctrl = await utils.discord.getControlChannel();
			if (ctrl) {
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
				await fs.promises.unlink(crashFile);
				state.logger.info("Queued crash report sent.");
			}
		} catch (e) {
			if (e.code !== "ENOENT") {
				state.logger.error("Failed to send queued crash report");
				state.logger.error(e);
			}
		}
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

		setInterval(
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

	if (isSmokeTest) {
		clearInterval(autoSaver);
		state.logger.info("Smoke test completed successfully.");
		process.exit(0);
	}
})();
