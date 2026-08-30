import assert from "node:assert/strict";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as tar from "tar";

import state from "../src/state.js";
import utils from "../src/utils.js";

test("packaged updater installs the matching runtime sidecar archive", async () => {
	const tempDir = await fsPromises.mkdtemp(
		path.join(os.tmpdir(), "wa2dc-updater-runtime-"),
	);
	const currentExePath = path.join(tempDir, "WA2DC-Linux");
	const runtimePath = path.join(tempDir, "runtime");
	const stagedRuntimeRoot = await fsPromises.mkdtemp(
		path.join(os.tmpdir(), "wa2dc-runtime-staged-"),
	);
	const archivePath = path.join(
		stagedRuntimeRoot,
		"WA2DC-Linux.runtime.tar.gz",
	);

	const originalUpdater = {
		isNode: utils.updater.isNode,
		getCurrentExecutablePath: utils.updater.getCurrentExecutablePath,
		stageReleaseArtifacts: utils.updater.stageReleaseArtifacts,
	};
	const defaultExeNameDescriptor = Object.getOwnPropertyDescriptor(
		utils.updater,
		"defaultExeName",
	);
	const originalKeepOldBinary = state.settings.KeepOldBinary;

	try {
		await fsPromises.writeFile(currentExePath, "old-binary");
		await fsPromises.mkdir(path.join(runtimePath, "node_modules", "sharp"), {
			recursive: true,
		});
		await fsPromises.writeFile(
			path.join(runtimePath, "package.json"),
			'{"private":true,"description":"old runtime"}\n',
		);
		await fsPromises.writeFile(
			path.join(runtimePath, "node_modules", "sharp", "package.json"),
			'{"name":"sharp","version":"0.34.4"}\n',
		);

		await fsPromises.mkdir(
			path.join(stagedRuntimeRoot, "runtime", "node_modules", "sharp"),
			{ recursive: true },
		);
		await fsPromises.writeFile(
			path.join(stagedRuntimeRoot, "runtime", "package.json"),
			'{"private":true,"description":"new runtime"}\n',
		);
		await fsPromises.writeFile(
			path.join(
				stagedRuntimeRoot,
				"runtime",
				"node_modules",
				"sharp",
				"package.json",
			),
			'{"name":"sharp","version":"0.34.5"}\n',
		);
		await tar.create(
			{
				cwd: stagedRuntimeRoot,
				file: archivePath,
				gzip: true,
				portable: true,
			},
			["runtime"],
		);

		utils.updater.isNode = false;
		utils.updater.getCurrentExecutablePath = () => currentExePath;
		Object.defineProperty(utils.updater, "defaultExeName", {
			configurable: true,
			get: () => "WA2DC-Linux",
		});
		const updateStage = await fsPromises.mkdtemp(
			path.join(os.tmpdir(), "wa2dc-update-test-stage-"),
		);
		const stagedBinaryPath = path.join(updateStage, "WA2DC-Linux");
		const stagedRuntimePath = path.join(
			updateStage,
			"WA2DC-Linux.runtime.tar.gz",
		);
		await fsPromises.writeFile(stagedBinaryPath, "new-binary");
		await fsPromises.copyFile(archivePath, stagedRuntimePath);
		utils.updater.stageReleaseArtifacts = async () => ({
			directory: updateStage,
			executablePath: stagedBinaryPath,
			runtimeArchivePath: stagedRuntimePath,
		});
		state.settings.KeepOldBinary = true;

		const result = await utils.updater.update("v9.9.9");
		assert.equal(result, true);
		assert.equal(
			await fsPromises.readFile(currentExePath, "utf8"),
			"new-binary",
		);
		assert.match(
			await fsPromises.readFile(path.join(runtimePath, "package.json"), "utf8"),
			/new runtime/u,
		);
		assert.match(
			await fsPromises.readFile(
				path.join(runtimePath, "node_modules", "sharp", "package.json"),
				"utf8",
			),
			/0\.34\.5/u,
		);
		await assert.rejects(() => fsPromises.stat(updateStage), /ENOENT/);
	} finally {
		utils.updater.isNode = originalUpdater.isNode;
		utils.updater.getCurrentExecutablePath =
			originalUpdater.getCurrentExecutablePath;
		utils.updater.stageReleaseArtifacts = originalUpdater.stageReleaseArtifacts;
		if (defaultExeNameDescriptor) {
			Object.defineProperty(
				utils.updater,
				"defaultExeName",
				defaultExeNameDescriptor,
			);
		}
		state.settings.KeepOldBinary = originalKeepOldBinary;
		await fsPromises.rm(tempDir, { recursive: true, force: true });
		await fsPromises.rm(stagedRuntimeRoot, { recursive: true, force: true });
	}
});

test("packaged startup bootstraps runtime sidecar when missing", async () => {
	const tempDir = await fsPromises.mkdtemp(
		path.join(os.tmpdir(), "wa2dc-runtime-bootstrap-"),
	);
	const currentExePath = path.join(tempDir, "WA2DC-Linux");
	const runtimePath = path.join(tempDir, "runtime");
	const stagedRuntimeRoot = await fsPromises.mkdtemp(
		path.join(os.tmpdir(), "wa2dc-runtime-bootstrap-staged-"),
	);
	const archivePath = path.join(
		stagedRuntimeRoot,
		"WA2DC-Linux.runtime.tar.gz",
	);

	const originalProcessPkgDescriptor = Object.getOwnPropertyDescriptor(
		process,
		"pkg",
	);
	const originalUpdater = {
		stageReleaseArtifacts: utils.updater.stageReleaseArtifacts,
		getCurrentExecutablePath: utils.updater.getCurrentExecutablePath,
	};
	const defaultExeNameDescriptor = Object.getOwnPropertyDescriptor(
		utils.updater,
		"defaultExeName",
	);
	const originalLogger = state.logger;
	const originalKeepOldBinary = state.settings.KeepOldBinary;

	try {
		await fsPromises.writeFile(currentExePath, "binary");
		await fsPromises.mkdir(
			path.join(stagedRuntimeRoot, "runtime", "node_modules", "sharp"),
			{ recursive: true },
		);
		await fsPromises.writeFile(
			path.join(stagedRuntimeRoot, "runtime", "package.json"),
			'{"private":true,"description":"bootstrapped runtime"}\n',
		);
		await fsPromises.writeFile(
			path.join(
				stagedRuntimeRoot,
				"runtime",
				"node_modules",
				"sharp",
				"index.js",
			),
			"module.exports = function sharp() {}; module.exports.default = module.exports;\n",
		);
		await fsPromises.writeFile(
			path.join(
				stagedRuntimeRoot,
				"runtime",
				"node_modules",
				"sharp",
				"package.json",
			),
			'{"name":"sharp","main":"index.js","version":"0.34.5"}\n',
		);
		await tar.create(
			{
				cwd: stagedRuntimeRoot,
				file: archivePath,
				gzip: true,
				portable: true,
			},
			["runtime"],
		);

		Object.defineProperty(process, "pkg", {
			configurable: true,
			value: {},
		});
		utils.updater.getCurrentExecutablePath = () => currentExePath;
		Object.defineProperty(utils.updater, "defaultExeName", {
			configurable: true,
			get: () => "WA2DC-Linux",
		});
		const updateStage = await fsPromises.mkdtemp(
			path.join(os.tmpdir(), "wa2dc-runtime-bootstrap-stage-"),
		);
		const stagedRuntimePath = path.join(
			updateStage,
			"WA2DC-Linux.runtime.tar.gz",
		);
		await fsPromises.copyFile(archivePath, stagedRuntimePath);
		utils.updater.stageReleaseArtifacts = async () => ({
			directory: updateStage,
			executablePath: null,
			runtimeArchivePath: stagedRuntimePath,
		});
		state.logger = { info() {}, warn() {}, error() {} };
		state.settings.KeepOldBinary = false;

		const result = await utils.updater.ensureRuntimeSidecar("v9.9.9");
		assert.equal(result, true);
		assert.match(
			await fsPromises.readFile(path.join(runtimePath, "package.json"), "utf8"),
			/bootstrapped runtime/u,
		);
		await assert.rejects(
			() => fsPromises.stat(`${runtimePath}.oldVersion`),
			/ENOENT/,
		);
	} finally {
		if (originalProcessPkgDescriptor) {
			Object.defineProperty(process, "pkg", originalProcessPkgDescriptor);
		} else {
			delete process.pkg;
		}
		utils.updater.stageReleaseArtifacts = originalUpdater.stageReleaseArtifacts;
		utils.updater.getCurrentExecutablePath =
			originalUpdater.getCurrentExecutablePath;
		if (defaultExeNameDescriptor) {
			Object.defineProperty(
				utils.updater,
				"defaultExeName",
				defaultExeNameDescriptor,
			);
		}
		state.logger = originalLogger;
		state.settings.KeepOldBinary = originalKeepOldBinary;
		await fsPromises.rm(tempDir, { recursive: true, force: true });
		await fsPromises.rm(stagedRuntimeRoot, { recursive: true, force: true });
	}
});

test("runtime archive install falls back to copy when rename crosses filesystems", async () => {
	const tempDir = await fsPromises.mkdtemp(
		path.join(os.tmpdir(), "wa2dc-runtime-exdev-"),
	);
	const currentExePath = path.join(tempDir, "WA2DC-Linux");
	const runtimePath = path.join(tempDir, "runtime");
	const stagedRuntimeRoot = await fsPromises.mkdtemp(
		path.join(os.tmpdir(), "wa2dc-runtime-exdev-staged-"),
	);
	const archivePath = path.join(
		stagedRuntimeRoot,
		"WA2DC-Linux.runtime.tar.gz",
	);

	const originalGetCurrentExecutablePath =
		utils.updater.getCurrentExecutablePath;
	const originalRename = fs.promises.rename;
	const originalCp = fs.promises.cp;
	let renameFailed = false;
	let copyCalled = false;
	let copyOptions = null;

	try {
		await fsPromises.writeFile(currentExePath, "binary");
		await fsPromises.mkdir(
			path.join(stagedRuntimeRoot, "runtime", "node_modules", "sharp"),
			{ recursive: true },
		);
		await fsPromises.writeFile(
			path.join(stagedRuntimeRoot, "runtime", "package.json"),
			'{"private":true,"description":"exdev runtime"}\n',
		);
		await fsPromises.writeFile(
			path.join(
				stagedRuntimeRoot,
				"runtime",
				"node_modules",
				"sharp",
				"package.json",
			),
			'{"name":"sharp","version":"0.34.5"}\n',
		);
		if (process.platform !== "win32") {
			const binDirectory = path.join(
				stagedRuntimeRoot,
				"runtime",
				"node_modules",
				".bin",
			);
			const packageBinDirectory = path.join(
				stagedRuntimeRoot,
				"runtime",
				"node_modules",
				"prebuild-install",
			);
			await fsPromises.mkdir(binDirectory, { recursive: true });
			await fsPromises.mkdir(packageBinDirectory, { recursive: true });
			await fsPromises.writeFile(
				path.join(packageBinDirectory, "bin.js"),
				"bin\n",
			);
			await fsPromises.symlink(
				"../prebuild-install/bin.js",
				path.join(binDirectory, "prebuild-install"),
			);
		}
		await tar.create(
			{
				cwd: stagedRuntimeRoot,
				file: archivePath,
				gzip: true,
				portable: true,
			},
			["runtime"],
		);

		utils.updater.getCurrentExecutablePath = () => currentExePath;
		fs.promises.rename = async (from, to) => {
			if (
				String(from).includes("wa2dc-runtime-install-") &&
				to === runtimePath
			) {
				renameFailed = true;
				const err = new Error("cross-device");
				err.code = "EXDEV";
				throw err;
			}
			return originalRename.call(fs.promises, from, to);
		};
		fs.promises.cp = async (...args) => {
			copyCalled = true;
			copyOptions = args[2];
			return originalCp.call(fs.promises, ...args);
		};

		await utils.updater.installRuntimeArchive(archivePath);
		assert.equal(renameFailed, true);
		assert.equal(copyCalled, true);
		assert.equal(copyOptions?.verbatimSymlinks, true);
		assert.match(
			await fsPromises.readFile(path.join(runtimePath, "package.json"), "utf8"),
			/exdev runtime/u,
		);
		if (process.platform !== "win32") {
			assert.equal(
				await fsPromises.readlink(
					path.join(runtimePath, "node_modules", ".bin", "prebuild-install"),
				),
				"../prebuild-install/bin.js",
			);
		}
	} finally {
		utils.updater.getCurrentExecutablePath = originalGetCurrentExecutablePath;
		fs.promises.rename = originalRename;
		fs.promises.cp = originalCp;
		await fsPromises.rm(tempDir, { recursive: true, force: true });
		await fsPromises.rm(stagedRuntimeRoot, { recursive: true, force: true });
	}
});

test("failed staging leaves the packaged installation untouched", async () => {
	const tempDir = await fsPromises.mkdtemp(
		path.join(os.tmpdir(), "wa2dc-update-preflight-"),
	);
	const currentExePath = path.join(tempDir, "WA2DC-Linux");
	const original = {
		isNode: utils.updater.isNode,
		getCurrentExecutablePath: utils.updater.getCurrentExecutablePath,
		stageReleaseArtifacts: utils.updater.stageReleaseArtifacts,
	};
	try {
		await fsPromises.writeFile(currentExePath, "old-binary");
		utils.updater.isNode = false;
		utils.updater.getCurrentExecutablePath = () => currentExePath;
		utils.updater.stageReleaseArtifacts = async () => {
			throw new Error("release_asset_hash_mismatch:WA2DC-Linux");
		};

		assert.equal(await utils.updater.update("v2.5.0"), false);
		assert.equal(
			await fsPromises.readFile(currentExePath, "utf8"),
			"old-binary",
		);
		await assert.rejects(
			() => fsPromises.stat(`${currentExePath}.oldVersion`),
			/ENOENT/,
		);
	} finally {
		utils.updater.isNode = original.isNode;
		utils.updater.getCurrentExecutablePath = original.getCurrentExecutablePath;
		utils.updater.stageReleaseArtifacts = original.stageReleaseArtifacts;
		await fsPromises.rm(tempDir, { recursive: true, force: true });
	}
});

test("installation failure restores the previous executable and runtime", async () => {
	const tempDir = await fsPromises.mkdtemp(
		path.join(os.tmpdir(), "wa2dc-update-rollback-"),
	);
	const currentExePath = path.join(tempDir, "WA2DC-Linux");
	const runtimePath = path.join(tempDir, "runtime");
	const stageDir = await fsPromises.mkdtemp(
		path.join(os.tmpdir(), "wa2dc-update-rollback-stage-"),
	);
	const stagedExePath = path.join(stageDir, "WA2DC-Linux");
	const stagedRuntimePath = path.join(stageDir, "WA2DC-Linux.runtime.tar.gz");
	const original = {
		isNode: utils.updater.isNode,
		getCurrentExecutablePath: utils.updater.getCurrentExecutablePath,
		stageReleaseArtifacts: utils.updater.stageReleaseArtifacts,
		installRuntimeArchive: utils.updater.installRuntimeArchive,
	};
	try {
		await fsPromises.writeFile(currentExePath, "old-binary");
		await fsPromises.mkdir(runtimePath);
		await fsPromises.writeFile(
			path.join(runtimePath, "package.json"),
			"old-runtime",
		);
		await fsPromises.writeFile(stagedExePath, "new-binary");
		await fsPromises.writeFile(stagedRuntimePath, "archive");
		utils.updater.isNode = false;
		utils.updater.getCurrentExecutablePath = () => currentExePath;
		utils.updater.stageReleaseArtifacts = async () => ({
			directory: stageDir,
			executablePath: stagedExePath,
			runtimeArchivePath: stagedRuntimePath,
		});
		utils.updater.installRuntimeArchive = async () => {
			throw new Error("install failed");
		};

		assert.equal(await utils.updater.update("v2.5.0"), false);
		assert.equal(
			await fsPromises.readFile(currentExePath, "utf8"),
			"old-binary",
		);
		assert.equal(
			await fsPromises.readFile(path.join(runtimePath, "package.json"), "utf8"),
			"old-runtime",
		);
	} finally {
		utils.updater.isNode = original.isNode;
		utils.updater.getCurrentExecutablePath = original.getCurrentExecutablePath;
		utils.updater.stageReleaseArtifacts = original.stageReleaseArtifacts;
		utils.updater.installRuntimeArchive = original.installRuntimeArchive;
		await fsPromises.rm(tempDir, { recursive: true, force: true });
		await fsPromises.rm(stageDir, { recursive: true, force: true });
	}
});
