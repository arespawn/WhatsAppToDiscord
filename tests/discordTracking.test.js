import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
	resetClientFactoryOverrides,
	setClientFactoryOverrides,
} from "../src/clientFactories.js";
import state from "../src/state.js";
import utils from "../src/utils.js";

test("read tracking suppresses delayed duplicate receipts and releases deleted-message state without forwarding deletes", async (t) => {
	const snapshot = { ...state };
	const client = new EventEmitter();
	client.user = { id: "bot" };
	setClientFactoryOverrides({ createDiscordClient: () => client });
	t.after(() => {
		Object.assign(state, snapshot);
		resetClientFactoryOverrides();
	});
	state.settings = {
		...state.settings,
		ReadReceipts: true,
		ReadReceiptMode: "reaction",
		DeleteMessages: false,
	};
	state.lastMessages = { wa: "dc", dc: "wa" };
	state.chats = { "test@g.us": { channelId: "channel" } };
	state.reactions = { dc: { "test@s.whatsapp.net": "👍" } };
	state.dcClient = client;
	let receipts = 0;
	let forwards = 0;
	state.waClient = {
		ev: {
			emit() {
				forwards += 1;
			},
		},
	};
	t.mock.method(utils.discord, "channelIdToJid", () => "test@g.us");
	t.mock.method(utils.discord, "getChannel", async () => ({
		messages: {
			fetch: async () => ({
				react: async () => {
					receipts += 1;
				},
			}),
		},
	}));
	await import(`../src/discordHandler.js?test=tracking-cleanup`);
	const onRead = client.listeners("whatsappRead")[0];
	await onRead({ id: "wa", jid: "test@g.us" });
	t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
	t.mock.timers.tick(100 * 86400000);
	await onRead({ id: "wa", jid: "test@g.us" });
	assert.equal(receipts, 1);
	await client.listeners("messageDelete")[0]({
		id: "dc",
		channelId: "channel",
	});
	assert.equal(state.reactions.dc, undefined);
	assert.equal(forwards, 0);
	await onRead({ id: "wa", jid: "test@g.us" });
	assert.equal(receipts, 2);
});
