import assert from "node:assert/strict";
import test from "node:test";

import { Browsers } from "@whiskeysockets/baileys";

import {
	resolveWhatsAppBrowserProfile,
	selectWhatsAppBrowserProfile,
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

test("WhatsApp browser profile override supports pairing-code experiments", () => {
	assert.deepEqual(resolveWhatsAppBrowserProfile("android"), [
		"13",
		"Android",
		"",
	]);
	assert.deepEqual(resolveWhatsAppBrowserProfile("macos-chrome"), [
		"Mac OS",
		"Chrome",
		"14.4.1",
	]);
	assert.deepEqual(resolveWhatsAppBrowserProfile("windows-chrome"), [
		"Windows",
		"Chrome",
		"10.0.22631",
	]);
	assert.throws(
		() => resolveWhatsAppBrowserProfile("unknown"),
		/Unsupported WhatsApp browser profile/,
	);
});

test("WhatsApp Android browser profile requires patched Baileys support", () => {
	const originalAndroid = Browsers.android;
	try {
		Browsers.android = undefined;
		assert.throws(
			() => resolveWhatsAppBrowserProfile("android"),
			/Baileys browser profile is unavailable/,
		);
	} finally {
		Browsers.android = originalAndroid;
	}
});

test("WhatsApp browser profile selection uses Android for fresh QR pairing", () => {
	assert.deepEqual(
		selectWhatsAppBrowserProfile({
			creds: { registered: false },
			storedProfile: [],
			envValue: "",
		}),
		["13", "Android", ""],
	);
});

test("WhatsApp browser profile selection uses pending profile for pairing codes", () => {
	assert.deepEqual(
		selectWhatsAppBrowserProfile({
			creds: { registered: false },
			pairingCodeProfile: "macos-chrome",
			storedProfile: [],
			envValue: "",
		}),
		["Mac OS", "Chrome", "14.4.1"],
	);
});

test("WhatsApp browser profile selection keeps stored registered sessions", () => {
	assert.deepEqual(
		selectWhatsAppBrowserProfile({
			creds: { registered: true },
			storedProfile: ["13", "Android", ""],
			envValue: "",
		}),
		["13", "Android", ""],
	);
});

test("WhatsApp browser profile env override wins over stored sessions", () => {
	assert.deepEqual(
		selectWhatsAppBrowserProfile({
			creds: { registered: true },
			storedProfile: ["13", "Android", ""],
			envValue: "windows-chrome",
		}),
		["Windows", "Chrome", "10.0.22631"],
	);
});

test("WhatsApp browser profile env override supports emergency web fallback", () => {
	assert.deepEqual(
		selectWhatsAppBrowserProfile({
			creds: { registered: true },
			storedProfile: ["13", "Android", ""],
			envValue: "baileys",
		}),
		["Baileys", "Chrome", "6.5.0"],
	);
	assert.deepEqual(
		selectWhatsAppBrowserProfile({
			creds: { registered: true },
			storedProfile: ["13", "Android", ""],
			envValue: "macos-chrome",
		}),
		["Mac OS", "Chrome", "14.4.1"],
	);
});
