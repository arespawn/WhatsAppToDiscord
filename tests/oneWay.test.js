import assert from "node:assert/strict";
import test from "node:test";

import {
	normalizeSettings,
	ONE_WAY_MODES,
	oneWayAllowsDiscordToWhatsApp,
	oneWayAllowsWhatsAppToDiscord,
} from "../src/contracts.js";

test("oneWay mode presets use canonical string values", () => {
	assert.equal(ONE_WAY_MODES.TO_DISCORD_ONLY, "to-discord");
	assert.equal(ONE_WAY_MODES.TO_WHATSAPP_ONLY, "to-whatsapp");
	assert.equal(ONE_WAY_MODES.TWO_WAY, "bidirectional");
});

test("oneWay direction helpers gate flows correctly", () => {
	assert.equal(
		oneWayAllowsWhatsAppToDiscord(ONE_WAY_MODES.TO_DISCORD_ONLY),
		true,
	);
	assert.equal(
		oneWayAllowsDiscordToWhatsApp(ONE_WAY_MODES.TO_DISCORD_ONLY),
		false,
	);

	assert.equal(
		oneWayAllowsDiscordToWhatsApp(ONE_WAY_MODES.TO_WHATSAPP_ONLY),
		true,
	);
	assert.equal(
		oneWayAllowsWhatsAppToDiscord(ONE_WAY_MODES.TO_WHATSAPP_ONLY),
		false,
	);

	assert.equal(oneWayAllowsDiscordToWhatsApp(ONE_WAY_MODES.TWO_WAY), true);
	assert.equal(oneWayAllowsWhatsAppToDiscord(ONE_WAY_MODES.TWO_WAY), true);
});

test("invalid oneWay values normalize to bidirectional", () => {
	assert.equal(oneWayAllowsDiscordToWhatsApp(undefined), true);
	assert.equal(oneWayAllowsWhatsAppToDiscord("invalid"), true);
});

test("legacy numeric oneWay values normalize to string modes", () => {
	assert.equal(normalizeSettings({ oneWay: 1 }).oneWay, "to-discord");
	assert.equal(normalizeSettings({ oneWay: "1" }).oneWay, "to-discord");
	assert.equal(normalizeSettings({ oneWay: 2 }).oneWay, "to-whatsapp");
	assert.equal(normalizeSettings({ oneWay: "2" }).oneWay, "to-whatsapp");
	assert.equal(normalizeSettings({ oneWay: 3 }).oneWay, "bidirectional");
	assert.equal(normalizeSettings({ oneWay: "3" }).oneWay, "bidirectional");
});
