import assert from "node:assert/strict";
import test from "node:test";

import { sentMessages, settings } from "../src/state.js";

test("Default settings include DownloadDir", () => {
	assert.equal(settings.DownloadDir, "./downloads");
	assert.equal(settings.DiscordEmbedsToWhatsApp, false);
	assert.equal(settings.redirectAnnouncementWebhooks, false);
	assert.equal(settings.WhatsAppDiscordMediaBurstSize, 10);
	assert.equal(settings.DefaultChatType, "channel");
	assert.equal(settings.ThreadNotificationsEnabled, false);
	assert.deepEqual(settings.ThreadNotificationRoles, []);
	assert.deepEqual(settings.ThreadNotificationUsers, []);
});

test("sentMessages starts empty", () => {
	assert.deepEqual(Array.from(sentMessages), []);
});
