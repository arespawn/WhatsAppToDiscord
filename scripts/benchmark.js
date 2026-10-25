import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const storePath =
	process.argv.slice(2).find((arg) => !arg.startsWith("--")) ||
	path.join(root, "src/persistence/sqliteStore.js");
const { default: store } = await import(pathToFileURL(path.resolve(storePath)));
const temporaryDirectory = await fs.mkdtemp(
	path.join(os.tmpdir(), "wa2dc-bench-"),
);
const results = {
	node: process.version,
	platform: process.platform,
	arch: process.arch,
	sqlite: {},
	startup: {},
};
const median = (values) =>
	values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
const measure = (name, iterations, work) => {
	for (let i = 0; i < 500; i += 1) work(i);
	const samples = [];
	const cpuSamples = [];
	for (let sample = 0; sample < 5; sample += 1) {
		const started = performance.now();
		const cpuStarted = process.cpuUsage();
		for (let i = 0; i < iterations; i += 1) work(i);
		const cpu = process.cpuUsage(cpuStarted);
		cpuSamples.push((cpu.user + cpu.system) / 1000);
		samples.push(performance.now() - started);
	}
	const ms = median(samples);
	results.sqlite[name] = {
		iterations,
		medianMs: ms,
		samplesMs: samples,
		medianCpuMs: median(cpuSamples),
		samplesCpuMs: cpuSamples,
	};
};

try {
	store.setStorageDir(path.join(temporaryDirectory, "storage"));
	await store.init();
	const expiresAt = Date.now() + 86_400_000;
	const message = JSON.stringify({
		key: { id: "synthetic", remoteJid: "test@g.us" },
		message: { conversation: "benchmark" },
	});
	store.setAppState("probe", message);
	store.setAuthKeys(
		Object.fromEntries(
			Array.from({ length: 10 }, (_, i) => [`key-${i}`, message]),
		),
	);
	store.setMessageStore("probe", message, expiresAt);
	measure("appRead", 10000, () => store.getAppState("probe"));
	measure("messageRead", 10000, () => store.getMessageStore("probe"));
	measure("authRead10", 3000, () =>
		store.getAuthKeys(Array.from({ length: 10 }, (_, i) => `key-${i}`)),
	);
	measure("messageWriteAndPrune", 3000, (i) => {
		store.setMessageStore(`message-${i % 1000}`, message, expiresAt);
		store.pruneMessageStore(10000);
	});
	results.sqlitePeakRssKiB = process.resourceUsage().maxRSS;
	store.close();
	for (const entry of process.argv.includes("--sqlite-only")
		? []
		: ["src/index.js", "out.js"]) {
		const elapsed = [];
		for (let i = 0; i < 5; i += 1) {
			const cwd = path.join(temporaryDirectory, `${path.basename(entry)}-${i}`);
			await fs.mkdir(cwd);
			const started = performance.now();
			const result = spawnSync(process.execPath, [path.join(root, entry)], {
				cwd,
				env: {
					...process.env,
					WA2DC_SMOKE_TEST: "1",
					WA2DC_LOG_LEVEL: "silent",
				},
				timeout: 60000,
				encoding: "utf8",
			});
			if (result.status !== 0)
				throw new Error(
					result.stderr || result.error || `Smoke failed: ${entry}`,
				);
			elapsed.push(performance.now() - started);
		}
		results.startup[entry] = { medianMs: +median(elapsed).toFixed(2) };
	}
	for (const name of ["out.js", "out.cjs"]) {
		results[name] = { bytes: (await fs.stat(path.join(root, name))).size };
	}
	console.log(JSON.stringify(results, null, 2));
} finally {
	store.close();
	await fs.rm(temporaryDirectory, { recursive: true, force: true });
}
