import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import discordJs from "discord.js";

import {
	resetClientFactoryOverrides,
	setClientFactoryOverrides,
} from "../src/clientFactories.js";
import { cleanupActiveWhatsAppDiscordMediaStaging } from "../src/internal/whatsappDiscordMediaStaging.js";
import state from "../src/state.js";
import utils from "../src/utils.js";

const waitFor = async (predicate, timeoutMs = 3000) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await delay(5);
	}
	return predicate();
};

const lazyImage = (index) => ({
	name: `image-${index}.jpg`,
	downloadCtx: { index },
	declaredSize: 200_000,
	msgType: "imageMessage",
	spoiler: false,
	wa2dcLazyWhatsAppMedia: true,
});

const incomingMessage = ({ id, file = null, content = "" }) => ({
	id,
	name: "Synthetic sender",
	content,
	channelJid: "123@s.whatsapp.net",
	file,
	quote: null,
	profilePic: null,
	isGroup: false,
	isForwarded: false,
	isEdit: false,
});

test("a ten-image album and surrounding text map without waiting for announcement crossposts", async () => {
	const temporaryParent = await fs.promises.mkdtemp(
		path.join(os.tmpdir(), "wa2dc-album-bridge-test-"),
	);
	const originalDiscordUtils = {
		getGuild: utils.discord.getGuild,
		getControlChannel: utils.discord.getControlChannel,
		getOrCreateChannel: utils.discord.getOrCreateChannel,
		safeWebhookSend: utils.discord.safeWebhookSend,
	};
	const originalSettings = {
		Token: state.settings.Token,
		GuildID: state.settings.GuildID,
		oneWay: state.settings.oneWay,
		DiscordFileSizeLimit: state.settings.DiscordFileSizeLimit,
		Publish: state.settings.Publish,
		WhatsAppDiscordMediaBurstSize: state.settings.WhatsAppDiscordMediaBurstSize,
	};
	const originalLastMessages = state.lastMessages;
	const originalDcClient = state.dcClient;
	const sent = [];
	let downloadCalls = 0;
	const pendingCrossposts = [];

	try {
		state.settings.Token = "TEST_TOKEN";
		state.settings.GuildID = "guild";
		state.settings.oneWay = "bidirectional";
		state.settings.DiscordFileSizeLimit = 8 * 1024 * 1024;
		state.settings.Publish = true;
		state.settings.WhatsAppDiscordMediaBurstSize = 10;
		state.lastMessages = {};

		const webhook = {
			async send(args) {
				const files = Array.isArray(args.files) ? args.files : [];
				for (const file of files) {
					assert.equal(
						(await fs.promises.readFile(file.attachment)).length,
						200_000,
					);
				}
				const message = {
					id: `dc-${sent.length + 1}`,
					channel: { type: discordJs.ChannelType.GuildAnnouncement },
					crosspost() {
						return new Promise((resolve) => pendingCrossposts.push(resolve));
					},
				};
				sent.push({
					content: args.content,
					fileCount: files.length,
					message,
				});
				return message;
			},
		};

		utils.discord.getGuild = async () => ({
			commands: { set: async () => {} },
		});
		utils.discord.getControlChannel = async () => ({ send: async () => {} });
		utils.discord.getOrCreateChannel = async () => webhook;
		utils.discord.safeWebhookSend = function safeWebhookSendWithSyntheticMedia(
			webhookClient,
			args,
			jid,
		) {
			return originalDiscordUtils.safeWebhookSend.call(
				utils.discord,
				webhookClient,
				args,
				jid,
				{
					temporaryDirectory: temporaryParent,
					downloadWhatsAppMedia(file) {
						downloadCalls += 1;
						return Readable.from([
							Buffer.alloc(file.declaredSize, file.downloadCtx.index),
						]);
					},
				},
			);
		};

		class FakeDiscordClient extends EventEmitter {
			constructor() {
				super();
				this.user = { id: "bot-1" };
			}

			async login() {
				queueMicrotask(() => this.emit("ready"));
				return this;
			}
		}

		const fakeClient = new FakeDiscordClient();
		setClientFactoryOverrides({ createDiscordClient: () => fakeClient });
		const discordHandler = (
			await import("../src/discordHandler.js?test=ten-image-staged-album")
		).default;
		state.dcClient = await discordHandler.start();

		fakeClient.emit(
			"whatsappMessage",
			incomingMessage({ id: "wa-before", content: "before album" }),
		);
		assert.equal(
			await waitFor(() => state.lastMessages["wa-before"] === "dc-1"),
			true,
		);

		for (let index = 1; index <= 10; index += 1) {
			fakeClient.emit(
				"whatsappMessage",
				incomingMessage({ id: `wa-image-${index}`, file: lazyImage(index) }),
			);
		}
		fakeClient.emit(
			"whatsappMessage",
			incomingMessage({ id: "wa-after", content: "after album" }),
		);

		assert.equal(await waitFor(() => sent.length === 3), true);
		assert.deepEqual(
			sent.map((entry) => entry.fileCount),
			[0, 10, 0],
		);
		assert.equal(downloadCalls, 10);
		assert.equal(state.lastMessages["wa-before"], "dc-1");
		for (let index = 1; index <= 10; index += 1) {
			assert.equal(state.lastMessages[`wa-image-${index}`], "dc-2");
		}
		assert.equal(state.lastMessages["wa-after"], "dc-3");
		assert.equal(state.lastMessages["dc-2"], "wa-image-1");
		assert.equal(pendingCrossposts.length, 3);
	} finally {
		pendingCrossposts.splice(0).forEach((resolve) => {
			resolve();
		});
		utils.discord.getGuild = originalDiscordUtils.getGuild;
		utils.discord.getControlChannel = originalDiscordUtils.getControlChannel;
		utils.discord.getOrCreateChannel = originalDiscordUtils.getOrCreateChannel;
		utils.discord.safeWebhookSend = originalDiscordUtils.safeWebhookSend;

		state.settings.Token = originalSettings.Token;
		state.settings.GuildID = originalSettings.GuildID;
		state.settings.oneWay = originalSettings.oneWay;
		state.settings.DiscordFileSizeLimit = originalSettings.DiscordFileSizeLimit;
		state.settings.Publish = originalSettings.Publish;
		state.settings.WhatsAppDiscordMediaBurstSize =
			originalSettings.WhatsAppDiscordMediaBurstSize;
		state.lastMessages = originalLastMessages;
		state.dcClient = originalDcClient;
		resetClientFactoryOverrides();
		await cleanupActiveWhatsAppDiscordMediaStaging();
		await fs.promises.rm(temporaryParent, { recursive: true, force: true });
	}
});
