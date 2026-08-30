import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

const isPathWithin = (rootPath, candidatePath) => {
	const relative = path.relative(rootPath, candidatePath);
	return (
		relative === "" ||
		(relative !== ".." &&
			!relative.startsWith(`..${path.sep}`) &&
			!path.isAbsolute(relative))
	);
};

const toArchivePath = (runtimeDir, entryPath) =>
	path.relative(runtimeDir, entryPath).split(path.sep).join("/");

const validateRuntimeSymlinks = (runtimeDir) => {
	const lexicalRuntimeRoot = path.resolve(runtimeDir);
	const runtimeRoot = fs.realpathSync(runtimeDir);

	const visit = (directory) => {
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			const entryPath = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				visit(entryPath);
				continue;
			}
			if (!entry.isSymbolicLink()) continue;

			const archivePath = toArchivePath(runtimeDir, entryPath);
			const linkTarget = fs.readlinkSync(entryPath);
			if (path.isAbsolute(linkTarget)) {
				throw new Error(
					`Runtime archive contains an absolute symbolic link: ${archivePath} -> ${linkTarget}`,
				);
			}

			const resolvedTarget = path.resolve(path.dirname(entryPath), linkTarget);
			if (!isPathWithin(lexicalRuntimeRoot, resolvedTarget)) {
				throw new Error(
					`Runtime archive symbolic link escapes runtime/: ${archivePath} -> ${linkTarget}`,
				);
			}

			let realTarget;
			try {
				realTarget = fs.realpathSync(entryPath);
			} catch (error) {
				throw new Error(
					`Runtime archive contains a dangling symbolic link: ${archivePath} -> ${linkTarget}`,
					{ cause: error },
				);
			}
			if (!isPathWithin(runtimeRoot, realTarget)) {
				throw new Error(
					`Runtime archive symbolic link resolves outside runtime/: ${archivePath} -> ${linkTarget}`,
				);
			}
		}
	};

	visit(runtimeDir);
};

const buildRuntimeArchive = async ({
	outputPath,
	sourceRuntimeDir = null,
	targetOs = null,
	targetCpu = null,
	targetLibc = null,
	packageSpecs = null,
}) => {
	const resolvedOutputPath = outputPath ? path.resolve(outputPath) : null;
	const resolvedSourceRuntimeDir = sourceRuntimeDir
		? path.resolve(sourceRuntimeDir)
		: null;
	if (!resolvedOutputPath) {
		throw new Error("Missing required --output argument");
	}

	const tempRoot = fs.mkdtempSync(
		path.join(os.tmpdir(), "wa2dc-runtime-archive-"),
	);
	const runtimeDir = path.join(tempRoot, "runtime");

	try {
		if (resolvedSourceRuntimeDir) {
			const sourceStats = fs.statSync(resolvedSourceRuntimeDir);
			if (!sourceStats.isDirectory()) {
				throw new Error(
					`Runtime source is not a directory: ${resolvedSourceRuntimeDir}`,
				);
			}
			fs.accessSync(
				path.join(resolvedSourceRuntimeDir, "package.json"),
				fs.constants.F_OK,
			);
			fs.cpSync(resolvedSourceRuntimeDir, runtimeDir, {
				recursive: true,
				verbatimSymlinks: true,
			});
		} else {
			prepareRuntimeSidecar(
				runtimeDir,
				packageSpecs || getRuntimeSidecarPackageSpecs(),
				{
					targetOs,
					targetCpu,
					targetLibc,
				},
			);
		}
		validateRuntimeSymlinks(runtimeDir);

		fs.mkdirSync(path.dirname(resolvedOutputPath), { recursive: true });
		await tar.create(
			{
				cwd: tempRoot,
				file: resolvedOutputPath,
				gzip: true,
				portable: true,
			},
			["runtime"],
		);
	} finally {
		fs.rmSync(tempRoot, { recursive: true, force: true });
	}
};

const main = async () => {
	const args = parseArgs(process.argv.slice(2));
	await buildRuntimeArchive({
		outputPath: args.output,
		sourceRuntimeDir: args.source || null,
		targetOs: args.os || null,
		targetCpu: args.cpu || null,
		targetLibc: args.libc || null,
	});
};

const isCli =
	process.argv[1] &&
	path.resolve(process.argv[1]) ===
		path.resolve(fileURLToPath(import.meta.url));
if (isCli) await main();

export { buildRuntimeArchive, validateRuntimeSymlinks };
