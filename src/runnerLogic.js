import fs from "node:fs";
import path from "node:path";

const DEFAULT_RESTART_DELAY_MS = 10_000;
const DEFAULT_MAX_RESTARTS = 5;
export const UPDATE_VALIDATION_WINDOW_MS = 120_000;
const UPDATE_ROLLBACK_CRASH_THRESHOLD = 2;

const RESTART_REASONS = new Set(["manual", "update", "rollback"]);

export const resolveRestartDelayMs = (
	rawValue,
	defaultDelayMs = DEFAULT_RESTART_DELAY_MS,
) => {
	const parsed = Number(rawValue);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultDelayMs;
};

export const resolveMaxRestarts = (
	rawValue,
	defaultMaxRestarts = DEFAULT_MAX_RESTARTS,
) => {
	const parsed = Number(rawValue);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultMaxRestarts;
};

export const resolveSafeRuntimeResetWindowMs = (
	restartDelayMs,
	defaultDelayMs = DEFAULT_RESTART_DELAY_MS,
) => Math.max(restartDelayMs, defaultDelayMs);

export const resolveRestartFlagPath = (rawValue, cwd = process.cwd()) =>
	rawValue ? path.resolve(rawValue) : path.resolve(cwd, "restart.flag");

export const computeBackoffDelayMs = (baseDelayMs, attempt) =>
	baseDelayMs * 2 ** (attempt - 1);

export const parseRestartFlagPayload = (raw) => {
	const fallback = { reason: "manual", targetVersion: null };
	if (typeof raw !== "string") {
		return fallback;
	}

	const trimmed = raw.trim();
	if (!trimmed) {
		return fallback;
	}

	try {
		const parsed = JSON.parse(trimmed);
		if (!parsed || typeof parsed !== "object") {
			return fallback;
		}

		const reason = RESTART_REASONS.has(parsed.reason)
			? parsed.reason
			: "manual";
		const targetVersion =
			typeof parsed.targetVersion === "string" && parsed.targetVersion.trim()
				? parsed.targetVersion.trim()
				: null;
		return { reason, targetVersion };
	} catch {
		return fallback;
	}
};

export const consumeRestartFlagSync = (
	flagPath,
	{ logger, fsModule = fs } = {},
) => {
	const fallback = { requested: false, reason: "manual", targetVersion: null };
	if (!fsModule.existsSync(flagPath)) {
		return fallback;
	}

	let rawPayload = "";
	try {
		rawPayload = fsModule.readFileSync(flagPath, "utf8");
	} catch (err) {
		if (err?.code !== "ENOENT") {
			logger?.warn?.({ err }, "Failed to read restart flag");
		}
	}

	try {
		fsModule.unlinkSync(flagPath);
	} catch (err) {
		if (err?.code !== "ENOENT") {
			logger?.warn?.({ err }, "Failed to remove restart flag");
		}
	}

	const parsed = parseRestartFlagPayload(rawPayload);
	return {
		requested: true,
		reason: parsed.reason,
		targetVersion: parsed.targetVersion,
	};
};

export const clearRestartFlagSync = (
	flagPath,
	{ logger, fsModule = fs } = {},
) => consumeRestartFlagSync(flagPath, { logger, fsModule }).requested;

export const resolveRollbackBackupCandidates = ({
	currentExeName,
	execPath = process.execPath,
	cwd = process.cwd(),
	pathModule = path,
} = {}) => {
	const candidates = [];
	if (typeof currentExeName === "string" && currentExeName) {
		candidates.push(pathModule.resolve(cwd, `${currentExeName}.oldVersion`));
	}
	if (typeof execPath === "string" && execPath) {
		candidates.push(
			pathModule.join(
				pathModule.dirname(execPath),
				`${pathModule.basename(execPath)}.oldVersion`,
			),
		);
	}
	return [...new Set(candidates)];
};

export const findRollbackBackupPathSync = ({
	currentExeName,
	execPath = process.execPath,
	cwd = process.cwd(),
	fsModule = fs,
	pathModule = path,
} = {}) => {
	const candidates = resolveRollbackBackupCandidates({
		currentExeName,
		execPath,
		cwd,
		pathModule,
	});

	for (const candidate of candidates) {
		if (fsModule.existsSync(candidate)) {
			return candidate;
		}
	}
	return null;
};

export const revertExecutableToBackupSync = ({
	currentExeName,
	execPath = process.execPath,
	cwd = process.cwd(),
	fsModule = fs,
	pathModule = path,
} = {}) => {
	const backupPath = findRollbackBackupPathSync({
		currentExeName,
		execPath,
		cwd,
		fsModule,
		pathModule,
	});
	if (!backupPath) {
		return { success: false, reason: "no-backup" };
	}

	const currentPath =
		typeof execPath === "string" && execPath
			? execPath
			: pathModule.resolve(cwd, currentExeName || "");

	try {
		fsModule.rmSync(currentPath, { force: true });
	} catch (err) {
		if (err?.code !== "ENOENT") {
			return { success: false, reason: "remove-failed", err };
		}
	}

	try {
		fsModule.renameSync(backupPath, currentPath);
	} catch (err) {
		return { success: false, reason: "rename-failed", err };
	}

	return {
		success: true,
		reason: null,
		backupPath,
		currentPath,
	};
};

export const revertPackagedArtifactsToBackupSync = ({
	currentExeName,
	execPath = process.execPath,
	cwd = process.cwd(),
	fsModule = fs,
	pathModule = path,
} = {}) => {
	const executableResult = revertExecutableToBackupSync({
		currentExeName,
		execPath,
		cwd,
		fsModule,
		pathModule,
	});
	if (!executableResult.success) {
		return executableResult;
	}

	const runtimePath = pathModule.join(pathModule.dirname(execPath), "runtime");
	const runtimeBackupPath = `${runtimePath}.oldVersion`;
	const hasRuntimeBackup = fsModule.existsSync(runtimeBackupPath);

	try {
		if (hasRuntimeBackup) {
			fsModule.rmSync(runtimePath, { recursive: true, force: true });
			fsModule.renameSync(runtimeBackupPath, runtimePath);
		}
	} catch (err) {
		return {
			success: false,
			reason: "runtime-rollback-failed",
			err,
			backupPath: executableResult.backupPath,
			currentPath: executableResult.currentPath,
			runtimeBackupPath,
			runtimePath,
		};
	}

	return {
		...executableResult,
		runtimeBackupPath: hasRuntimeBackup ? runtimeBackupPath : null,
		runtimePath,
	};
};

export const createUpdateValidationState = ({
	targetVersion = null,
	nowMs = Date.now(),
} = {}) => ({
	active: true,
	crashCount: 0,
	startedAt: nowMs,
	rollbackAttempted: false,
	version:
		typeof targetVersion === "string" && targetVersion.trim()
			? targetVersion.trim()
			: null,
});

export const evaluateUpdateValidationExit = ({
	validationState = null,
	exitCode = 0,
	runtimeMs = 0,
	healthyWindowMs = UPDATE_VALIDATION_WINDOW_MS,
	crashThreshold = UPDATE_ROLLBACK_CRASH_THRESHOLD,
} = {}) => {
	if (!validationState?.active) {
		return {
			validationState,
			shouldAttemptRollback: false,
			reason: "inactive",
		};
	}

	if (runtimeMs >= healthyWindowMs) {
		return {
			validationState: null,
			shouldAttemptRollback: false,
			reason: "healthy-runtime",
		};
	}

	if (exitCode === 0) {
		return {
			validationState,
			shouldAttemptRollback: false,
			reason: "clean-exit",
		};
	}

	const crashCount = Number(validationState.crashCount || 0) + 1;
	const rollbackAttempted = Boolean(validationState.rollbackAttempted);
	const shouldAttemptRollback =
		!rollbackAttempted && crashCount >= crashThreshold;

	return {
		validationState: {
			...validationState,
			crashCount,
			rollbackAttempted: rollbackAttempted || shouldAttemptRollback,
		},
		shouldAttemptRollback,
		reason: shouldAttemptRollback ? "rollback-threshold" : "crash-counted",
	};
};

export const evaluateWorkerExit = ({
	shuttingDown = false,
	exitCode,
	restartRequested = false,
	runtimeMs = 0,
	safeRuntimeResetWindowMs = DEFAULT_RESTART_DELAY_MS,
	restartAttempts = 0,
	maxRestarts = DEFAULT_MAX_RESTARTS,
	restartDelayMs = DEFAULT_RESTART_DELAY_MS,
} = {}) => {
	if (shuttingDown) {
		return {
			action: "exit",
			reason: "shutting-down",
			exitCode: exitCode ?? 0,
			restartAttempts,
			delayMs: null,
		};
	}

	let attempts = restartAttempts;
	if (runtimeMs > safeRuntimeResetWindowMs) {
		attempts = 0;
	}

	if (restartRequested) {
		return {
			action: "restart",
			reason: "restart-flag",
			exitCode: null,
			restartAttempts: 0,
			delayMs: 0,
		};
	}

	if (exitCode === 0) {
		return {
			action: "exit",
			reason: "clean-exit",
			exitCode: 0,
			restartAttempts: attempts,
			delayMs: null,
		};
	}

	attempts += 1;
	if (attempts > maxRestarts) {
		return {
			action: "exit",
			reason: "max-restarts",
			exitCode: exitCode ?? 1,
			restartAttempts: attempts,
			delayMs: null,
		};
	}

	return {
		action: "restart",
		reason: "crash",
		exitCode: null,
		restartAttempts: attempts,
		delayMs: computeBackoffDelayMs(restartDelayMs, attempts),
	};
};
