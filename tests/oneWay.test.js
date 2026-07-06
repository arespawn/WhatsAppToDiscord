import assert from "node:assert/strict";
import test from "node:test";

import {
	ONE_WAY_MODES,
	oneWayAllowsDiscordToWhatsApp,
	oneWayAllowsWhatsAppToDiscord,
} from "../src/oneWay.js";

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
