import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import test from "node:test";

import {
	createDiscordRestOptions,
	createDiscordWebhookClient,
	makeDiscordRestRequest,
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
		assert.equal(capturedOptions?.rest?.makeRequest, makeDiscordRestRequest);
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
		assert.equal(capturedOptions?.rest?.makeRequest, makeDiscordRestRequest);
	} finally {
		restoreObject(state.chats, originalChats);
		restoreObject(state.goccRuns, originalRuns);
		resetClientFactoryOverrides();
	}
});

test("a stored webhook sends a ten-file multipart body after newer Undici loads", async (t) => {
	let resolveObserved;
	let rejectObserved;
	const observed = new Promise((resolve, reject) => {
		resolveObserved = resolve;
		rejectObserved = reject;
	});
	const server = http.createServer((request, response) => {
		const chunks = [];
		request.on("data", (chunk) => chunks.push(chunk));
		request.on("aborted", () =>
			rejectObserved(new Error("multipart request was aborted")),
		);
		request.on("error", rejectObserved);
		request.on("end", () => {
			resolveObserved({
				body: Buffer.concat(chunks),
				contentType: request.headers["content-type"],
				url: request.url,
			});
			response.writeHead(200, { "content-type": "application/json" });
			response.end("{}");
		});
	});

	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	t.after(
		() =>
			new Promise((resolve) => {
				server.closeAllConnections();
				server.close(resolve);
			}),
	);

	const address = server.address();
	assert.equal(typeof address, "object");
	const webhook = createDiscordWebhookClient(
		{ id: "123456789012345678", token: "test-token" },
		{
			rest: {
				...createDiscordRestOptions(),
				api: `http://127.0.0.1:${address.port}`,
				retries: 0,
				timeout: 2_000,
				version: "10",
			},
		},
	);
	await webhook.send({
		content: "multipart regression probe",
		files: Array.from({ length: 10 }, (_, index) => ({
			attachment: Buffer.alloc(130_000 + index, index),
			name: "imageMessage.jpeg",
		})),
	});

	const result = await observed;
	assert.match(result.contentType, /^multipart\/form-data; boundary=/u);
	assert.match(result.url, /^\/v10\/webhooks\//u);
	assert.equal(result.body.length > 1_300_000, true);
	assert.equal(
		[...result.body.toString("latin1").matchAll(/name="files\[\d+\]"/gu)]
			.length,
		10,
	);
});
