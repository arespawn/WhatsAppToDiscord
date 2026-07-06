import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import runCommand from "./helpers/runCommand.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

test("Smoke boots successfully (WA2DC_SMOKE_TEST)", async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "wa2dc-smoke-"));
	try {
		const result = await runCommand(
			process.execPath,
			[path.join(ROOT, "src", "index.js")],
			{
				cwd: tempDir,
				env: {
					...process.env,
					WA2DC_SMOKE_TEST: "1",
				},
				timeoutMs: 120_000,
			},
		);

		assert.equal(result.code, 0, result.stderr);
		const combined = `${result.stdout}\n${result.stderr}`;
		assert.ok(
			combined.includes("Smoke test completed successfully."),
			combined,
		);
		await fs.stat(path.join(tempDir, "storage", "wa2dc.sqlite"));
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});
