import assert from "node:assert/strict";
import test from "node:test";

import {
	serializeWhatsAppBrowserProfile,
	shouldResetWhatsAppAuthForBrowserProfile,
} from "../src/whatsappHandler.js";

test("registered WhatsApp auth without a browser marker is reset", () => {
	assert.equal(
		shouldResetWhatsAppAuthForBrowserProfile({
			creds: { registered: true },
			storedProfile: [],
			currentProfile: ["13", "Android", ""],
		}),
		true,
	);
});

test("registered WhatsApp auth is kept when browser marker matches", () => {
	assert.equal(
		shouldResetWhatsAppAuthForBrowserProfile({
			creds: { registered: true },
			storedProfile: ["13", "Android", ""],
			currentProfile: ["13", "Android", ""],
		}),
		false,
	);
});

test("fresh WhatsApp auth is not reset for browser marker checks", () => {
	assert.equal(
		shouldResetWhatsAppAuthForBrowserProfile({
			creds: { registered: false },
			storedProfile: [],
			currentProfile: ["13", "Android", ""],
		}),
		false,
	);
});

test("WhatsApp browser profile serialization is stable", () => {
	assert.deepEqual(serializeWhatsAppBrowserProfile(["13", "Android", null]), [
		"13",
		"Android",
		"",
	]);
});
