import { spawn } from "node:child_process";
import cluster from "node:cluster";
import fs from "node:fs";
import path from "node:path";
import pino from "pino";
import pretty from "pino-pretty";

import { resolveLogLevel } from "./logLevel.js";
import {
	consumeRestartFlagSync,
	createUpdateValidationState,
	evaluateUpdateValidationExit,
	evaluateWorkerExit,
	resolveMaxRestarts,
	resolveRestartDelayMs,
	resolveRestartFlagPath,
	resolveSafeRuntimeResetWindowMs,
	revertPackagedArtifactsToBackupSync,
	UPDATE_VALIDATION_WINDOW_MS,
} from "./runnerLogic.js";

const RESTART_DELAY = resolveRestartDelayMs(process.env.WA2DC_RESTART_DELAY);
const SAFE_RUNTIME_RESET_WINDOW =
	resolveSafeRuntimeResetWindowMs(RESTART_DELAY);
const MAX_RESTARTS = resolveMaxRestarts(process.env.WA2DC_MAX_RESTARTS);
const RESTART_FLAG_PATH = resolveRestartFlagPath(
	process.env.WA2DC_RESTART_FLAG_PATH,
	process.cwd(),
);
const CURRENT_EXE_NAME = process.argv0.split(/[/\\]/).pop();

const WORKER_ENV_FLAG = "WA2DC_WORKER";

async function runWorker() {
	await import("./index.js");
}

function setupSupervisorLogging() {
	const logger = pino(
		{ level: resolveLogLevel() },
		pino.multistream([
			{ stream: pino.destination("logs.txt") },
			{ stream: pretty({ colorize: true }) },
		]),
	);

	const termLogPath = path.resolve(process.cwd(), "terminal.log");
	const termLog = fs.createWriteStream(termLogPath, { flags: "a" });
	termLog.on("error", (err) =>
		logger?.warn?.({ err }, "terminal.log write error"),
	);

	const origStdoutWrite = process.stdout.write.bind(process.stdout);
	const origStderrWrite = process.stderr.write.bind(process.stderr);
	const tee = (orig) => (chunk, encoding, cb) => {
		termLog.write(chunk, encoding, () => {});
		return orig(chunk, encoding, cb);
	};
	process.stdout.write = tee(origStdoutWrite);
	process.stderr.write = tee(origStderrWrite);

	process.on("exit", () => {
		termLog.end();
	});

	return logger;
}

function createUpdateValidationTracker({ logger, canAutoRollback }) {
	let pendingUpdateValidation = null;
	let healthyTimer = null;

	const clearHealthyTimer = () => {
		if (!healthyTimer) {
			return;
		}
		clearTimeout(healthyTimer);
		healthyTimer = null;
	};

	const clearValidationState = () => {
		pendingUpdateValidation = null;
		clearHealthyTimer();
	};

	const armValidation = (targetVersion) => {
		if (!canAutoRollback) {
			return;
		}
		pendingUpdateValidation = createUpdateValidationState({ targetVersion });
		logger.info(
			`Update restart detected${pendingUpdateValidation.version ? ` (${pendingUpdateValidation.version})` : ""}. ` +
				"Enabling startup validation with automatic rollback.",
		);
	};

	const onWorkerStarted = () => {
		if (!pendingUpdateValidation?.active) {
			return;
		}

		clearHealthyTimer();
		healthyTimer = setTimeout(() => {
			if (!pendingUpdateValidation?.active) {
				return;
			}
			logger.info(
				`Updated worker stayed up for ${UPDATE_VALIDATION_WINDOW_MS / 1000}s. ` +
					"Marking update as healthy and clearing auto-rollback validation.",
			);
			clearValidationState();
		}, UPDATE_VALIDATION_WINDOW_MS);
		if (typeof healthyTimer.unref === "function") {
			healthyTimer.unref();
		}
	};

	const onWorkerExit = ({ exitCode, runtimeMs }) => {
		if (!canAutoRollback || !pendingUpdateValidation?.active) {
			return { shouldAttemptRollback: false };
		}

		const validationDecision = evaluateUpdateValidationExit({
			validationState: pendingUpdateValidation,
			exitCode,
			runtimeMs,
			healthyWindowMs: UPDATE_VALIDATION_WINDOW_MS,
		});
		pendingUpdateValidation = validationDecision.validationState;

		if (!pendingUpdateValidation?.active) {
			clearHealthyTimer();
			if (validationDecision.reason === "healthy-runtime") {
				logger.info(
					`Updated worker passed startup validation (${UPDATE_VALIDATION_WINDOW_MS / 1000}s uptime before exit).`,
				);
			}
		}

		return { shouldAttemptRollback: validationDecision.shouldAttemptRollback };
	};

	const applyRollback = () => {
		const rollbackResult = revertPackagedArtifactsToBackupSync({
			currentExeName: CURRENT_EXE_NAME,
			execPath: process.execPath,
			cwd: process.cwd(),
		});
		if (rollbackResult.success) {
			logger.warn(
				{
					backupPath: rollbackResult.backupPath,
					currentPath: rollbackResult.currentPath,
					runtimeBackupPath: rollbackResult.runtimeBackupPath,
					runtimePath: rollbackResult.runtimePath,
				},
				"Automatic rollback applied after update crash loop.",
			);
			clearValidationState();
			return true;
		}

		logger.error(
			{ reason: rollbackResult.reason, err: rollbackResult.err },
			"Automatic rollback failed; continuing normal crash restart policy.",
		);
		return false;
	};

	return {
		armValidation,
		onWorkerStarted,
		onWorkerExit,
		applyRollback,
		clearValidationState,
	};
}

async function runSupervisorWithSpawn() {
	const logger = setupSupervisorLogging();
	const updateValidation = createUpdateValidationTracker({
		logger,
		canAutoRollback: Boolean(process.pkg),
	});

	let restartAttempts = 0;
	let workerStartTime = 0;
	let currentWorker = null;
	let shuttingDown = false;

	const handleExit = (code, signal) => {
		if (shuttingDown) {
			process.exit(code ?? 0);
		}

		const runtime = Date.now() - workerStartTime;
		const restartRequest = consumeRestartFlagSync(RESTART_FLAG_PATH, {
			logger,
		});

		if (restartRequest.requested && restartRequest.reason === "update") {
			updateValidation.armValidation(restartRequest.targetVersion);
		}

		if (!restartRequest.requested) {
			const validationExit = updateValidation.onWorkerExit({
				exitCode: code,
				runtimeMs: runtime,
			});
			if (validationExit.shouldAttemptRollback) {
				if (updateValidation.applyRollback()) {
					restartAttempts = 0;
					setImmediate(start);
					return;
				}
			}
		}

		const decision = evaluateWorkerExit({
			exitCode: code,
			restartRequested: restartRequest.requested,
			runtimeMs: runtime,
			safeRuntimeResetWindowMs: SAFE_RUNTIME_RESET_WINDOW,
			restartAttempts,
			maxRestarts: MAX_RESTARTS,
			restartDelayMs: RESTART_DELAY,
		});

		restartAttempts = decision.restartAttempts;

		if (decision.action === "exit") {
			if (decision.reason === "max-restarts") {
				logger.error(
					`Maximum restart attempts (${MAX_RESTARTS}) reached. Exiting.`,
				);
			}
			process.exit(decision.exitCode);
			return;
		}

		if (decision.reason === "restart-flag") {
			logger.info(
				`Restart flag detected (${restartRequest.reason}). Restarting immediately.`,
			);
			setImmediate(start);
			return;
		}

		const reason =
			code !== 0 ? ` unexpectedly with code ${code ?? signal}` : "";
		logger.error(
			`Bot exited${reason}. Restarting in ${decision.delayMs / 1000}s (attempt ${restartAttempts}/${MAX_RESTARTS})...`,
		);
		setTimeout(start, decision.delayMs);
	};

	const start = () => {
		workerStartTime = Date.now();
		updateValidation.onWorkerStarted();
		currentWorker = spawn(process.execPath, [], {
			env: { ...process.env, [WORKER_ENV_FLAG]: "1" },
			// biome-ignore format: keep single-quoted tuple for stdin regression guard
			stdio: ['inherit', 'pipe', 'pipe'],
		});

		currentWorker.stdout?.pipe(process.stdout);
		currentWorker.stderr?.pipe(process.stderr);

		currentWorker.once("exit", (code, signal) => {
			currentWorker = null;
			handleExit(code, signal);
		});

		currentWorker.once("error", (err) => {
			logger.error({ err }, "Worker process error");
		});
	};

	["SIGINT", "SIGTERM"].forEach((sig) => {
		process.on(sig, () => {
			shuttingDown = true;
			updateValidation.clearValidationState();
			if (currentWorker && !currentWorker.killed) {
				currentWorker.kill(sig);
			}
		});
	});

	start();
}

async function main() {
	if (process.env[WORKER_ENV_FLAG] === "1") {
		await runWorker();
		return;
	}

	if (process.pkg) {
		await runSupervisorWithSpawn();
		return;
	}

	if (!cluster.isPrimary) {
		await runWorker();
		return;
	}

	const clusterExecArgv = process.pkg ? [] : ["--no-deprecation"];

	cluster.setupPrimary({ execArgv: clusterExecArgv, silent: true });

	const logger = setupSupervisorLogging();
	const updateValidation = createUpdateValidationTracker({
		logger,
		canAutoRollback: Boolean(process.pkg),
	});

	let restartAttempts = 0;
	let workerStartTime = 0;
	let currentWorker = null;
	let shuttingDown = false;

	const handleExit = (code, signal) => {
		if (shuttingDown) {
			process.exit(code ?? 0);
		}

		const runtime = Date.now() - workerStartTime;
		const restartRequest = consumeRestartFlagSync(RESTART_FLAG_PATH, {
			logger,
		});

		if (restartRequest.requested && restartRequest.reason === "update") {
			updateValidation.armValidation(restartRequest.targetVersion);
		}

		if (!restartRequest.requested) {
			const validationExit = updateValidation.onWorkerExit({
				exitCode: code,
				runtimeMs: runtime,
			});
			if (validationExit.shouldAttemptRollback) {
				if (updateValidation.applyRollback()) {
					restartAttempts = 0;
					setImmediate(start);
					return;
				}
			}
		}

		const decision = evaluateWorkerExit({
			exitCode: code,
			restartRequested: restartRequest.requested,
			runtimeMs: runtime,
			safeRuntimeResetWindowMs: SAFE_RUNTIME_RESET_WINDOW,
			restartAttempts,
			maxRestarts: MAX_RESTARTS,
			restartDelayMs: RESTART_DELAY,
		});

		restartAttempts = decision.restartAttempts;

		if (decision.action === "exit") {
			if (decision.reason === "max-restarts") {
				logger.error(
					`Maximum restart attempts (${MAX_RESTARTS}) reached. Exiting.`,
				);
			}
			process.exit(decision.exitCode);
			return;
		}

		if (decision.reason === "restart-flag") {
			logger.info(
				`Restart flag detected (${restartRequest.reason}). Restarting immediately.`,
			);
			setImmediate(start);
			return;
		}

		const reason =
			code !== 0 ? ` unexpectedly with code ${code ?? signal}` : "";
		logger.error(
			`Bot exited${reason}. Restarting in ${decision.delayMs / 1000}s (attempt ${restartAttempts}/${MAX_RESTARTS})...`,
		);
		setTimeout(start, decision.delayMs);
	};

	const start = () => {
		workerStartTime = Date.now();
		updateValidation.onWorkerStarted();
		currentWorker = cluster.fork();

		const child = currentWorker.process;
		if (child?.stdout) {
			child.stdout.pipe(process.stdout);
		}
		if (child?.stderr) {
			child.stderr.pipe(process.stderr);
		}
		if (child?.stdin && process.stdin?.readable) {
			try {
				process.stdin.pipe(child.stdin);
			} catch (err) {
				logger.warn({ err }, "Failed to forward stdin to worker");
			}
		}

		currentWorker.once("exit", (code, signal) => {
			if (child?.stdin) {
				try {
					process.stdin.unpipe(child.stdin);
				} catch (err) {
					void err;
				}
			}
			currentWorker = null;
			handleExit(code, signal);
		});

		currentWorker.once("error", (err) => {
			logger.error({ err }, "Worker process error");
		});
	};

	["SIGINT", "SIGTERM"].forEach((sig) => {
		process.on(sig, () => {
			shuttingDown = true;
			updateValidation.clearValidationState();
			if (currentWorker?.process && !currentWorker.process.killed) {
				currentWorker.process.kill(sig);
			}
		});
	});

	start();
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
