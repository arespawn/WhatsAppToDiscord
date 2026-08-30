import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as tar from "tar";

import { buildRuntimeArchive } from "../scripts/buildRuntimeArchive.js";
import {
	normalizeStableChangelog,
	updateStableReleasePullRequestBody,
} from "../scripts/normalizeStableChangelog.js";
import { prepareReleaseAssets } from "../scripts/prepareReleaseAssets.js";
import {
	getSemverBumpForPrTitle,
	isConventionalPrTitle,
} from "../scripts/validatePrTitle.js";
import {
	compareVersionTags,
	getReleaseTarget,
	RELEASE_TARGETS,
	requiresUpdateManifest,
	UPDATE_MANIFEST_NAME,
	UPDATE_MANIFEST_SIGNATURE_NAME,
	validateUpdateManifest,
} from "../src/updateManifest.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Conventional PR title policy accepts release-driving and maintenance types", () => {
	for (const title of [
		"feat: add signed manifests",
		"fix(deps): update sharp",
		"feat!: change the update protocol",
		"chore(release): sync v2.5.0 back to next",
	]) {
		assert.equal(isConventionalPrTitle(title), true, title);
	}
	for (const title of ["Add signed manifests", "feat add manifest", "feat:"]) {
		assert.equal(isConventionalPrTitle(title), false, title);
	}
	assert.equal(getSemverBumpForPrTitle("feat: add signed manifests"), "minor");
	assert.equal(getSemverBumpForPrTitle("fix(deps): update sharp"), "patch");
	assert.equal(getSemverBumpForPrTitle("perf: reduce startup time"), "patch");
	assert.equal(getSemverBumpForPrTitle("revert: restore updater"), "patch");
	assert.equal(
		getSemverBumpForPrTitle("feat!: change manifest schema"),
		"major",
	);
	assert.equal(getSemverBumpForPrTitle("docs: explain channels"), null);
});

test("SemVer policy orders prereleases and requires manifests from 2.5", () => {
	assert.equal(compareVersionTags("v2.5.0", "v2.5.0-beta.9"), 1);
	assert.equal(compareVersionTags("v2.5.0-beta.10", "v2.5.0-beta.9"), 1);
	assert.equal(compareVersionTags("v2.4.9", "v2.5.0-beta.1"), -1);
	assert.equal(requiresUpdateManifest("v2.4.9"), false);
	assert.equal(requiresUpdateManifest("v2.5.0-beta.1"), true);
	assert.equal(requiresUpdateManifest("v3.0.0"), true);
});

test("runtime archive builder preserves relative in-tree symbolic links", {
	skip: process.platform === "win32",
}, async () => {
	const directory = await fs.mkdtemp(
		path.join(os.tmpdir(), "wa2dc-runtime-archive-test-"),
	);
	const sourceRuntimeDir = path.join(directory, "source-runtime");
	const extractedRoot = path.join(directory, "extracted");
	const archivePath = path.join(directory, "runtime.tar.gz");
	const binDirectory = path.join(sourceRuntimeDir, "node_modules", ".bin");
	const packageBinDirectory = path.join(
		sourceRuntimeDir,
		"node_modules",
		"prebuild-install",
	);
	try {
		await fs.mkdir(binDirectory, { recursive: true });
		await fs.mkdir(packageBinDirectory, { recursive: true });
		await fs.writeFile(
			path.join(sourceRuntimeDir, "package.json"),
			'{"private":true}\n',
		);
		await fs.writeFile(path.join(packageBinDirectory, "bin.js"), "bin\n");
		await fs.symlink(
			"../prebuild-install/bin.js",
			path.join(binDirectory, "prebuild-install"),
		);

		await buildRuntimeArchive({
			outputPath: archivePath,
			sourceRuntimeDir,
		});
		await fs.mkdir(extractedRoot);
		await tar.extract({ cwd: extractedRoot, file: archivePath, strict: true });
		assert.equal(
			await fs.readlink(
				path.join(
					extractedRoot,
					"runtime",
					"node_modules",
					".bin",
					"prebuild-install",
				),
			),
			"../prebuild-install/bin.js",
		);
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});

test("runtime archive builder rejects absolute symbolic links", {
	skip: process.platform === "win32",
}, async () => {
	const directory = await fs.mkdtemp(
		path.join(os.tmpdir(), "wa2dc-runtime-archive-invalid-"),
	);
	const sourceRuntimeDir = path.join(directory, "source-runtime");
	const archivePath = path.join(directory, "runtime.tar.gz");
	const binDirectory = path.join(sourceRuntimeDir, "node_modules", ".bin");
	const packageBin = path.join(
		sourceRuntimeDir,
		"node_modules",
		"prebuild-install",
		"bin.js",
	);
	try {
		await fs.mkdir(binDirectory, { recursive: true });
		await fs.mkdir(path.dirname(packageBin), { recursive: true });
		await fs.writeFile(
			path.join(sourceRuntimeDir, "package.json"),
			'{"private":true}\n',
		);
		await fs.writeFile(packageBin, "bin\n");
		await fs.symlink(packageBin, path.join(binDirectory, "prebuild-install"));

		await assert.rejects(
			() => buildRuntimeArchive({ outputPath: archivePath, sourceRuntimeDir }),
			/absolute symbolic link/u,
		);
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});

test("stable changelog notes aggregate matching beta entries without housekeeping", () => {
	const changelog = `# Changelog

## [2.5.1](https://example.test/compare/v2.5.1-beta.2...v2.5.1) (2026-08-29)

### Miscellaneous

* promote 2.5.1 to stable ([abc1234](https://example.test/commit/abc1234))

## [2.5.1-beta.2](https://example.test/compare/v2.5.1-beta.1...v2.5.1-beta.2) (2026-08-28)

### Bug Fixes

* fix shutdown ([def5678](https://example.test/commit/def5678))

### Miscellaneous

* checkpoint beta ([ghi9012](https://example.test/commit/ghi9012))

## [2.5.1-beta.1](https://example.test/compare/v2.5.0...v2.5.1-beta.1) (2026-08-27)

### Dependencies

* refresh dependencies ([jkl3456](https://example.test/commit/jkl3456))
`;

	const normalized = normalizeStableChangelog(changelog, "2.5.1");
	assert.match(
		normalized,
		/## \[2\.5\.1\][\s\S]*### Bug Fixes[\s\S]*fix shutdown[\s\S]*### Dependencies[\s\S]*refresh dependencies/u,
	);
	assert.match(
		normalized,
		/## \[2\.5\.1\]\(https:\/\/example\.test\/compare\/v2\.5\.0\.\.\.v2\.5\.1\)/u,
	);
	assert.doesNotMatch(
		normalized.slice(0, normalized.indexOf("## [2.5.1-beta.2]")),
		/promote 2\.5\.1|checkpoint beta/u,
	);
	const releasePrBody = `:robot: release
---

## [2.5.1](https://example.test/compare/v2.5.1-beta.2...v2.5.1) (2026-08-29)

### Miscellaneous

* promote 2.5.1 to stable

---
Generated by Release Please.
`;
	const normalizedBody = updateStableReleasePullRequestBody(
		releasePrBody,
		normalized,
		"2.5.1",
	);
	assert.match(normalizedBody, /fix shutdown[\s\S]*refresh dependencies/u);
	assert.doesNotMatch(normalizedBody, /promote 2\.5\.1/u);
	assert.match(normalizedBody, /---\nGenerated by Release Please\./u);
	assert.equal(normalizeStableChangelog(normalized, "2.5.1"), normalized);
});

test("release target map exposes exactly the supported packaged platforms", () => {
	assert.deepEqual(Object.keys(RELEASE_TARGETS), [
		"linux-x64",
		"linux-arm64",
		"darwin-x64",
		"win32-x64",
	]);
	assert.equal(getReleaseTarget("darwin", "arm64"), null);
	assert.equal(getReleaseTarget("win32", "arm64"), null);
	assert.equal(
		getReleaseTarget("linux", "arm64")?.executableName,
		"WA2DC-Linux-arm64",
	);
});

test("release asset preparation creates deterministic checksums and a signed manifest", async () => {
	const directory = await fs.mkdtemp(
		path.join(os.tmpdir(), "wa2dc-release-assets-"),
	);
	const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
		modulusLength: 2048,
		privateKeyEncoding: { type: "pkcs8", format: "pem" },
		publicKeyEncoding: { type: "spki", format: "pem" },
	});
	try {
		for (const target of Object.values(RELEASE_TARGETS)) {
			await fs.writeFile(
				path.join(directory, target.executableName),
				`binary:${target.executableName}`,
			);
			await fs.writeFile(
				path.join(directory, `${target.executableName}.runtime.tar.gz`),
				`runtime:${target.executableName}`,
			);
		}

		const manifest = await prepareReleaseAssets({
			directory,
			version: "v2.5.0-beta.1",
			commit: "a".repeat(40),
			channel: "unstable",
			privateKey,
		});
		const manifestBytes = await fs.readFile(
			path.join(directory, UPDATE_MANIFEST_NAME),
		);
		const manifestSignature = await fs.readFile(
			path.join(directory, UPDATE_MANIFEST_SIGNATURE_NAME),
		);

		assert.equal(
			crypto.verify("RSA-SHA256", manifestBytes, publicKey, manifestSignature),
			true,
		);
		const selected = validateUpdateManifest(manifest, {
			version: "v2.5.0-beta.1",
			channel: "unstable",
			platform: "linux",
			arch: "x64",
		});
		assert.equal(selected.executable.name, "WA2DC-Linux");
		assert.equal(
			await fs.readFile(path.join(directory, "WA2DC-Linux.sha256"), "utf8"),
			`${selected.executable.sha256}  WA2DC-Linux\n`,
		);
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});

test("manifest validation rejects unsafe or incomplete asset contracts", () => {
	const assets = Object.fromEntries(
		Object.entries(RELEASE_TARGETS).map(([key, target]) => [
			key,
			{
				executable: {
					name: target.executableName,
					size: 1,
					sha256: "a".repeat(64),
					signature: `${target.executableName}.sig`,
				},
				runtime: {
					name: `${target.executableName}.runtime.tar.gz`,
					size: 1,
					sha256: "b".repeat(64),
					signature: `${target.executableName}.runtime.tar.gz.sig`,
				},
			},
		]),
	);
	assets["linux-x64"].executable.name = "../WA2DC-Linux";
	assert.throws(
		() =>
			validateUpdateManifest(
				{
					schemaVersion: 1,
					version: "v2.5.0",
					commit: "a".repeat(40),
					channel: "stable",
					assets,
				},
				{
					version: "v2.5.0",
					channel: "stable",
					platform: "linux",
					arch: "x64",
				},
			),
		/asset name/u,
	);
});

test("workflow configuration covers CI, draft recovery, native targets, and immutable actions", async () => {
	const ci = await fs.readFile(
		path.join(ROOT, ".github/workflows/ci.yml"),
		"utf8",
	);
	const release = await fs.readFile(
		path.join(ROOT, ".github/workflows/release.yml"),
		"utf8",
	);
	const dependabot = await fs.readFile(
		path.join(ROOT, ".github/dependabot.yml"),
		"utf8",
	);
	assert.match(ci, /branches: \[main, next\]/u);
	assert.match(ci, /scripts\/validatePrTitle\.js/u);
	assert.match(ci, /PR_BODY:.*pull_request\.body/u);
	assert.match(ci, /Release-As: \$stable_version/u);
	assert.match(ci, /for attempt in \{1\.\.60\}/u);
	assert.match(ci, /sleep 10/u);
	assert.match(release, /workflow_dispatch:/u);
	assert.match(release, /ubuntu-24\.04-arm/u);
	assert.match(release, /Normalize stable release notes/u);
	assert.match(release, /scripts\/normalizeStableChangelog\.js/u);
	assert.match(release, /--pull-request-body/u);
	assert.match(release, /gh pr edit "\$pr_number" --body-file/u);
	assert.equal(
		[
			...release.matchAll(
				/^\s+client-id: \$\{\{ vars\.RELEASE_APP_CLIENT_ID \}\}$/gmu,
			),
		].length,
		2,
	);
	assert.doesNotMatch(release, /^\s+app-id:/mu);
	assert.match(
		release,
		/resolve:\r?\n[\s\S]*?permissions:\r?\n\s+# Draft releases[^\r\n]*\r?\n\s+contents: write/u,
	);
	const normalizedRelease = release
		.replaceAll("\r\n", "\n")
		.replaceAll(/\$\{\{/gu, "<EXPR>");
	assert.ok(
		normalizedRelease.includes(
			"group: release-<EXPR> github.event_name == 'workflow_dispatch' && (contains(inputs.tag, '-beta.') && 'next' || 'main') || github.ref_name }}",
		),
	);
	assert.match(normalizedRelease, /GITHUB_REF_NAME.*branch/u);
	assert.match(normalizedRelease, /RELEASE_SHA:.*resolve\.outputs\.sha/u);
	assert.match(
		normalizedRelease,
		/if ! next_sha=.*branches\/next[\s\S]*?refs\/heads\/next[\s\S]*?sha="\$RELEASE_SHA"/u,
	);
	assert.match(
		normalizedRelease,
		/compare\/next\.\.\.main[\s\S]*?ahead_by[\s\S]*?== "0"/u,
	);
	for (const snippet of [
		"  resolve:\n    needs: release_please\n    if: <EXPR> !cancelled() && (needs.release_please.outputs.release_created == 'true' || github.event_name == 'workflow_dispatch') }}",
		"  verify:\n    needs: resolve\n    if: <EXPR> !cancelled() && needs.resolve.result == 'success' }}",
		"  build:\n    needs: [resolve, verify]\n    if: <EXPR> !cancelled() && needs.resolve.result == 'success' && needs.verify.result == 'success' }}",
		"  sign:\n    needs: [resolve, build]\n    if: <EXPR> !cancelled() && needs.resolve.result == 'success' && needs.build.result == 'success' }}",
		"  docker:\n    needs: [resolve, sign]\n    if: <EXPR> !cancelled() && needs.resolve.result == 'success' && needs.sign.result == 'success' }}",
		"  publish:\n    needs: [resolve, sign, docker]\n    if: <EXPR> !cancelled() && needs.resolve.result == 'success' && needs.sign.result == 'success' && needs.docker.result == 'success' }}",
		"  sync_next:\n    needs: [resolve, publish]\n    if: <EXPR> !cancelled() && needs.resolve.result == 'success' && needs.publish.result == 'success' && needs.resolve.outputs.channel == 'stable' }}",
	]) {
		assert.ok(normalizedRelease.includes(snippet), snippet);
	}
	assert.equal(
		[...dependabot.matchAll(/^\s+target-branch: "next"$/gmu)].length,
		2,
	);
	assert.equal(
		[...dependabot.matchAll(/^\s+prefix: "fix\(deps\)"$/gmu)].length,
		2,
	);
	assert.match(dependabot, /prefix-development: "fix\(deps\)"/u);
	assert.doesNotMatch(dependabot, /include: "scope"/u);
	for (const binary of [
		"WA2DC-Linux",
		"WA2DC-Linux-arm64",
		"WA2DC-macOS",
		"WA2DC.exe",
	]) {
		assert.match(release, new RegExp(binary.replace(".", "\\."), "u"));
	}
	for (const line of release
		.split(/\r?\n/u)
		.filter((entry) => entry.includes("uses:"))) {
		assert.match(line, /@[a-f0-9]{40}(?:\s+#.*)?$/u, line);
	}

	for (const configName of [
		"release-please-config.beta.json",
		"release-please-config.stable.json",
	]) {
		const config = JSON.parse(
			await fs.readFile(path.join(ROOT, configName), "utf8"),
		);
		assert.equal(
			config["bootstrap-sha"],
			"00e2c9fe55067e2b8e1c842b1a1da972999a0b63",
		);
		assert.equal(config.packages["."]["bootstrap-sha"], undefined);
		assert.equal(config.packages["."]?.draft, true);
		assert.equal(config.packages["."]?.["force-tag-creation"], true);
		assert.equal(config.packages["."]?.versioning, "prerelease");
		assert.equal(config.packages["."]?.["prerelease-type"], "beta.1");
	}
	const stableConfig = JSON.parse(
		await fs.readFile(
			path.join(ROOT, "release-please-config.stable.json"),
			"utf8",
		),
	);
	assert.equal(stableConfig.packages["."]?.prerelease, false);
});
