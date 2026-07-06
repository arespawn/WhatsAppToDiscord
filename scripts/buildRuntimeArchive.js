import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import {
	getRuntimeSidecarPackageSpecs,
	prepareRuntimeSidecar,
} from "./runtimeSidecar.js";

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
		prepareRuntimeSidecar(runtimeDir, packageSpecs, {
			targetOs,
			targetCpu,
			targetLibc,
		});

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
