import assert from "node:assert/strict";
import test from "node:test";

import {
	getNewsletterAckError,
	getNewsletterMessageDebug,
	getPendingNewsletterSend,
	noteNewsletterAckError,
	noteNewsletterMessageDebug,
	notePendingNewsletterSend,
	resetNewsletterBridgeState,
} from "../src/newsletterBridge.js";

test("newsletter TTL cleanup releases inactive keys without reading them again", (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10000 });
	const maps = new Map();
	const originalSet = Map.prototype.set;
	t.mock.method(Map.prototype, "set", function (key, value) {
		if (typeof key === "string" && key.startsWith("cleanup-")) {
			originalSet.call(maps, key, this);
		}
		return originalSet.call(this, key, value);
	});
	t.after(resetNewsletterBridgeState);
	noteNewsletterAckError({ messageId: "cleanup-ack", errorCode: "403" });
	notePendingNewsletterSend({
		jid: "cleanup-jid",
		discordMessageId: "message",
	});
	noteNewsletterMessageDebug({
		discordMessageId: "cleanup-debug",
		phase: "sent",
	});
	assert.equal(maps.size, 3);
	t.mock.timers.tick(30001);
	assert.equal(maps.get("cleanup-ack").has("cleanup-ack"), false);
	assert.equal(maps.get("cleanup-jid").has("cleanup-jid"), true);
	t.mock.timers.tick(120000);
	assert.equal(maps.get("cleanup-jid").has("cleanup-jid"), false);
	assert.equal(maps.get("cleanup-debug").has("cleanup-debug"), true);
	t.mock.timers.tick(30 * 60 * 1000);
	assert.equal(maps.get("cleanup-debug").has("cleanup-debug"), false);
});

test("newsletter cleanup retains refreshed entries and reset cancels stale maintenance", (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10000 });
	t.after(resetNewsletterBridgeState);
	noteNewsletterMessageDebug({ discordMessageId: "debug", phase: "first" });
	t.mock.timers.tick(29 * 60 * 1000);
	noteNewsletterMessageDebug({ discordMessageId: "debug", phase: "second" });
	t.mock.timers.tick(2 * 60 * 1000);
	assert.deepEqual(
		getNewsletterMessageDebug({ discordMessageId: "debug" }).map(
			(entry) => entry.phase,
		),
		["second"],
	);
	resetNewsletterBridgeState();
	noteNewsletterAckError({ messageId: "ack", errorCode: "500" });
	notePendingNewsletterSend({ jid: "jid", discordMessageId: "pending" });
	assert.equal(getNewsletterAckError("ack"), "500");
	assert.equal(
		getPendingNewsletterSend({ jid: "jid", discordMessageId: "pending" })
			.discordMessageId,
		"pending",
	);
	resetNewsletterBridgeState();
	t.mock.timers.tick(31 * 60 * 1000);
	assert.equal(getNewsletterAckError("ack"), null);
	assert.equal(getPendingNewsletterSend({ jid: "jid" }), null);
	assert.deepEqual(
		getNewsletterMessageDebug({ discordMessageId: "debug" }),
		[],
	);
});
