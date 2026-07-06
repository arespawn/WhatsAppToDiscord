import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";

const require = createRequire(import.meta.url);
const RUNTIME_SIDECAR_DEPENDENCIES = ["sharp", "canvas", "jsdom", "lottie-web"];

const parseArgs = (argv = []) => {
	const parsed = {};
	for (let idx = 0; idx < argv.length; idx += 1) {
		const entry = argv[idx];
		if (!entry.startsWith("--")) continue;
		const key = entry.slice(2);
		const value = argv[idx + 1];
		if (!key || value == null || value.startsWith("--")) {
			throw new Error(`Missing value for argument: ${entry}`);
		}
		parsed[key] = value;
		idx += 1;
	}
	return parsed;
};

const run = (command, args, options = {}) => {
	const result = spawnSync(command, args, {
		stdio: "inherit",
		...(process.platform === "win32" ? { shell: true } : null),
		...options,
	});
	if (result.error) throw result.error;
	if (typeof result.status === "number" && result.status !== 0) {
		throw new Error(
			`Command failed (${result.status}): ${command} ${args.join(" ")}`,
		);
	}
};

const getBin = (name) => (process.platform === "win32" ? `${name}.cmd` : name);

const readInstalledPackageJson = (packageName) => {
	let currentDir = path.dirname(require.resolve(packageName));
	while (true) {
		const packageJsonPath = path.join(currentDir, "package.json");
		if (fs.existsSync(packageJsonPath)) {
			return JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
		}

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) {
			throw new Error(`Unable to locate package.json for ${packageName}`);
		}
		currentDir = parentDir;
	}
};

const getRuntimeSidecarPackageSpecs = () =>
	RUNTIME_SIDECAR_DEPENDENCIES.map((packageName) => {
		try {
			const packageJson = readInstalledPackageJson(packageName);
			return `${packageName}@${packageJson.version}`;
		} catch (err) {
			throw new Error(
				`Unable to resolve ${packageName} for packaged runtime sidecar: ${err?.message || err}`,
			);
		}
	});

const main = async () => {
	const args = parseArgs(process.argv.slice(2));
	const outputPath = args.output ? path.resolve(args.output) : null;
	if (!outputPath) {
		throw new Error("Missing required --output argument");
	}

	const targetOs = args.os || null;
	const targetCpu = args.cpu || null;
	const targetLibc = args.libc || null;
	const tempRoot = fs.mkdtempSync(
		path.join(os.tmpdir(), "wa2dc-runtime-archive-"),
	);
	const runtimeDir = path.join(tempRoot, "runtime");
	const packageSpecs = getRuntimeSidecarPackageSpecs();

	try {
		fs.mkdirSync(runtimeDir, { recursive: true });
		fs.writeFileSync(
			path.join(runtimeDir, "package.json"),
			`${JSON.stringify(
				{
					private: true,
					description: "WA2DC packaged runtime sidecar",
				},
				null,
				2,
			)}\n`,
		);

		const installArgs = [
			"install",
			"--omit=dev",
			"--no-package-lock",
			"--no-save",
			...packageSpecs,
		];
		if (targetOs) installArgs.push(`--os=${targetOs}`);
		if (targetCpu) installArgs.push(`--cpu=${targetCpu}`);
		if (targetLibc) installArgs.push(`--libc=${targetLibc}`);

		run(getBin("npm"), installArgs, { cwd: runtimeDir });

		fs.mkdirSync(path.dirname(outputPath), { recursive: true });
		await tar.create(
			{
				cwd: tempRoot,
				file: outputPath,
				gzip: true,
				portable: true,
			},
			["runtime"],
		);
	} finally {
		fs.rmSync(tempRoot, { recursive: true, force: true });
	}
};

await main();
