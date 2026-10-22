import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	applyTlsTrustFilter,
	filterTrustedCACertificates,
} from "../src/tlsTrust.js";
import compromised from "./fixtures/emudhra-trust-certificates.json" with {
	type: "json",
};

const allowed = await fs.readFile(
	new URL("./fixtures/synthetic-tls-ca.pem", import.meta.url),
	"utf8",
);
const allowedFingerprint = new X509Certificate(allowed).fingerprint256;

test("distrusts all published affected roots and both cross-signed forms of eight intermediates", () => {
	assert.equal(compromised.length, 20);
	assert.equal(new Set(compromised.map((entry) => entry.spkiSha256)).size, 12);
	assert.deepEqual(
		filterTrustedCACertificates([
			...compromised.map((entry) => entry.pem),
			allowed,
		]),
		[allowed],
	);
});

test("replaces the default trust store and preserves unrelated configured CAs", () => {
	let installed;
	assert.deepEqual(
		applyTlsTrustFilter({
			getCACertificates: (type) => {
				assert.equal(type, "default");
				return [allowed, ...compromised.map((entry) => entry.pem)];
			},
			setDefaultCACertificates: (certificates) => {
				installed = certificates;
			},
		}),
		{ removed: 20, trusted: 1 },
	);
	assert.deepEqual(installed, [allowed]);
});

test("missing APIs, unenumerable trust, and malformed CAs stop initialization", () => {
	const setDefaultCACertificates = () =>
		assert.fail("must not change trust on failure");
	assert.throws(
		() =>
			applyTlsTrustFilter({
				getCACertificates: null,
				setDefaultCACertificates,
			}),
		/supported Node/u,
	);
	for (const certificates of [
		[],
		[compromised[0].pem],
		["invalid certificate"],
	]) {
		assert.throws(() =>
			applyTlsTrustFilter({
				getCACertificates: () => certificates,
				setDefaultCACertificates,
			}),
		);
	}
});

test("startup filters actual NODE_EXTRA_CA_CERTS without discarding a safe additional root", async () => {
	const temporary = await fs.mkdtemp(
		path.join(os.tmpdir(), "wa2dc-tls-trust-"),
	);
	try {
		const extra = path.join(temporary, "extra.pem");
		await fs.writeFile(
			extra,
			[...compromised.map((entry) => entry.pem), allowed].join("\n"),
		);
		const bootstrap = new URL("../src/loadTlsTrust.js", import.meta.url).href;
		const result = spawnSync(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`
			import assert from 'node:assert/strict';
			import tls from 'node:tls';
			import { X509Certificate } from 'node:crypto';
			const before = tls.getCACertificates('default');
			await import(${JSON.stringify(bootstrap)});
			const after = tls.getCACertificates('default');
			const { filterTrustedCACertificates } = await import(${JSON.stringify(new URL("../src/tlsTrust.js", import.meta.url).href)});
			assert.deepEqual(filterTrustedCACertificates(after), after);
			assert.ok(after.some(pem => new X509Certificate(pem).fingerprint256 === ${JSON.stringify(allowedFingerprint)}));
			assert.ok(after.length < before.length);
		`,
			],
			{
				cwd: temporary,
				env: { ...process.env, NODE_EXTRA_CA_CERTS: extra },
				encoding: "utf8",
				timeout: 10_000,
			},
		);
		assert.equal(result.status, 0, result.stderr || result.error?.message);
	} finally {
		await fs.rm(temporary, { recursive: true, force: true });
	}
});

test("both executable entry points load trust filtering before runtime dependencies", async () => {
	for (const entry of ["runner.js", "index.js"]) {
		const source = await fs.readFile(
			fileURLToPath(new URL(`../src/${entry}`, import.meta.url)),
			"utf8",
		);
		assert.ok(source.startsWith('import "./loadTlsTrust.js";\n'), entry);
	}
});
