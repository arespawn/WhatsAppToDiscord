import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
	resetClientFactoryOverrides,
	setClientFactoryOverrides,
} from "../src/clientFactories.js";
import { DISCORD_REST_REQUEST_TIMEOUT_MS } from "../src/contracts.js";
import state from "../src/state.js";
import utils from "../src/utils.js";

const restoreObject = (target, snapshot) => {
	Object.keys(target).forEach((key) => {
		delete target[key];
	});
	Object.assign(target, snapshot);
};

test("the main Discord client receives the 60-second REST timeout", async () => {
	let capturedOptions;
	class FakeDiscordClient extends EventEmitter {}

	try {
		setClientFactoryOverrides({
			createDiscordClient(options) {
				capturedOptions = options;
				return new FakeDiscordClient();
			},
		});

		await import("../src/discordHandler.js?test=discord-rest-timeout");

		assert.equal(
			capturedOptions?.rest?.timeout,
			DISCORD_REST_REQUEST_TIMEOUT_MS,
		);
		assert.equal(DISCORD_REST_REQUEST_TIMEOUT_MS, 60_000);
	} finally {
		resetClientFactoryOverrides();
	}
});

test("stored standalone webhook clients receive the 60-second REST timeout", async () => {
	const originalChats = { ...state.chats };
	const originalRuns = { ...state.goccRuns };
	let capturedData;
	let capturedOptions;

	try {
		restoreObject(state.chats, {
			"123@s.whatsapp.net": {
				id: "webhook-id",
				token: "private-token",
				type: 1,
				channelId: "channel-id",
			},
		});
		restoreObject(state.goccRuns, {});
		setClientFactoryOverrides({
			createDiscordWebhookClient(data, options) {
				capturedData = data;
				capturedOptions = options;
				return {
					id: data.id,
					token: data.token,
					type: 1,
				};
			},
		});

		const webhook =
			await utils.discord.getOrCreateChannel("123@s.whatsapp.net");

		assert.equal(webhook.id, "webhook-id");
		assert.deepEqual(capturedData, {
			id: "webhook-id",
			token: "private-token",
		});
		assert.equal(
			capturedOptions?.rest?.timeout,
			DISCORD_REST_REQUEST_TIMEOUT_MS,
		);
	} finally {
		restoreObject(state.chats, originalChats);
		restoreObject(state.goccRuns, originalRuns);
		resetClientFactoryOverrides();
	}
});
