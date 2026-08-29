import assert from "node:assert/strict";
import test from "node:test";

import {
	createPersistenceShutdownGate,
	createSupervisorShutdownController,
	createWorkerShutdownController,
	getInternalShutdownSignal,
	quiesceRuntimeIngress,
	sendInternalShutdownRequest,
} from "../src/shutdown.js";

const isShutdownEvent = (eventName) =>
	eventName === "SIGINT" || eventName === "SIGTERM";
const getExitCode = (eventName) => (isShutdownEvent(eventName) ? 0 : 1);

test("runtime quiesce starts every ingress primitive when one fails or hangs", async () => {
	const calls = [];
	let releaseWhatsApp;
	const whatsappEnd = new Promise((resolve) => {
		releaseWhatsApp = resolve;
	});
	const cleanup = quiesceRuntimeIngress({
		stopDownloadServer() {
			calls.push("download-server");
			throw new Error("close failed");
		},
		endWhatsApp() {
			calls.push("whatsapp-end");
			return whatsappEnd;
		},
		closeWhatsAppSocket: () => calls.push("whatsapp-socket"),
		onError: (stage) => calls.push(`${stage}-error`),
	});

	assert.deepEqual(calls, [
		"download-server",
		"download-server-error",
		"whatsapp-end",
		"whatsapp-socket",
	]);
	releaseWhatsApp();
	await cleanup;
});

test("early shutdown does not save or close partially hydrated persistence", async () => {
	const calls = [];
	const persistence = createPersistenceShutdownGate({
		save: () => calls.push("save"),
		close: () => calls.push("close"),
	});

	await persistence.save();
	await persistence.close();
	assert.deepEqual(calls, []);

	persistence.markHydrated();
	await persistence.save();
	await persistence.close();
	assert.deepEqual(calls, ["save", "close"]);
});

test("worker shutdown quiesces, saves, reports, destroys Discord, saves, then closes", async () => {
	const calls = [];
	const controller = createWorkerShutdownController({
		isShutdownEvent,
		getExitCode,
		onStart() {
			calls.push("start");
		},
		async quiesce() {
			calls.push("quiesce");
		},
		async save() {
			calls.push("initial-save");
		},
		report() {
			calls.push("report");
			return new Promise(() => {});
		},
		async destroyDiscord() {
			calls.push("destroy-discord");
		},
		async finalSave() {
			calls.push("final-save");
		},
		async closePersistence() {
			calls.push("close-persistence");
		},
		onStageTimeout(stage) {
			calls.push(`${stage}-timeout`);
		},
		exit(code) {
			calls.push(`exit-${code}`);
		},
		reportTimeoutMs: 5,
		cleanupTimeoutMs: 50,
		shutdownTimeoutMs: 500,
	});

	await controller.handle("SIGINT", "SIGINT");

	assert.deepEqual(calls, [
		"start",
		"quiesce",
		"initial-save",
		"report",
		"report-timeout",
		"destroy-discord",
		"final-save",
		"close-persistence",
		"exit-0",
	]);
});

test("hung ingress and initial save cannot block fatal report or final persistence", async () => {
	const calls = [];
	const never = new Promise(() => {});
	const controller = createWorkerShutdownController({
		isShutdownEvent,
		getExitCode,
		quiesce() {
			calls.push("quiesce");
			return never;
		},
		save() {
			calls.push("initial-save");
			return never;
		},
		report() {
			calls.push("report");
		},
		destroyDiscord() {
			calls.push("destroy-discord");
		},
		finalSave() {
			calls.push("final-save");
		},
		closePersistence() {
			calls.push("close-persistence");
		},
		onStageTimeout(stage) {
			calls.push(`${stage}-timeout`);
		},
		exit: (code) => calls.push(`exit-${code}`),
		cleanupTimeoutMs: 5,
		initialSaveTimeoutMs: 5,
		reportTimeoutMs: 50,
		discordTimeoutMs: 50,
		persistenceTimeoutMs: 50,
		shutdownTimeoutMs: 500,
	});

	await controller.handle("uncaughtException", new Error("fatal"));
	assert.deepEqual(calls, [
		"quiesce",
		"quiesce-timeout",
		"initial-save",
		"save-timeout",
		"report",
		"destroy-discord",
		"final-save",
		"close-persistence",
		"exit-1",
	]);
});

test("a second shutdown signal requests immediate exit exactly once", async () => {
	const exits = [];
	let releaseReport;
	const report = new Promise((resolve) => {
		releaseReport = resolve;
	});
	const controller = createWorkerShutdownController({
		isShutdownEvent,
		getExitCode,
		report: () => report,
		exit: (code) => exits.push(code),
		reportTimeoutMs: 500,
		cleanupTimeoutMs: 50,
		shutdownTimeoutMs: 1_000,
	});

	const firstSignal = controller.handle("SIGINT", "SIGINT");
	await new Promise((resolve) => setImmediate(resolve));
	await controller.handle("SIGTERM", "SIGTERM", { source: "os" });

	assert.deepEqual(exits, [0]);
	releaseReport();
	await firstSignal;
	assert.deepEqual(exits, [0]);
});

test("only an OS/IPC duplicate is coalesced; a second direct signal exits", async () => {
	const exits = [];
	let currentTime = 1_000;
	let releaseReport;
	const report = new Promise((resolve) => {
		releaseReport = resolve;
	});
	const controller = createWorkerShutdownController({
		isShutdownEvent,
		getExitCode,
		report: () => report,
		exit: (code) => exits.push(code),
		now: () => currentTime,
		duplicateSignalWindowMs: 500,
		reportTimeoutMs: 1_000,
		shutdownTimeoutMs: 2_000,
	});

	const firstSignal = controller.handle("SIGINT", "SIGINT", { source: "os" });
	await new Promise((resolve) => setImmediate(resolve));
	currentTime += 10;
	await controller.handle("SIGINT", "SIGINT", { source: "supervisor-ipc" });
	assert.deepEqual(exits, []);

	currentTime += 10;
	await controller.handle("SIGINT", "SIGINT", { source: "os" });
	assert.deepEqual(exits, [0]);
	releaseReport();
	await firstSignal;
});

test("validated internal shutdown messages support only graceful signals", () => {
	assert.equal(
		getInternalShutdownSignal({ type: "wa2dc:shutdown", signal: "SIGINT" }),
		"SIGINT",
	);
	assert.equal(
		getInternalShutdownSignal({ type: "wa2dc:shutdown", signal: "SIGKILL" }),
		null,
	);
	assert.equal(getInternalShutdownSignal("SIGTERM"), null);
});

test("packaged spawn supervisor requests graceful shutdown over IPC", () => {
	const messages = [];
	const signals = [];
	const exits = [];
	const timers = [];
	const worker = {
		connected: true,
		send(message, callback) {
			messages.push(message);
			callback(null);
		},
		kill(signal) {
			signals.push(signal);
			return true;
		},
	};
	const controller = createSupervisorShutdownController({
		getWorker: () => worker,
		requestWorkerShutdown: (target, signal, onError) =>
			sendInternalShutdownRequest(target, signal, onError),
		signalWorker: (target, signal) => target.kill(signal),
		forceKillWorker: (target) => target.kill("SIGKILL"),
		exit: (code) => exits.push(code),
		setTimer(callback) {
			timers.push(callback);
			return timers.length;
		},
		clearTimer() {},
	});

	controller.onSignal("SIGTERM");
	assert.deepEqual(messages, [{ type: "wa2dc:shutdown", signal: "SIGTERM" }]);
	assert.deepEqual(signals, []);
	assert.deepEqual(exits, []);

	timers[0]();
	assert.deepEqual(signals, ["SIGKILL"]);
	assert.deepEqual(exits, []);
	controller.onWorkerExit(null);
	assert.deepEqual(exits, [0]);
});

test("source cluster supervisor sends IPC and observes exit after forced kill", () => {
	const messages = [];
	const signals = [];
	const exits = [];
	const worker = {
		isConnected: () => true,
		send(message, callback) {
			messages.push(message);
			callback(null);
		},
		process: {
			kill(signal) {
				signals.push(signal);
				return true;
			},
		},
	};
	const controller = createSupervisorShutdownController({
		getWorker: () => worker,
		requestWorkerShutdown: (target, signal, onError) =>
			sendInternalShutdownRequest(target, signal, onError),
		signalWorker: (target, signal) => target.process.kill(signal),
		forceKillWorker: (target) => target.process.kill("SIGKILL"),
		exit: (code) => exits.push(code),
		setTimer: () => 1,
		clearTimer() {},
	});

	controller.onSignal("SIGINT");
	controller.onSignal("SIGTERM");

	assert.deepEqual(messages, [{ type: "wa2dc:shutdown", signal: "SIGINT" }]);
	assert.deepEqual(signals, ["SIGKILL"]);
	assert.deepEqual(exits, []);
	controller.onWorkerExit(null);
	assert.deepEqual(exits, [0]);
});

test("Windows-style supervisor never falls back to a graceful OS signal", () => {
	const signals = [];
	const timers = [];
	const worker = {
		kill(signal) {
			signals.push(signal);
			return true;
		},
	};
	const controller = createSupervisorShutdownController({
		getWorker: () => worker,
		requestWorkerShutdown: () => false,
		signalWorker: null,
		forceKillWorker: (target) => target.kill("SIGKILL"),
		exit() {},
		setTimer(callback) {
			timers.push(callback);
			return timers.length;
		},
		clearTimer() {},
	});

	controller.onSignal("SIGTERM");
	assert.deepEqual(signals, []);
	timers[0]();
	assert.deepEqual(signals, ["SIGKILL"]);
});

test("supervisor exits from the real worker exit event without escalation", () => {
	const exits = [];
	const clearedTimers = [];
	let worker = { kill() {} };
	const controller = createSupervisorShutdownController({
		getWorker: () => worker,
		requestWorkerShutdown: () => true,
		signalWorker: (target, signal) => target.kill(signal),
		forceKillWorker() {
			assert.fail("worker should not be force-killed after it exits");
		},
		exit: (code) => exits.push(code),
		setTimer: () => 7,
		clearTimer: (timer) => clearedTimers.push(timer),
	});

	controller.onSignal("SIGTERM");
	worker = null;
	assert.equal(controller.onWorkerExit(null), true);

	assert.deepEqual(clearedTimers, [7]);
	assert.deepEqual(exits, [0]);
});

test("failed SIGKILL waits for the post-kill deadline before supervisor exit", () => {
	const errors = [];
	const exits = [];
	const timers = [];
	const controller = createSupervisorShutdownController({
		getWorker: () => ({ kill: () => false }),
		requestWorkerShutdown: () => true,
		forceKillWorker: (worker) => worker.kill("SIGKILL"),
		onError: (stage) => errors.push(stage),
		exit: (code) => exits.push(code),
		setTimer(callback) {
			timers.push(callback);
			return timers.length;
		},
		clearTimer() {},
	});

	controller.onSignal("SIGTERM");
	timers[0]();
	assert.deepEqual(errors, ["force-kill"]);
	assert.deepEqual(exits, []);
	timers[1]();
	assert.deepEqual(exits, [0]);
});
