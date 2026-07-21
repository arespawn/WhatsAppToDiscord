import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import state from "../src/state.js";
import utils from "../src/utils.js";

const snapshotSettings = (keys) =>
	Object.fromEntries(keys.map((key) => [key, state.settings[key]]));
const restoreSettings = (snapshot) => {
	Object.entries(snapshot).forEach(([key, value]) => {
		state.settings[key] = value;
	});
};

const createLogger = () => {
	const calls = [];
	return {
		calls,
		warn(payload, message) {
			calls.push({ payload, message });
		},
	};
};

test("Link preview blocks localhost/private IPs and credentialed URLs", async () => {
	const originalFetch = global.fetch;
	let fetchCalls = 0;
	global.fetch = async () => {
		fetchCalls += 1;
		throw new Error("fetch should not be called for blocked URLs");
	};

	try {
		const logger = createLogger();

		const blockedIp = await utils.discord.generateLinkPreview(
			"http://127.0.0.1/test",
			{ logger },
		);
		assert.equal(blockedIp, undefined);

		const blockedHost = await utils.whatsapp.generateLinkPreview(
			"http://localhost/test",
			{ logger },
		);
		assert.equal(blockedHost, undefined);

		const blockedCreds = await utils.discord.generateLinkPreview(
			"https://user:pass@example.com/",
			{ logger },
		);
		assert.equal(blockedCreds, undefined);

		assert.equal(fetchCalls, 0);
	} finally {
		global.fetch = originalFetch;
	}
});

test("Link preview blocks redirects to a different host (e.g., private)", async () => {
	const originalFetch = global.fetch;
	const logger = createLogger();
	let fetchCalls = 0;
	let response;

	global.fetch = async () => {
		fetchCalls += 1;
		response = new Response("redirect body", {
			status: 302,
			headers: {
				location: "http://127.0.0.1/private",
			},
		});
		return response;
	};

	try {
		const result = await utils.discord.generateLinkPreview(
			"https://example.com/redirect",
			{ logger },
		);
		assert.equal(result, undefined);
		assert.equal(fetchCalls, 1);
		assert.equal(response.bodyUsed, true);
		assert.ok(logger.calls.length >= 1);
		assert.match(
			logger.calls[0].payload?.err?.message || "",
			/Redirect blocked/,
		);
	} finally {
		global.fetch = originalFetch;
	}
});

test("Link preview enforces a maximum response size", async () => {
	const originalFetch = global.fetch;
	const logger = createLogger();
	let fetchCalls = 0;
	let response;

	global.fetch = async () => {
		fetchCalls += 1;
		response = new Response("oversized body", {
			status: 200,
			headers: {
				"content-length": String(1024 * 1024 + 1),
				"content-type": "text/html",
			},
		});
		return response;
	};

	try {
		const result = await utils.discord.generateLinkPreview(
			"https://example.com/too-large",
			{ logger },
		);
		assert.equal(result, undefined);
		assert.equal(fetchCalls, 1);
		assert.equal(response.bodyUsed, true);
		assert.ok(logger.calls.length >= 1);
		assert.equal(logger.calls[0].payload?.err?.code, "WA2DC_PREVIEW_TOO_LARGE");
	} finally {
		global.fetch = originalFetch;
	}
});

test("Link preview discards unused error and non-text response bodies", async () => {
	const originalFetch = global.fetch;
	const logger = createLogger();
	const errorResponse = new Response("server error", { status: 503 });
	const nonTextResponse = new Response("binary body", {
		status: 200,
		headers: { "content-type": "application/octet-stream" },
	});
	const responses = [errorResponse, nonTextResponse];
	global.fetch = async () => responses.shift();

	try {
		assert.equal(
			await utils.discord.generateLinkPreview("https://example.com/error", {
				logger,
			}),
			undefined,
		);
		assert.equal(responses.length, 1);
		const nonTextResult = await utils.discord.generateLinkPreview(
			"https://example.com/binary",
			{
				logger,
			},
		);

		assert.equal(responses.length, 0);
		assert.equal(
			nonTextResult?.["canonical-url"],
			"https://example.com/binary",
		);
		assert.equal(errorResponse.bodyUsed, true);
		assert.equal(nonTextResponse.bodyUsed, true);
	} finally {
		global.fetch = originalFetch;
	}
});

test("A failed link preview does not disable later previews", async () => {
	const originalFetch = global.fetch;
	const logger = createLogger();
	let fetchCalls = 0;
	global.fetch = async () => {
		fetchCalls += 1;
		if (fetchCalls === 1) {
			const socketError = new Error("other side closed");
			socketError.code = "UND_ERR_SOCKET";
			throw new TypeError("terminated", { cause: socketError });
		}
		return new Response(
			"<html><head><title>Working preview</title></head></html>",
			{ headers: { "content-type": "text/html" } },
		);
	};

	try {
		const failed = await utils.discord.generateLinkPreview(
			"https://example.com/first",
			{ logger },
		);
		const recovered = await utils.discord.generateLinkPreview(
			"https://example.com/second",
			{ logger },
		);

		assert.equal(failed, undefined);
		assert.equal(recovered?.title, "Working preview");
		assert.equal(fetchCalls, 2);
	} finally {
		global.fetch = originalFetch;
	}
});

test("An interrupted link preview body fails locally", async () => {
	const originalFetch = global.fetch;
	const logger = createLogger();
	const socketError = new Error("other side closed");
	socketError.code = "UND_ERR_SOCKET";
	const terminated = new TypeError("terminated", { cause: socketError });
	global.fetch = async () =>
		new Response(
			new ReadableStream({
				pull(controller) {
					controller.error(terminated);
				},
			}),
			{ headers: { "content-type": "text/html" } },
		);

	try {
		const result = await utils.discord.generateLinkPreview(
			"https://example.com/interrupted",
			{ logger },
		);

		assert.equal(result, undefined);
		assert.equal(logger.calls[0]?.payload?.err, terminated);
	} finally {
		global.fetch = originalFetch;
	}
});

test("Local download server only serves known tokens", async (t) => {
	const originalFetch = global.fetch;
	const settingsSnapshot = snapshotSettings([
		"DownloadDir",
		"LocalDownloadServer",
		"LocalDownloadServerHost",
		"LocalDownloadServerBindHost",
		"LocalDownloadServerPort",
		"LocalDownloadServerSecret",
		"LocalDownloadLinkTTLSeconds",
		"LocalDownloadMessage",
		"UseHttps",
		"HttpsKeyPath",
		"HttpsCertPath",
	]);

	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "wa2dc-download-"));

	try {
		utils.stopDownloadServer();

		state.settings.DownloadDir = tempDir;
		state.settings.LocalDownloadServer = true;
		state.settings.LocalDownloadServerHost = "127.0.0.1";
		state.settings.LocalDownloadServerBindHost = "127.0.0.1";
		state.settings.LocalDownloadServerPort = 0;
		state.settings.LocalDownloadServerSecret = Buffer.from(
			"wa2dc-test-secret",
			"utf8",
		).toString("base64url");
		state.settings.LocalDownloadLinkTTLSeconds = 0;
		state.settings.LocalDownloadMessage = "{url}";
		state.settings.UseHttps = false;
		state.settings.HttpsKeyPath = "";
		state.settings.HttpsCertPath = "";

		const urlText = await utils.discord.downloadLargeFile({
			name: "hello.txt",
			attachment: Buffer.from("hello"),
		});

		const server = utils.ensureDownloadServer.server;
		if (!server) {
			t.skip("Download server could not be started in this environment.");
			return;
		}

		if (!server.listening) {
			const timeoutMs = 5_000;
			const timeout = new Promise((_, reject) => {
				setTimeout(
					() =>
						reject(
							new Error(
								`Timed out waiting for download server to listen (${timeoutMs}ms)`,
							),
						),
					timeoutMs,
				);
			});

			try {
				await Promise.race([
					once(server, "listening"),
					once(server, "error").then(([err]) => {
						throw err;
					}),
					timeout,
				]);
			} catch (err) {
				if (err?.code === "EPERM" || err?.code === "EACCES") {
					t.skip(
						`Download server listen not permitted in this environment (${err.code}).`,
					);
					return;
				}
				throw err;
			}
		}
		const port = server.address().port;

		const parsed = new URL(urlText);
		const [, token, fileNameEncoded] = parsed.pathname.split("/");
		const fileName = decodeURIComponent(fileNameEncoded || "hello.txt");

		const badResponse = await originalFetch(
			`http://127.0.0.1:${port}/not-a-token/${encodeURIComponent(fileName)}`,
		);
		assert.equal(badResponse.status, 404);
		assert.equal(await badResponse.text(), "Not found");

		const goodResponse = await originalFetch(
			`http://127.0.0.1:${port}/${token}/${encodeURIComponent(fileName)}`,
		);
		assert.equal(goodResponse.status, 200);
		assert.equal(await goodResponse.text(), "hello");
	} finally {
		utils.stopDownloadServer();
		restoreSettings(settingsSnapshot);
		await fs.rm(tempDir, { recursive: true, force: true });
		global.fetch = originalFetch;
	}
});

test("Local download server supports HTTP range requests", async (t) => {
	const originalFetch = global.fetch;
	const settingsSnapshot = snapshotSettings([
		"DownloadDir",
		"LocalDownloadServer",
		"LocalDownloadServerHost",
		"LocalDownloadServerBindHost",
		"LocalDownloadServerPort",
		"LocalDownloadServerSecret",
		"LocalDownloadLinkTTLSeconds",
		"LocalDownloadMessage",
		"UseHttps",
		"HttpsKeyPath",
		"HttpsCertPath",
	]);

	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "wa2dc-download-range-"),
	);

	try {
		utils.stopDownloadServer();

		state.settings.DownloadDir = tempDir;
		state.settings.LocalDownloadServer = true;
		state.settings.LocalDownloadServerHost = "127.0.0.1";
		state.settings.LocalDownloadServerBindHost = "127.0.0.1";
		state.settings.LocalDownloadServerPort = 0;
		state.settings.LocalDownloadServerSecret = Buffer.from(
			"wa2dc-test-secret",
			"utf8",
		).toString("base64url");
		state.settings.LocalDownloadLinkTTLSeconds = 0;
		state.settings.LocalDownloadMessage = "{url}";
		state.settings.UseHttps = false;
		state.settings.HttpsKeyPath = "";
		state.settings.HttpsCertPath = "";

		const urlText = await utils.discord.downloadLargeFile({
			name: "hello.txt",
			attachment: Buffer.from("hello"),
		});

		const server = utils.ensureDownloadServer.server;
		if (!server) {
			t.skip("Download server could not be started in this environment.");
			return;
		}

		if (!server.listening) {
			const timeoutMs = 5_000;
			const timeout = new Promise((_, reject) => {
				setTimeout(
					() =>
						reject(
							new Error(
								`Timed out waiting for download server to listen (${timeoutMs}ms)`,
							),
						),
					timeoutMs,
				);
			});

			try {
				await Promise.race([
					once(server, "listening"),
					once(server, "error").then(([err]) => {
						throw err;
					}),
					timeout,
				]);
			} catch (err) {
				if (err?.code === "EPERM" || err?.code === "EACCES") {
					t.skip(
						`Download server listen not permitted in this environment (${err.code}).`,
					);
					return;
				}
				throw err;
			}
		}
		const port = server.address().port;

		const parsed = new URL(urlText);
		const [, token, fileNameEncoded] = parsed.pathname.split("/");
		const fileName = decodeURIComponent(fileNameEncoded || "hello.txt");

		const partialResponse = await originalFetch(
			`http://127.0.0.1:${port}/${token}/${encodeURIComponent(fileName)}`,
			{
				headers: {
					Range: "bytes=0-1",
				},
			},
		);
		assert.equal(partialResponse.status, 206);
		assert.match(
			partialResponse.headers.get("content-range") || "",
			/bytes 0-1\/\d+/,
		);
		assert.equal(await partialResponse.text(), "he");
	} finally {
		utils.stopDownloadServer();
		restoreSettings(settingsSnapshot);
		await fs.rm(tempDir, { recursive: true, force: true });
		global.fetch = originalFetch;
	}
});
