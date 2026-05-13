import assert from "node:assert/strict";
import test from "node:test";

import {
	buildProcessExitReportContent,
	getProcessExitCode,
	getProcessReportFileName,
} from "../src/processExitReporting.js";
import state from "../src/state.js";
import utils from "../src/utils.js";

test("Crash reporting helpers tolerate missing Discord client", async () => {
	const originalClient = state.dcClient;
	const originalSettings = { ...state.settings };

	try {
		state.dcClient = null;
		state.settings.GuildID = "";
		state.settings.ControlChannelID = "";

		const channel = await utils.discord.getControlChannel();
		assert.equal(channel, null);
	} finally {
		state.dcClient = originalClient;
		Object.keys(state.settings).forEach((key) => {
			delete state.settings[key];
		});
		Object.assign(state.settings, originalSettings);
	}
});

test("SIGINT reports an intentional shutdown instead of a crash", () => {
	const content = buildProcessExitReportContent({
		eventName: "SIGINT",
		reason: "SIGINT",
		logs: "last log line",
	});

	assert.match(content, /^Bot shutting down:/);
	assert.match(content, /SIGINT/);
	assert.match(content, /Recent logs:/);
	assert.match(content, /last log line/);
	assert.doesNotMatch(content, /Bot crashed:/);
	assert.equal(getProcessExitCode("SIGINT"), 0);
	assert.equal(getProcessReportFileName("SIGINT"), "shutdown.txt");
});

test("uncaught exceptions keep crash report wording and nonzero exit", () => {
	const err = new Error("boom");
	const content = buildProcessExitReportContent({
		eventName: "uncaughtException",
		reason: err,
	});

	assert.match(content, /^Bot crashed:/);
	assert.match(content, /Error: boom/);
	assert.equal(getProcessExitCode("uncaughtException"), 1);
	assert.equal(getProcessReportFileName("uncaughtException"), "crash.txt");
});
