import assert from "node:assert/strict";
import test from "node:test";

import { Browsers, proto } from "@whiskeysockets/baileys";
import { generateLoginNode } from "@whiskeysockets/baileys/lib/Utils/validate-connection.js";

test("Baileys rc10 carries WA2DC Android browser patch", () => {
	assert.equal(typeof Browsers.android, "function");
	assert.deepEqual(Browsers.android("13"), ["13", "Android", ""]);

	const payload = generateLoginNode("12345:1@s.whatsapp.net", {
		browser: Browsers.android("13"),
		countryCode: "US",
		version: [2, 3000, 0],
	});
	const userAgent = proto.ClientPayload.toObject(payload).userAgent;

	assert.equal(
		userAgent.platform,
		proto.ClientPayload.UserAgent.Platform.ANDROID,
	);
});
