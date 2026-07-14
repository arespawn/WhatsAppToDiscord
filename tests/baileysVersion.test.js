import assert from "node:assert/strict";
import test from "node:test";

import { getBaileysVersion } from "../src/clientFactories.js";

test("WhatsApp connections prefer the live WhatsApp Web revision", async () => {
	const originalFetch = global.fetch;
	const requestedUrls = [];
	global.fetch = async (url) => {
		requestedUrls.push(String(url));
		return new Response('{"client_revision": 1043117381}', { status: 200 });
	};

	try {
		const result = await getBaileysVersion();
		assert.deepEqual(result, {
			version: [2, 3000, 1043117381],
			isLatest: true,
		});
		assert.deepEqual(requestedUrls, ["https://web.whatsapp.com/sw.js"]);
	} finally {
		global.fetch = originalFetch;
	}
});

test("WhatsApp version lookup falls back to the Baileys revision", async () => {
	const originalFetch = global.fetch;
	const requestedUrls = [];
	global.fetch = async (url) => {
		const requestedUrl = String(url);
		requestedUrls.push(requestedUrl);
		if (requestedUrl === "https://web.whatsapp.com/sw.js") {
			return new Response("unavailable", { status: 503 });
		}
		return new Response(
			[
				"import { proto } from '../../WAProto/index.js'",
				"import { makeLibSignalRepository } from '../Signal/libsignal'",
				"import type { AuthenticationState } from '../Types'",
				"import { Browsers } from '../Utils/browser-utils'",
				"import logger from '../Utils/logger'",
				"",
				"const version = [2, 3000, 1035194821]",
			].join("\n"),
			{ status: 200 },
		);
	};

	try {
		const result = await getBaileysVersion();
		assert.deepEqual(result, {
			version: [2, 3000, 1035194821],
			isLatest: true,
		});
		assert.deepEqual(requestedUrls, [
			"https://web.whatsapp.com/sw.js",
			"https://raw.githubusercontent.com/WhiskeySockets/Baileys/master/src/Defaults/index.ts",
		]);
	} finally {
		global.fetch = originalFetch;
	}
});
