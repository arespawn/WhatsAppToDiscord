import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
	listPendingCrashReports,
	readTextFileTail,
	replayQueuedCrashReport,
	writeCrashReportAtomic,
	writePendingCrashReportAtomic,
} from "../src/crashReportQueue.js";

test("shutdown log reads are bounded to the tail of the file", async (t) => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "wa2dc-log-tail-"));
	t.after(() => fs.rm(tempDir, { recursive: true, force: true }));
	const logFile = path.join(tempDir, "logs.txt");
	await fs.writeFile(logFile, "older-data\nnewest-data", "utf8");

	assert.equal(
		await readTextFileTail(logFile, { maxBytes: 11 }),
		"newest-data",
	);
});

test("shutdown log tail uses only bytes actually read", async () => {
	let closed = false;
	const fsPromises = {
		async open() {
			return {
				async stat() {
					return { size: 10 };
				},
				async read(buffer) {
					buffer.write("abc", 0, "utf8");
					return { bytesRead: 3 };
				},
				async close() {
					closed = true;
				},
			};
		},
	};

	assert.equal(
		await readTextFileTail("unused", { maxBytes: 10, fsPromises }),
		"abc",
	);
	assert.equal(closed, true);
});

test("atomic crash reports are replaced with private permissions", async (t) => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "wa2dc-crash-write-"),
	);
	t.after(() => fs.rm(tempDir, { recursive: true, force: true }));
	const crashFile = path.join(tempDir, "crash-report.txt");
	await writeCrashReportAtomic(crashFile, "old crash");
	await writeCrashReportAtomic(crashFile, "new crash");
	assert.equal(await fs.readFile(crashFile, "utf8"), "new crash");
	if (process.platform !== "win32") {
		assert.equal((await fs.stat(crashFile)).mode & 0o777, 0o600);
	}
});

test("consecutive fatal queue writes preserve earlier and canonical reports", async (t) => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "wa2dc-crash-many-"));
	t.after(() => fs.rm(tempDir, { recursive: true, force: true }));
	const crashFile = path.join(tempDir, "crash-report.txt");
	await writeCrashReportAtomic(crashFile, "legacy crash");
	await writePendingCrashReportAtomic(crashFile, "first new crash");
	await writePendingCrashReportAtomic(crashFile, "second new crash");

	assert.equal(await fs.readFile(crashFile, "utf8"), "legacy crash");
	assert.equal((await listPendingCrashReports(crashFile)).length, 2);

	const delivered = [];
	assert.deepEqual(
		await replayQueuedCrashReport({
			filePath: crashFile,
			send: async (content) => delivered.push(content),
		}),
		{ status: "sent-and-removed", sent: 3 },
	);
	assert.deepEqual(
		new Set(delivered),
		new Set(["legacy crash", "first new crash", "second new crash"]),
	);
	await assert.rejects(fs.stat(crashFile), { code: "ENOENT" });
	assert.deepEqual(await listPendingCrashReports(crashFile), []);
});

test("failed new fatal write leaves every existing report untouched", async (t) => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "wa2dc-crash-write-failure-"),
	);
	t.after(() => fs.rm(tempDir, { recursive: true, force: true }));
	const crashFile = path.join(tempDir, "crash-report.txt");
	await writeCrashReportAtomic(crashFile, "legacy crash");
	const existingPending = await writePendingCrashReportAtomic(
		crashFile,
		"earlier fatal",
	);

	await assert.rejects(
		writePendingCrashReportAtomic(crashFile, "new fatal", {
			fsPromises: {
				async open() {
					throw new Error("disk unavailable");
				},
				async unlink() {},
			},
		}),
		/disk unavailable/,
	);
	assert.equal(await fs.readFile(crashFile, "utf8"), "legacy crash");
	assert.equal(await fs.readFile(existingPending, "utf8"), "earlier fatal");
	assert.deepEqual(await listPendingCrashReports(crashFile), [existingPending]);
});

test("claimed replay cannot delete an identical replacement report", async (t) => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "wa2dc-crash-replay-"),
	);
	t.after(() => fs.rm(tempDir, { recursive: true, force: true }));
	const crashFile = path.join(tempDir, "crash-report.txt");
	await fs.writeFile(crashFile, "queued crash", "utf8");
	let releaseSend;
	let sendStarted;
	const started = new Promise((resolve) => {
		sendStarted = resolve;
	});
	const sendGate = new Promise((resolve) => {
		releaseSend = resolve;
	});
	const replay = replayQueuedCrashReport({
		filePath: crashFile,
		async send(content) {
			assert.equal(content, "queued crash");
			sendStarted();
			await sendGate;
		},
	});

	await started;
	await writeCrashReportAtomic(crashFile, "queued crash");
	releaseSend();

	assert.deepEqual(await replay, { status: "sent-and-removed", sent: 1 });
	assert.equal(await fs.readFile(crashFile, "utf8"), "queued crash");
	assert.deepEqual(await listPendingCrashReports(crashFile), []);
});

test("failed delivery retains its claimed report for startup recovery", async (t) => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "wa2dc-crash-recovery-"),
	);
	t.after(() => fs.rm(tempDir, { recursive: true, force: true }));
	const crashFile = path.join(tempDir, "crash-report.txt");
	await writeCrashReportAtomic(crashFile, "recover me");

	await assert.rejects(
		replayQueuedCrashReport({
			filePath: crashFile,
			send: async () => {
				throw new Error("offline");
			},
		}),
		/offline/,
	);
	await assert.rejects(fs.stat(crashFile), { code: "ENOENT" });
	assert.equal((await listPendingCrashReports(crashFile)).length, 1);

	const delivered = [];
	assert.deepEqual(
		await replayQueuedCrashReport({
			filePath: crashFile,
			send: async (content) => delivered.push(content),
		}),
		{ status: "sent-and-removed", sent: 1 },
	);
	assert.deepEqual(delivered, ["recover me"]);
	assert.deepEqual(await listPendingCrashReports(crashFile), []);
});
