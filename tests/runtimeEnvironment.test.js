import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
	loadRuntimeEnvironment,
	resolveRuntimeEnvPath,
} from "../src/runtimeEnvironment.js";

const restoreEnv = (key, original) => {
	if (original === undefined) {
		delete process.env[key];
		return;
	}
	process.env[key] = original;
};

test("source startup resolves .env from the working directory", () => {
	const cwd = path.join(os.tmpdir(), "wa2dc-source-root");
	assert.equal(
		resolveRuntimeEnvPath({
			cwd,
			execPath: path.join(os.tmpdir(), "bin", "node"),
			isPackaged: false,
		}),
		path.join(cwd, ".env"),
	);
});

test("packaged startup resolves .env beside the executable", () => {
	const executable = path.join(os.tmpdir(), "wa2dc-bin", "WA2DC");
	assert.equal(
		resolveRuntimeEnvPath({
			cwd: path.join(os.tmpdir(), "unrelated-working-directory"),
			execPath: executable,
			isPackaged: true,
		}),
		path.join(path.dirname(executable), ".env"),
	);
});

test("runtime .env loads values without overriding the host environment", async () => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "wa2dc-runtime-env-"),
	);
	const existingKey = "WA2DC_TEST_ENV_EXISTING";
	const addedKey = "WA2DC_TEST_ENV_ADDED";
	const originalExisting = process.env[existingKey];
	const originalAdded = process.env[addedKey];
	try {
		await fs.writeFile(
			path.join(tempDir, ".env"),
			`${existingKey}=from-file\n${addedKey}=from-file\n`,
			{ mode: 0o600 },
		);
		process.env[existingKey] = "from-host";
		delete process.env[addedKey];

		const result = loadRuntimeEnvironment({
			cwd: tempDir,
			isPackaged: false,
		});

		assert.deepEqual(result, {
			loaded: true,
			path: path.join(tempDir, ".env"),
		});
		assert.equal(process.env[existingKey], "from-host");
		assert.equal(process.env[addedKey], "from-file");
	} finally {
		restoreEnv(existingKey, originalExisting);
		restoreEnv(addedKey, originalAdded);
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("missing runtime .env is ignored", () => {
	const missing = new Error("missing");
	missing.code = "ENOENT";
	assert.deepEqual(
		loadRuntimeEnvironment({
			cwd: path.join(os.tmpdir(), "wa2dc-missing-env"),
			isPackaged: false,
			loadEnvFile: () => {
				throw missing;
			},
		}),
		{
			loaded: false,
			path: path.join(os.tmpdir(), "wa2dc-missing-env", ".env"),
		},
	);
});

test("runtime .env read failures stop startup without exposing contents", () => {
	const denied = new Error("permission denied");
	denied.code = "EACCES";
	assert.throws(
		() =>
			loadRuntimeEnvironment({
				cwd: path.join(os.tmpdir(), "wa2dc-denied-env"),
				isPackaged: false,
				loadEnvFile: () => {
					throw denied;
				},
			}),
		(err) => {
			assert.match(err.message, /Failed to load WA2DC environment file/);
			assert.equal(err.cause, denied);
			assert.doesNotMatch(err.message, /permission denied/);
			return true;
		},
	);
});
