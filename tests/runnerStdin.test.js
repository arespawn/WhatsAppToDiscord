import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

test("Watchdog runner keeps stdin available for first-run prompts", async () => {
	const runnerPath = path.join(ROOT, "src", "runner.js");
	const content = await fs.readFile(runnerPath, "utf8");

	assert.ok(
		/stdio:\s*\[\s*'inherit'\s*,\s*'pipe'\s*,\s*'pipe'\s*,\s*'ipc'\s*]/.test(
			content,
		),
		"Expected worker spawn to inherit stdin and expose graceful-shutdown IPC",
	);

	assert.ok(
		!/stdio:\s*\[\s*'ignore'\s*,\s*'pipe'\s*,\s*'pipe'\s*]/.test(content),
		"Worker stdin must not be ignored (breaks first-run prompts)",
	);
});
