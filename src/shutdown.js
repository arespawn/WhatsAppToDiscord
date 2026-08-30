export const WORKER_SHUTDOWN_TIMEOUT_MS = 10_000;
export const INITIAL_SAVE_TIMEOUT_MS = 1_000;
export const EXIT_REPORT_TIMEOUT_MS = 3_000;
export const RUNTIME_CLEANUP_TIMEOUT_MS = 2_000;
export const DISCORD_CLEANUP_TIMEOUT_MS = 1_000;
export const PERSISTENCE_SHUTDOWN_TIMEOUT_MS = 1_000;
export const SUPERVISOR_SHUTDOWN_TIMEOUT_MS = 12_000;
export const SUPERVISOR_FORCE_EXIT_TIMEOUT_MS = 2_000;
export const DUPLICATE_SIGNAL_WINDOW_MS = 500;
export const INTERNAL_SHUTDOWN_MESSAGE_TYPE = "wa2dc:shutdown";

const SHUTDOWN_SIGNALS = new Set(["SIGINT", "SIGTERM"]);

export const createInternalShutdownMessage = (signal) => ({
	type: INTERNAL_SHUTDOWN_MESSAGE_TYPE,
	signal,
});

export const getInternalShutdownSignal = (message) =>
	message &&
	typeof message === "object" &&
	!Array.isArray(message) &&
	message.type === INTERNAL_SHUTDOWN_MESSAGE_TYPE &&
	SHUTDOWN_SIGNALS.has(message.signal)
		? message.signal
		: null;

export function sendInternalShutdownRequest(
	worker,
	signal,
	onError = () => {},
) {
	if (!SHUTDOWN_SIGNALS.has(signal) || typeof worker?.send !== "function") {
		return false;
	}
	if (worker.connected === false || worker.isConnected?.() === false) {
		return false;
	}

	worker.send(createInternalShutdownMessage(signal), (error) => {
		if (error) onError(error);
	});
	return true;
}

export function createPersistenceShutdownGate({ save, close }) {
	let hydrated = false;
	return {
		markHydrated() {
			hydrated = true;
		},
		save() {
			return hydrated ? save() : undefined;
		},
		close() {
			return hydrated ? close() : undefined;
		},
		isHydrated: () => hydrated,
	};
}

export async function quiesceRuntimeIngress({
	stopDownloadServer = () => {},
	cleanupDiscordUploadStaging = () => {},
	endWhatsApp = () => {},
	closeWhatsAppSocket = () => {},
	onError = () => {},
}) {
	const pending = [];
	const start = (stage, operation) => {
		try {
			pending.push(
				Promise.resolve(operation()).catch((error) => onError(stage, error)),
			);
		} catch (error) {
			onError(stage, error);
		}
	};

	start("download-server", stopDownloadServer);
	start("discord-upload-staging", cleanupDiscordUploadStaging);
	start("whatsapp-end", endWhatsApp);
	start("whatsapp-socket", closeWhatsAppSocket);
	await Promise.allSettled(pending);
}

const settleWithin = (
	operation,
	timeoutMs,
	{ setTimer = setTimeout, clearTimer = clearTimeout } = {},
) =>
	new Promise((resolve) => {
		let settled = false;
		const finish = (result) => {
			if (settled) return;
			settled = true;
			clearTimer(timer);
			resolve(result);
		};
		const timer = setTimer(
			() => finish({ status: "timeout" }),
			Math.max(0, timeoutMs),
		);

		Promise.resolve()
			.then(operation)
			.then(
				(value) => finish({ status: "fulfilled", value }),
				(reason) => finish({ status: "rejected", reason }),
			);
	});

export function createWorkerShutdownController({
	isShutdownEvent,
	getExitCode,
	onStart = () => {},
	quiesce = async () => {},
	save = async () => {},
	report = async () => {},
	destroyDiscord = async () => {},
	finalSave = save,
	closePersistence = async () => {},
	onStageError = () => {},
	onStageTimeout = () => {},
	exit = (code) => process.exit(code),
	shutdownTimeoutMs = WORKER_SHUTDOWN_TIMEOUT_MS,
	initialSaveTimeoutMs = INITIAL_SAVE_TIMEOUT_MS,
	reportTimeoutMs = EXIT_REPORT_TIMEOUT_MS,
	cleanupTimeoutMs = RUNTIME_CLEANUP_TIMEOUT_MS,
	discordTimeoutMs = DISCORD_CLEANUP_TIMEOUT_MS,
	persistenceTimeoutMs = PERSISTENCE_SHUTDOWN_TIMEOUT_MS,
	duplicateSignalWindowMs = DUPLICATE_SIGNAL_WINDOW_MS,
	now = Date.now,
	setTimer = setTimeout,
	clearTimer = clearTimeout,
}) {
	let shuttingDown = false;
	let exitRequested = false;
	let hardExitTimer = null;
	let firstSignal = null;
	let firstSignalSource = null;
	let firstSignalAt = 0;
	let duplicateSignalCoalesced = false;

	const requestExit = (code) => {
		if (exitRequested) return;
		exitRequested = true;
		if (hardExitTimer) {
			clearTimer(hardExitTimer);
			hardExitTimer = null;
		}
		exit(code);
	};

	const runBoundedStage = async (stage, operation, timeoutMs) => {
		const result = await settleWithin(operation, timeoutMs, {
			setTimer,
			clearTimer,
		});
		if (result.status === "rejected") {
			onStageError(stage, result.reason);
		} else if (result.status === "timeout") {
			onStageTimeout(stage);
		}
	};

	const handle = async (eventName, reason, { source = "os" } = {}) => {
		const exitCode = getExitCode(eventName);
		if (shuttingDown) {
			if (isShutdownEvent(eventName)) {
				const isForwardedDuplicate =
					eventName === firstSignal &&
					source !== firstSignalSource &&
					!duplicateSignalCoalesced &&
					now() - firstSignalAt < duplicateSignalWindowMs;
				if (isForwardedDuplicate) {
					duplicateSignalCoalesced = true;
				} else {
					requestExit(exitCode);
				}
			}
			return;
		}

		shuttingDown = true;
		if (isShutdownEvent(eventName)) {
			firstSignal = eventName;
			firstSignalSource = source;
			firstSignalAt = now();
		}
		hardExitTimer = setTimer(
			() => requestExit(exitCode),
			Math.max(0, shutdownTimeoutMs),
		);

		try {
			onStart({ eventName, reason, exitCode });
			await runBoundedStage("quiesce", quiesce, cleanupTimeoutMs);
			await runBoundedStage(
				"save",
				() => save({ eventName, reason, exitCode }),
				initialSaveTimeoutMs,
			);
			await runBoundedStage(
				"report",
				() => report({ eventName, reason, exitCode }),
				reportTimeoutMs,
			);
		} finally {
			await runBoundedStage(
				"destroy-discord",
				destroyDiscord,
				discordTimeoutMs,
			);
			await runBoundedStage("final-save", finalSave, persistenceTimeoutMs);
			await runBoundedStage(
				"close-persistence",
				closePersistence,
				persistenceTimeoutMs,
			);
			requestExit(exitCode);
		}
	};

	return {
		handle,
		isShuttingDown: () => shuttingDown,
	};
}

export function createSupervisorShutdownController({
	getWorker,
	requestWorkerShutdown = () => false,
	signalWorker = null,
	forceKillWorker,
	clearValidation = () => {},
	onError = () => {},
	exit = (code) => process.exit(code),
	graceTimeoutMs = SUPERVISOR_SHUTDOWN_TIMEOUT_MS,
	forceExitTimeoutMs = SUPERVISOR_FORCE_EXIT_TIMEOUT_MS,
	setTimer = setTimeout,
	clearTimer = clearTimeout,
}) {
	let shuttingDown = false;
	let exitRequested = false;
	let graceTimer = null;
	let forceExitTimer = null;
	let forceKillRequested = false;

	const requestExit = (code) => {
		if (exitRequested) return;
		exitRequested = true;
		if (graceTimer) {
			clearTimer(graceTimer);
			graceTimer = null;
		}
		if (forceExitTimer) {
			clearTimer(forceExitTimer);
			forceExitTimer = null;
		}
		exit(code);
	};

	const forceKill = () => {
		const worker = getWorker();
		if (!worker) return false;
		try {
			const killed = forceKillWorker(worker);
			if (killed === false) {
				onError("force-kill", new Error("Worker rejected SIGKILL"));
			}
		} catch (error) {
			onError("force-kill", error);
		}
		return true;
	};

	const beginForceKill = () => {
		if (forceKillRequested) {
			requestExit(0);
			return;
		}
		forceKillRequested = true;
		if (graceTimer) {
			clearTimer(graceTimer);
			graceTimer = null;
		}
		if (!forceKill()) {
			requestExit(0);
			return;
		}
		forceExitTimer = setTimer(
			() => {
				forceExitTimer = null;
				requestExit(0);
			},
			Math.max(0, forceExitTimeoutMs),
		);
	};

	const fallbackToSignal = (worker, signal, error) => {
		if (error) onError("shutdown-ipc", error);
		if (!signalWorker || exitRequested || forceKillRequested) return;
		try {
			signalWorker(worker, signal);
		} catch (signalError) {
			onError("signal", signalError);
		}
	};

	const onSignal = (signal) => {
		if (shuttingDown) {
			beginForceKill();
			return;
		}

		shuttingDown = true;
		clearValidation();
		const worker = getWorker();
		if (!worker) {
			requestExit(0);
			return;
		}

		try {
			const requested = requestWorkerShutdown(worker, signal, (error) =>
				fallbackToSignal(worker, signal, error),
			);
			if (!requested) fallbackToSignal(worker, signal);
		} catch (error) {
			fallbackToSignal(worker, signal, error);
		}

		graceTimer = setTimer(
			() => {
				graceTimer = null;
				beginForceKill();
			},
			Math.max(0, graceTimeoutMs),
		);
	};

	const onWorkerExit = (code) => {
		if (!shuttingDown) return false;
		requestExit(code ?? 0);
		return true;
	};

	return {
		onSignal,
		onWorkerExit,
		isShuttingDown: () => shuttingDown,
	};
}
