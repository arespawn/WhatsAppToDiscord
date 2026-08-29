import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { sha256File } from "../src/updateManifest.js";
import utils from "../src/utils.js";

test("pre-2.5 releases use only the fixed legacy asset contract", async () => {
	const originalFetchManifest = utils.updater.fetchVerifiedUpdateManifest;
	try {
		utils.updater.fetchVerifiedUpdateManifest = async () => {
			throw new Error("legacy release attempted to load a manifest");
		};
		const plan = await utils.updater.resolveReleaseAssetPlan(
			"v2.4.9",
			"stable",
		);
		assert.equal(plan.executable.name, utils.updater.defaultExeName);
		assert.equal(
			plan.runtime.name,
			`${utils.updater.defaultExeName}.runtime.tar.gz`,
		);
	} finally {
		utils.updater.fetchVerifiedUpdateManifest = originalFetchManifest;
	}
});

test("manifest bytes must have a valid release signature before parsing", async () => {
	const originalPublicKey = utils.updater.publicKey;
	const originalFetchAsset = utils.updater.fetchReleaseAsset;
	const { publicKey } = crypto.generateKeyPairSync("rsa", {
		modulusLength: 2048,
		publicKeyEncoding: { type: "spki", format: "pem" },
		privateKeyEncoding: { type: "pkcs8", format: "pem" },
	});
	try {
		utils.updater.publicKey = publicKey;
		utils.updater.fetchReleaseAsset = async (name) => ({
			result: name.endsWith(".sig")
				? Buffer.from("invalid signature")
				: Buffer.from('{"schemaVersion":1}'),
		});
		await assert.rejects(
			utils.updater.fetchVerifiedUpdateManifest("v2.5.0-beta.1", "unstable"),
			/update_manifest_signature_invalid/u,
		);
	} finally {
		utils.updater.publicKey = originalPublicKey;
		utils.updater.fetchReleaseAsset = originalFetchAsset;
	}
});

test("staged assets reject hash and per-asset signature failures", async () => {
	const directory = await fs.mkdtemp(
		path.join(os.tmpdir(), "wa2dc-update-hash-"),
	);
	const filePath = path.join(directory, "WA2DC-test");
	const originalPublicKey = utils.updater.publicKey;
	const originalFetchAsset = utils.updater.fetchReleaseAsset;
	const { publicKey } = crypto.generateKeyPairSync("rsa", {
		modulusLength: 2048,
		publicKeyEncoding: { type: "spki", format: "pem" },
		privateKeyEncoding: { type: "pkcs8", format: "pem" },
	});
	try {
		await fs.writeFile(filePath, "verified payload");
		const descriptor = {
			name: "WA2DC-test",
			size: 16,
			sha256: "0".repeat(64),
			signature: "WA2DC-test.sig",
		};
		await assert.rejects(
			utils.updater.validateStagedAsset(filePath, descriptor, "v2.5.0"),
			/release_asset_hash_mismatch/u,
		);

		descriptor.sha256 = await sha256File(filePath);
		utils.updater.publicKey = publicKey;
		utils.updater.fetchReleaseAsset = async () => ({
			result: Buffer.from("invalid signature"),
		});
		await assert.rejects(
			utils.updater.validateStagedAsset(filePath, descriptor, "v2.5.0"),
			/release_asset_signature_invalid/u,
		);
	} finally {
		utils.updater.publicKey = originalPublicKey;
		utils.updater.fetchReleaseAsset = originalFetchAsset;
		await fs.rm(directory, { recursive: true, force: true });
	}
});
