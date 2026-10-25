import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import state from "../src/state.js";
import utils from "../src/utils.js";

test("download pruning bounds filesystem work and preserves age, size and ignore rules", async (t) => {
	const originalSettings = state.settings;
	state.settings = {
		...originalSettings,
		DownloadDir: path.resolve("synthetic-downloads"),
		DownloadDirLimitGB: 2 / 1024 ** 3,
		DownloadDirMaxAgeDays: 1,
		DownloadDirMinFreeGB: 0,
	};
	t.after(() => {
		state.settings = originalSettings;
	});
	const names = Array.from({ length: 1000 }, (_, i) => `file-${i}`);
	const deleted = [];
	let active = 0;
	let peak = 0;
	t.mock.method(fs.promises, "readdir", async () => [
		...names,
		"directory",
		"missing",
	]);
	t.mock.method(fs.promises, "stat", async (filePath) => {
		active += 1;
		peak = Math.max(peak, active);
		await new Promise((resolve) => setImmediate(resolve));
		active -= 1;
		const name = path.basename(filePath);
		if (name === "missing") throw new Error("removed during scan");
		const index = names.indexOf(name);
		return {
			isFile: () => name !== "directory",
			mtimeMs: Date.now() - (index < 10 ? 2 * 86400000 : 1000 - index),
			size: 1,
		};
	});
	t.mock.method(fs.promises, "unlink", async (filePath) => {
		deleted.push(path.basename(filePath));
	});
	await utils.discord.pruneDownloadsDir(
		path.join(state.settings.DownloadDir, "file-0"),
	);
	assert.ok(peak <= 32, `peak concurrent stats: ${peak}`);
	assert.equal(active, 0);
	assert.equal(deleted.length, 998);
	assert.equal(deleted.includes("file-0"), false);
	assert.equal(deleted.includes("file-999"), false);
	assert.equal(deleted.includes("directory"), false);
	assert.equal(deleted.includes("missing"), false);
});
