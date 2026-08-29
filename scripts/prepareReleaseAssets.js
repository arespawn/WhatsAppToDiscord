import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	RELEASE_TARGETS,
	RELEASE_VERSION_PATTERN,
	sha256File,
	UPDATE_MANIFEST_NAME,
	UPDATE_MANIFEST_SCHEMA_VERSION,
	UPDATE_MANIFEST_SIGNATURE_NAME,
} from "../src/updateManifest.js";

const parseArgs = (argv) => {
	const parsed = {};
	for (let index = 0; index < argv.length; index += 2) {
		const key = argv[index];
		const value = argv[index + 1];
		if (!key?.startsWith("--") || value == null) {
			throw new Error(`Invalid argument near ${key || "<end>"}.`);
		}
		parsed[key.slice(2)] = value;
	}
	return parsed;
};

const signFile = async (filePath, signaturePath, privateKey) => {
	const payload = await fs.readFile(filePath);
	const signature = crypto.sign("RSA-SHA256", payload, privateKey);
	await fs.writeFile(signaturePath, signature, { mode: 0o600 });
};

const describeAsset = async (directory, name, privateKey) => {
	const filePath = path.join(directory, name);
	const stats = await fs.stat(filePath);
	if (!stats.isFile() || stats.size <= 0) {
		throw new Error(`Release asset is empty or missing: ${name}`);
	}
	const sha256 = await sha256File(filePath);
	await fs.writeFile(`${filePath}.sha256`, `${sha256}  ${name}\n`, "utf8");
	await signFile(filePath, `${filePath}.sig`, privateKey);
	return {
		name,
		size: stats.size,
		sha256,
		signature: `${name}.sig`,
	};
};

const prepareReleaseAssets = async ({
	directory,
	version,
	commit,
	channel,
	privateKey,
}) => {
	if (!RELEASE_VERSION_PATTERN.test(version || "")) {
		throw new Error("Release version must be a stable or beta tag.");
	}
	if (!/^[a-f0-9]{40}$/i.test(commit || "")) {
		throw new Error("Release commit must be a full Git SHA.");
	}
	if (!["stable", "unstable"].includes(channel)) {
		throw new Error("Release channel must be stable or unstable.");
	}
	const versionChannel = version.includes("-beta.") ? "unstable" : "stable";
	if (channel !== versionChannel) {
		throw new Error("Release channel does not match the version tag.");
	}
	if (!privateKey) throw new Error("SIGN_KEY is required.");

	const manifest = {
		schemaVersion: UPDATE_MANIFEST_SCHEMA_VERSION,
		version,
		commit: commit.toLowerCase(),
		channel,
		assets: {},
	};

	for (const [platformKey, target] of Object.entries(RELEASE_TARGETS)) {
		const executableName = target.executableName;
		const runtimeName = `${executableName}.runtime.tar.gz`;
		manifest.assets[platformKey] = {
			executable: await describeAsset(directory, executableName, privateKey),
			runtime: await describeAsset(directory, runtimeName, privateKey),
		};
	}

	const manifestPath = path.join(directory, UPDATE_MANIFEST_NAME);
	await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
		mode: 0o600,
	});
	await signFile(
		manifestPath,
		path.join(directory, UPDATE_MANIFEST_SIGNATURE_NAME),
		privateKey,
	);
	return manifest;
};

const main = async () => {
	const args = parseArgs(process.argv.slice(2));
	const directory = path.resolve(args.directory || "build/release");
	await prepareReleaseAssets({
		directory,
		version: args.version,
		commit: args.commit,
		channel: args.channel,
		privateKey: process.env.SIGN_KEY,
	});
};

const isCli =
	process.argv[1] &&
	path.resolve(process.argv[1]) ===
		path.resolve(fileURLToPath(import.meta.url));
if (isCli) await main();

export { prepareReleaseAssets };
