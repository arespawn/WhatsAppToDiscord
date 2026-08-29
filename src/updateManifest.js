import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const UPDATE_MANIFEST_NAME = "update-manifest.json";
const UPDATE_MANIFEST_SIGNATURE_NAME = `${UPDATE_MANIFEST_NAME}.sig`;
const UPDATE_MANIFEST_SCHEMA_VERSION = 1;
const RELEASE_VERSION_PATTERN = /^v\d+\.\d+\.\d+(?:-beta\.\d+)?$/u;
const UPDATE_MANIFEST_MIN_CORE_VERSION = Object.freeze({
	major: 2,
	minor: 5,
	patch: 0,
});

const RELEASE_TARGETS = Object.freeze({
	"linux-x64": Object.freeze({
		platform: "linux",
		arch: "x64",
		executableName: "WA2DC-Linux",
	}),
	"linux-arm64": Object.freeze({
		platform: "linux",
		arch: "arm64",
		executableName: "WA2DC-Linux-arm64",
	}),
	"darwin-x64": Object.freeze({
		platform: "darwin",
		arch: "x64",
		executableName: "WA2DC-macOS",
	}),
	"win32-x64": Object.freeze({
		platform: "win32",
		arch: "x64",
		executableName: "WA2DC.exe",
	}),
});

const parseVersionTag = (tag = "") => {
	const normalized = String(tag).trim().replace(/^v/i, "");
	const match = normalized.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
	if (!match) return null;
	const prerelease = match[4]
		? match[4]
				.split(".")
				.filter(Boolean)
				.map((identifier) =>
					/^\d+$/.test(identifier) ? Number(identifier) : identifier,
				)
		: [];
	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
		prerelease,
	};
};

const comparePrereleaseIdentifiers = (aIdentifiers = [], bIdentifiers = []) => {
	const maxLength = Math.max(aIdentifiers.length, bIdentifiers.length);
	for (let index = 0; index < maxLength; index += 1) {
		const left = aIdentifiers[index];
		const right = bIdentifiers[index];
		if (left === undefined && right === undefined) return 0;
		if (left === undefined) return -1;
		if (right === undefined) return 1;
		if (left === right) continue;

		const leftIsNumber = typeof left === "number";
		const rightIsNumber = typeof right === "number";
		if (leftIsNumber && rightIsNumber) return left > right ? 1 : -1;
		if (leftIsNumber) return -1;
		if (rightIsNumber) return 1;
		return String(left).localeCompare(String(right)) > 0 ? 1 : -1;
	}
	return 0;
};

const compareVersionTags = (leftTag = "", rightTag = "") => {
	const left = parseVersionTag(leftTag);
	const right = parseVersionTag(rightTag);
	if (!left || !right) return 0;

	if (left.major !== right.major) return left.major > right.major ? 1 : -1;
	if (left.minor !== right.minor) return left.minor > right.minor ? 1 : -1;
	if (left.patch !== right.patch) return left.patch > right.patch ? 1 : -1;
	if (!left.prerelease.length && right.prerelease.length) return 1;
	if (left.prerelease.length && !right.prerelease.length) return -1;
	return comparePrereleaseIdentifiers(left.prerelease, right.prerelease);
};

const requiresUpdateManifest = (versionTag) => {
	const version = parseVersionTag(versionTag);
	if (!version) return true;
	const minimum = UPDATE_MANIFEST_MIN_CORE_VERSION;
	if (version.major !== minimum.major) return version.major > minimum.major;
	if (version.minor !== minimum.minor) return version.minor > minimum.minor;
	return version.patch >= minimum.patch;
};

const getReleasePlatformKey = (platform, arch) => `${platform}-${arch}`;

const getReleaseTarget = (platform, arch) =>
	RELEASE_TARGETS[getReleasePlatformKey(platform, arch)] || null;

const isSafeReleaseAssetName = (name) =>
	typeof name === "string" &&
	name.length > 0 &&
	name.length <= 160 &&
	path.basename(name) === name &&
	!name.includes("..") &&
	/^[A-Za-z0-9._-]+$/.test(name);

const validateManifestAsset = (asset, expectedName, label) => {
	if (!asset || typeof asset !== "object" || Array.isArray(asset)) {
		throw new Error(`Invalid ${label} manifest entry.`);
	}
	if (!isSafeReleaseAssetName(asset.name) || asset.name !== expectedName) {
		throw new Error(`Unexpected ${label} asset name.`);
	}
	if (
		!Number.isSafeInteger(asset.size) ||
		asset.size <= 0 ||
		asset.size > Number.MAX_SAFE_INTEGER
	) {
		throw new Error(`Invalid ${label} asset size.`);
	}
	if (
		typeof asset.sha256 !== "string" ||
		!/^[a-f0-9]{64}$/.test(asset.sha256)
	) {
		throw new Error(`Invalid ${label} SHA-256 digest.`);
	}
	if (
		!isSafeReleaseAssetName(asset.signature) ||
		asset.signature !== `${asset.name}.sig`
	) {
		throw new Error(`Unexpected ${label} signature name.`);
	}
	return asset;
};

const validateUpdateManifest = (
	manifest,
	{ version, channel, platform, arch } = {},
) => {
	if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
		throw new Error("Update manifest must be an object.");
	}
	if (manifest.schemaVersion !== UPDATE_MANIFEST_SCHEMA_VERSION) {
		throw new Error("Unsupported update manifest schema version.");
	}
	if (
		!RELEASE_VERSION_PATTERN.test(manifest.version || "") ||
		manifest.version !== version
	) {
		throw new Error("Update manifest version does not match the release tag.");
	}
	if (!/^[a-f0-9]{40}$/i.test(manifest.commit || "")) {
		throw new Error("Update manifest commit is invalid.");
	}
	if (!["stable", "unstable"].includes(manifest.channel)) {
		throw new Error("Update manifest channel is invalid.");
	}
	const versionChannel = manifest.version.includes("-beta.")
		? "unstable"
		: "stable";
	if (manifest.channel !== versionChannel) {
		throw new Error("Update manifest channel does not match its version.");
	}
	if (channel && manifest.channel !== channel) {
		throw new Error(
			"Update manifest channel does not match the selected channel.",
		);
	}
	if (!manifest.assets || typeof manifest.assets !== "object") {
		throw new Error("Update manifest assets are missing.");
	}

	for (const [platformKey, target] of Object.entries(RELEASE_TARGETS)) {
		const entry = manifest.assets[platformKey];
		if (!entry || typeof entry !== "object") {
			throw new Error(`Update manifest is missing ${platformKey}.`);
		}
		validateManifestAsset(
			entry.executable,
			target.executableName,
			`${platformKey} executable`,
		);
		validateManifestAsset(
			entry.runtime,
			`${target.executableName}.runtime.tar.gz`,
			`${platformKey} runtime`,
		);
	}

	const platformKey = getReleasePlatformKey(platform, arch);
	const selected = manifest.assets[platformKey];
	if (!RELEASE_TARGETS[platformKey] || !selected) {
		throw new Error(`No signed update is available for ${platformKey}.`);
	}
	return selected;
};

const sha256File = async (filePath) => {
	const hash = crypto.createHash("sha256");
	const stream = fs.createReadStream(filePath);
	for await (const chunk of stream) hash.update(chunk);
	return hash.digest("hex");
};

export {
	compareVersionTags,
	getReleasePlatformKey,
	getReleaseTarget,
	isSafeReleaseAssetName,
	parseVersionTag,
	RELEASE_TARGETS,
	RELEASE_VERSION_PATTERN,
	requiresUpdateManifest,
	sha256File,
	UPDATE_MANIFEST_MIN_CORE_VERSION,
	UPDATE_MANIFEST_NAME,
	UPDATE_MANIFEST_SCHEMA_VERSION,
	UPDATE_MANIFEST_SIGNATURE_NAME,
	validateUpdateManifest,
};
