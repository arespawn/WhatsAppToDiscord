import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import discordJs from "discord.js";
import {
	resetClientFactoryOverrides,
	setClientFactoryOverrides,
} from "../src/clientFactories.js";
import {
	clearPendingNewsletterSends,
	noteNewsletterAckError,
	noteNewsletterMessageDebug,
	notePendingNewsletterSend,
} from "../src/newsletterBridge.js";
import state from "../src/state.js";
import storage from "../src/storage.js";
import utils from "../src/utils.js";
import initIsolatedStorage from "./helpers/initIsolatedStorage.js";

await initIsolatedStorage(import.meta.url);

const { ApplicationCommandOptionType } = discordJs;

const importDiscordHandler = async (tag) =>
	(await import(`../src/discordHandler.js?test=${encodeURIComponent(tag)}`))
		.default;

const restoreObject = (target, snapshot) => {
	Object.keys(target).forEach((key) => {
		delete target[key];
	});
	Object.assign(target, snapshot);
};

const waitFor = async (
	predicate,
	{ timeoutMs = 3000, intervalMs = 10 } = {},
) => {
	const deadline = Date.now() + timeoutMs;
	while (true) {
		if (predicate()) return true;
		if (Date.now() >= deadline) return false;
		await delay(intervalMs);
	}
};

const createInteraction = ({
	channelId,
	commandName = "checkupdate",
	stringOptions = {},
	booleanOptions = {},
	integerOptions = {},
	numberOptions = {},
	channelOptions = {},
	userOptions = {},
	deferReplyError = null,
}) => {
	const records = {
		deferReply: [],
		editReply: [],
		followUp: [],
		reply: [],
	};
	return {
		channelId,
		channel: { id: channelId },
		commandName,
		options: {
			getString: (name) => (name in stringOptions ? stringOptions[name] : null),
			getBoolean: (name) =>
				name in booleanOptions ? booleanOptions[name] : null,
			getInteger: (name) =>
				name in integerOptions ? integerOptions[name] : null,
			getNumber: (name) => (name in numberOptions ? numberOptions[name] : null),
			getChannel: (name) =>
				name in channelOptions ? channelOptions[name] : null,
			getUser: (name) => (name in userOptions ? userOptions[name] : null),
		},
		isButton: () => false,
		isCommand: () => true,
		isChatInputCommand: () => true,
		async deferReply(payload) {
			records.deferReply.push(payload);
			if (deferReplyError) {
				throw deferReplyError;
			}
		},
		async editReply(payload) {
			records.editReply.push(payload);
			return payload;
		},
		async followUp(payload) {
			records.followUp.push(payload);
			return payload;
		},
		async reply(payload) {
			records.reply.push(payload);
			return payload;
		},
		records,
	};
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

test("interaction defer Unknown interaction is logged and does not escape the listener", async () => {
	const originalDiscordUtils = {
		getGuild: utils.discord.getGuild,
		getControlChannel: utils.discord.getControlChannel,
	};
	const originalSettings = {
		Token: state.settings.Token,
		GuildID: state.settings.GuildID,
		ControlChannelID: state.settings.ControlChannelID,
	};
	const originalDcClient = state.dcClient;
	const originalLogger = state.logger;

	try {
		state.settings.Token = "TEST_TOKEN";
		state.settings.GuildID = "guild";
		state.settings.ControlChannelID = "control";
		const warnings = [];
		const errors = [];
		state.logger = {
			warn(entry, message) {
				warnings.push({ entry, message });
			},
			error(entry, message) {
				errors.push({ entry, message });
			},
		};

		utils.discord.getGuild = async () => ({
			commands: { set: async () => {} },
		});
		utils.discord.getControlChannel = async () => ({ send: async () => {} });

		const fakeClient = new FakeDiscordClient();
		setClientFactoryOverrides({ createDiscordClient: () => fakeClient });
		const discordHandler = await importDiscordHandler(
			"interaction-unknown-interaction-defer",
		);
		state.dcClient = await discordHandler.start();
		await delay(0);

		const interaction = createInteraction({
			channelId: "control",
			commandName: "checkupdate",
			deferReplyError: Object.assign(new Error("Unknown interaction"), {
				code: 10062,
				rawError: { code: 10062 },
			}),
		});
		fakeClient.emit("interactionCreate", interaction);
		await delay(0);

		assert.equal(interaction.records.deferReply.length, 1);
		assert.equal(interaction.records.editReply.length, 0);
		assert.equal(interaction.records.reply.length, 0);
		assert.equal(errors.length, 0);
		assert.equal(warnings.length, 1);
		assert.equal(
			warnings[0]?.message,
			"Discord rejected the interaction callback before WA2DC could acknowledge it",
		);
	} finally {
		utils.discord.getGuild = originalDiscordUtils.getGuild;
		utils.discord.getControlChannel = originalDiscordUtils.getControlChannel;

		state.settings.Token = originalSettings.Token;
		state.settings.GuildID = originalSettings.GuildID;
		state.settings.ControlChannelID = originalSettings.ControlChannelID;
		state.dcClient = originalDcClient;
		state.logger = originalLogger;
		resetClientFactoryOverrides();
	}
});

test("/checkupdate in control channel refreshes persistent prompt without duplicate full update reply", async () => {
	const originalDiscordUtils = {
		getGuild: utils.discord.getGuild,
		getControlChannel: utils.discord.getControlChannel,
		syncUpdatePrompt: utils.discord.syncUpdatePrompt,
		syncRollbackPrompt: utils.discord.syncRollbackPrompt,
	};
	const originalUpdater = {
		run: utils.updater.run,
		formatUpdateMessage: utils.updater.formatUpdateMessage,
	};
	const originalSettings = {
		Token: state.settings.Token,
		GuildID: state.settings.GuildID,
		ControlChannelID: state.settings.ControlChannelID,
	};
	const originalUpdateInfo = state.updateInfo;
	const originalDcClient = state.dcClient;

	try {
		state.settings.Token = "TEST_TOKEN";
		state.settings.GuildID = "guild";
		state.settings.ControlChannelID = "control";
		state.updateInfo = null;

		utils.discord.getGuild = async () => ({
			commands: { set: async () => {} },
		});
		utils.discord.getControlChannel = async () => ({ send: async () => {} });
		const syncCalls = { update: 0, rollback: 0 };
		utils.discord.syncUpdatePrompt = async () => {
			syncCalls.update += 1;
		};
		utils.discord.syncRollbackPrompt = async () => {
			syncCalls.rollback += 1;
		};

		utils.updater.run = async () => {
			state.updateInfo = {
				currVer: "1.0.0",
				version: "1.1.0",
				channel: "stable",
				changes: "Fixes",
				canSelfUpdate: true,
			};
		};
		let formatCallCount = 0;
		utils.updater.formatUpdateMessage = () => {
			formatCallCount += 1;
			return "UPDATE_MESSAGE";
		};

		const fakeClient = new FakeDiscordClient();
		setClientFactoryOverrides({ createDiscordClient: () => fakeClient });
		const discordHandler = await importDiscordHandler("checkupdate-control");
		state.dcClient = await discordHandler.start();
		await delay(0);

		const interaction = createInteraction({
			channelId: "control",
			commandName: "checkupdate",
		});
		fakeClient.emit("interactionCreate", interaction);
		await delay(0);

		assert.equal(syncCalls.update, 1);
		assert.equal(syncCalls.rollback, 1);
		assert.equal(formatCallCount, 0);
		assert.deepEqual(interaction.records.deferReply, [{ ephemeral: false }]);
		assert.equal(interaction.records.editReply.length, 1);
		assert.equal(
			interaction.records.editReply[0]?.content,
			"Update available. The persistent update prompt in this channel has been refreshed.",
		);
		assert.equal(interaction.records.followUp.length, 0);
	} finally {
		utils.discord.getGuild = originalDiscordUtils.getGuild;
		utils.discord.getControlChannel = originalDiscordUtils.getControlChannel;
		utils.discord.syncUpdatePrompt = originalDiscordUtils.syncUpdatePrompt;
		utils.discord.syncRollbackPrompt = originalDiscordUtils.syncRollbackPrompt;
		utils.updater.run = originalUpdater.run;
		utils.updater.formatUpdateMessage = originalUpdater.formatUpdateMessage;

		state.settings.Token = originalSettings.Token;
		state.settings.GuildID = originalSettings.GuildID;
		state.settings.ControlChannelID = originalSettings.ControlChannelID;
		state.updateInfo = originalUpdateInfo;
		state.dcClient = originalDcClient;
		resetClientFactoryOverrides();
	}
});

test("/checkupdate outside control channel still returns full update details", async () => {
	const originalDiscordUtils = {
		getGuild: utils.discord.getGuild,
		getControlChannel: utils.discord.getControlChannel,
		syncUpdatePrompt: utils.discord.syncUpdatePrompt,
		syncRollbackPrompt: utils.discord.syncRollbackPrompt,
	};
	const originalUpdater = {
		run: utils.updater.run,
		formatUpdateMessage: utils.updater.formatUpdateMessage,
	};
	const originalSettings = {
		Token: state.settings.Token,
		GuildID: state.settings.GuildID,
		ControlChannelID: state.settings.ControlChannelID,
	};
	const originalUpdateInfo = state.updateInfo;
	const originalDcClient = state.dcClient;

	try {
		state.settings.Token = "TEST_TOKEN";
		state.settings.GuildID = "guild";
		state.settings.ControlChannelID = "control";
		state.updateInfo = null;

		utils.discord.getGuild = async () => ({
			commands: { set: async () => {} },
		});
		utils.discord.getControlChannel = async () => ({ send: async () => {} });
		utils.discord.syncUpdatePrompt = async () => {};
		utils.discord.syncRollbackPrompt = async () => {};

		utils.updater.run = async () => {
			state.updateInfo = {
				currVer: "1.0.0",
				version: "1.1.0",
				channel: "stable",
				changes: "Fixes",
				canSelfUpdate: true,
			};
		};
		utils.updater.formatUpdateMessage = () => "UPDATE_MESSAGE";

		const fakeClient = new FakeDiscordClient();
		setClientFactoryOverrides({ createDiscordClient: () => fakeClient });
		const discordHandler = await importDiscordHandler(
			"checkupdate-non-control",
		);
		state.dcClient = await discordHandler.start();
		await delay(0);

		const interaction = createInteraction({
			channelId: "not-control",
			commandName: "checkupdate",
		});
		fakeClient.emit("interactionCreate", interaction);
		await delay(0);

		assert.deepEqual(interaction.records.deferReply, [{ ephemeral: true }]);
		assert.equal(interaction.records.editReply.length, 1);
		assert.equal(interaction.records.editReply[0]?.content, "UPDATE_MESSAGE");
		assert.ok(Array.isArray(interaction.records.editReply[0]?.components));
		assert.equal(interaction.records.editReply[0]?.components?.length, 1);
	} finally {
		utils.discord.getGuild = originalDiscordUtils.getGuild;
		utils.discord.getControlChannel = originalDiscordUtils.getControlChannel;
		utils.discord.syncUpdatePrompt = originalDiscordUtils.syncUpdatePrompt;
		utils.discord.syncRollbackPrompt = originalDiscordUtils.syncRollbackPrompt;
		utils.updater.run = originalUpdater.run;
		utils.updater.formatUpdateMessage = originalUpdater.formatUpdateMessage;

		state.settings.Token = originalSettings.Token;
		state.settings.GuildID = originalSettings.GuildID;
		state.settings.ControlChannelID = originalSettings.ControlChannelID;
		state.updateInfo = originalUpdateInfo;
		state.dcClient = originalDcClient;
		resetClientFactoryOverrides();
	}
});

test("/newslettercreate succeeds when create response has null picture metadata", async () => {
	const originalDiscordUtils = {
		getGuild: utils.discord.getGuild,
		getControlChannel: utils.discord.getControlChannel,
		getOrCreateChannel: utils.discord.getOrCreateChannel,
	};
	const originalSettings = {
		Token: state.settings.Token,
		GuildID: state.settings.GuildID,
		ControlChannelID: state.settings.ControlChannelID,
		Whitelist: state.settings.Whitelist,
	};
	const originalDcClient = state.dcClient;
	const originalWaClient = state.waClient;
	const originalContacts = { ...state.contacts };

	try {
		state.settings.Token = "TEST_TOKEN";
		state.settings.GuildID = "guild";
		state.settings.ControlChannelID = "control";
		state.settings.Whitelist = [];
		restoreObject(state.contacts, {});

		utils.discord.getGuild = async () => ({
			commands: { set: async () => {} },
		});
		utils.discord.getControlChannel = async () => ({ send: async () => {} });

		const linkedJids = [];
		utils.discord.getOrCreateChannel = async (jid) => {
			linkedJids.push(jid);
			return { channelId: "news-channel" };
		};

		let newsletterCreateCalls = 0;
		let rawQueryCalls = 0;
		state.waClient = {
			contacts: {},
			async newsletterCreate() {
				newsletterCreateCalls += 1;
				throw new Error(
					"Expected raw WMex compatibility path instead of newsletterCreate()",
				);
			},
			generateMessageTag() {
				return "wmex-tag-1";
			},
			async query() {
				rawQueryCalls += 1;
				return {
					tag: "iq",
					attrs: {},
					content: [
						{
							tag: "result",
							attrs: {},
							content: Buffer.from(
								JSON.stringify({
									data: {
										xwa2_newsletter_create: {
											id: "120363123456789012@newsletter",
											thread_metadata: {
												creation_time: "1730000000",
												description: { text: "Bridge test newsletter" },
												invite: "https://whatsapp.com/channel/test",
												name: { text: "Bridge Test" },
												picture: null,
												subscribers_count: "0",
												verification: "UNVERIFIED",
											},
											viewer_metadata: { mute: "OFF" },
										},
									},
								}),
								"utf-8",
							),
						},
					],
				};
			},
		};

		const fakeClient = new FakeDiscordClient();
		setClientFactoryOverrides({ createDiscordClient: () => fakeClient });
		const discordHandler = await importDiscordHandler(
			"newslettercreate-null-picture",
		);
		state.dcClient = await discordHandler.start();
		await delay(0);

		const interaction = createInteraction({
			channelId: "control",
			commandName: "newslettercreate",
			stringOptions: {
				name: "Bridge Test",
				description: "Bridge test newsletter",
			},
		});
		fakeClient.emit("interactionCreate", interaction);
		await delay(0);

		assert.equal(rawQueryCalls, 1);
		assert.equal(newsletterCreateCalls, 0);
		assert.deepEqual(linkedJids, ["120363123456789012@newsletter"]);
		assert.equal(
			state.contacts["120363123456789012@newsletter"],
			"Bridge Test",
		);
		assert.equal(
			state.waClient.contacts["120363123456789012@newsletter"],
			"Bridge Test",
		);
		assert.equal(interaction.records.editReply.length, 1);
		assert.equal(
			interaction.records.editReply[0]?.content,
			"Created newsletter `120363123456789012@newsletter` and linked it to <#news-channel>.",
		);
	} finally {
		utils.discord.getGuild = originalDiscordUtils.getGuild;
		utils.discord.getControlChannel = originalDiscordUtils.getControlChannel;
		utils.discord.getOrCreateChannel = originalDiscordUtils.getOrCreateChannel;

		state.settings.Token = originalSettings.Token;
		state.settings.GuildID = originalSettings.GuildID;
		state.settings.ControlChannelID = originalSettings.ControlChannelID;
		state.settings.Whitelist = originalSettings.Whitelist;

		restoreObject(state.contacts, originalContacts);
		state.dcClient = originalDcClient;
		state.waClient = originalWaClient;
		resetClientFactoryOverrides();
	}
});

test("/newsletterinviteinfo returns invite link/code from metadata", async () => {
	const originalDiscordUtils = {
		getGuild: utils.discord.getGuild,
		getControlChannel: utils.discord.getControlChannel,
	};
	const originalSettings = {
		Token: state.settings.Token,
		GuildID: state.settings.GuildID,
		ControlChannelID: state.settings.ControlChannelID,
	};
	const originalDcClient = state.dcClient;
	const originalWaClient = state.waClient;

	try {
		state.settings.Token = "TEST_TOKEN";
		state.settings.GuildID = "guild";
		state.settings.ControlChannelID = "control";

		utils.discord.getGuild = async () => ({
			commands: { set: async () => {} },
		});
		utils.discord.getControlChannel = async () => ({ send: async () => {} });

		state.waClient = {
			async newsletterMetadata(type, key) {
				assert.equal(type, "jid");
				assert.equal(key, "120363123456789012@newsletter");
				return {
					id: key,
					name: "Bridge Test",
					invite: "https://whatsapp.com/channel/AbCdEfGhIjKlMnOp",
				};
			},
		};

		const fakeClient = new FakeDiscordClient();
		setClientFactoryOverrides({ createDiscordClient: () => fakeClient });
		const discordHandler = await importDiscordHandler(
			"newsletterinviteinfo-basic",
		);
		state.dcClient = await discordHandler.start();
		await delay(0);

		const interaction = createInteraction({
			channelId: "control",
			commandName: "newsletterinviteinfo",
			stringOptions: {
				jid: "120363123456789012@newsletter",
			},
		});
		fakeClient.emit("interactionCreate", interaction);
		await delay(0);

		assert.equal(interaction.records.editReply.length, 1);
		const content = String(interaction.records.editReply[0]?.content || "");
		assert.ok(content.includes("Newsletter: `120363123456789012@newsletter`"));
		assert.ok(content.includes("Invite code: `AbCdEfGhIjKlMnOp`"));
		assert.ok(
			content.includes(
				"Invite link: https://whatsapp.com/channel/AbCdEfGhIjKlMnOp",
			),
		);
	} finally {
		utils.discord.getGuild = originalDiscordUtils.getGuild;
		utils.discord.getControlChannel = originalDiscordUtils.getControlChannel;

		state.settings.Token = originalSettings.Token;
		state.settings.GuildID = originalSettings.GuildID;
		state.settings.ControlChannelID = originalSettings.ControlChannelID;

		state.dcClient = originalDcClient;
		state.waClient = originalWaClient;
		resetClientFactoryOverrides();
	}
});

test("/newsletterfollow resolves newsletter JID from invite link when jid is omitted", async () => {
	const originalDiscordUtils = {
		getGuild: utils.discord.getGuild,
		getControlChannel: utils.discord.getControlChannel,
	};
	const originalSettings = {
		Token: state.settings.Token,
		GuildID: state.settings.GuildID,
		ControlChannelID: state.settings.ControlChannelID,
	};
	const originalDcClient = state.dcClient;
	const originalWaClient = state.waClient;

	try {
		state.settings.Token = "TEST_TOKEN";
		state.settings.GuildID = "guild";
		state.settings.ControlChannelID = "control";

		utils.discord.getGuild = async () => ({
			commands: { set: async () => {} },
		});
		utils.discord.getControlChannel = async () => ({ send: async () => {} });

		const metadataCalls = [];
		const followCalls = [];
		state.waClient = {
			async newsletterMetadata(type, key) {
				metadataCalls.push({ type, key });
				return { id: "120363123456789012@newsletter" };
			},
			async newsletterFollow(jid) {
				followCalls.push(jid);
			},
		};

		const fakeClient = new FakeDiscordClient();
		setClientFactoryOverrides({ createDiscordClient: () => fakeClient });
		const discordHandler = await importDiscordHandler(
			"newsletterfollow-invite-link",
		);
		state.dcClient = await discordHandler.start();
		await delay(0);

		const interaction = createInteraction({
			channelId: "control",
			commandName: "newsletterfollow",
			stringOptions: {
				invite: "https://whatsapp.com/channel/AbCdEfGhIjKlMnOp",
			},
		});
		fakeClient.emit("interactionCreate", interaction);
		await delay(0);

		assert.deepEqual(metadataCalls, [
			{ type: "invite", key: "AbCdEfGhIjKlMnOp" },
		]);
		assert.deepEqual(followCalls, ["120363123456789012@newsletter"]);
		assert.equal(interaction.records.editReply.length, 1);
		assert.equal(
			interaction.records.editReply[0]?.content,
			"Followed `120363123456789012@newsletter`.",
		);
	} finally {
		utils.discord.getGuild = originalDiscordUtils.getGuild;
		utils.discord.getControlChannel = originalDiscordUtils.getControlChannel;

		state.settings.Token = originalSettings.Token;
		state.settings.GuildID = originalSettings.GuildID;
		state.settings.ControlChannelID = originalSettings.ControlChannelID;

		state.dcClient = originalDcClient;
		state.waClient = originalWaClient;
		resetClientFactoryOverrides();
	}
});

test("/newslettermessagedebug shows mapping, pending send, and ack diagnostics", async () => {
	const originalDiscordUtils = {
		getGuild: utils.discord.getGuild,
		getControlChannel: utils.discord.getControlChannel,
	};
	const originalSettings = {
		Token: state.settings.Token,
		GuildID: state.settings.GuildID,
		ControlChannelID: state.settings.ControlChannelID,
	};
	const originalDcClient = state.dcClient;
	const originalWaClient = state.waClient;
	const originalChats = { ...state.chats };
	const originalLastMessages = state.lastMessages;

	try {
		state.settings.Token = "TEST_TOKEN";
		state.settings.GuildID = "guild";
		state.settings.ControlChannelID = "control";
		restoreObject(state.chats, {
			"120363123456789012@newsletter": { channelId: "newsletter-room" },
		});
		state.lastMessages = {
			"dc-news-debug-1": "3EB0DEBUGOUTBOUNDABC123456789",
			"3EB0DEBUGOUTBOUNDABC123456789": "dc-news-debug-1",
		};

		notePendingNewsletterSend({
			jid: "120363123456789012@newsletter",
			discordMessageId: "dc-news-debug-1",
			outboundId: "3EB0DEBUGOUTBOUNDABC123456789",
			content: { text: "newsletter debug text" },
		});
		noteNewsletterAckError({
			messageId: "3EB0DEBUGOUTBOUNDABC123456789",
			jid: "120363123456789012@newsletter",
			errorCode: "479",
		});
		noteNewsletterMessageDebug({
			discordMessageId: "dc-news-debug-1",
			jid: "120363123456789012@newsletter",
			operation: "Newsletter attachment send",
			phase: "ack_rejected",
			details: { error: "479" },
		});

		utils.discord.getGuild = async () => ({
			commands: { set: async () => {} },
		});
		utils.discord.getControlChannel = async () => ({ send: async () => {} });

		state.waClient = {};

		const fakeClient = new FakeDiscordClient();
		setClientFactoryOverrides({ createDiscordClient: () => fakeClient });
		const discordHandler = await importDiscordHandler(
			"newslettermessagedebug-basic",
		);
		state.dcClient = await discordHandler.start();
		await delay(0);

		const interaction = createInteraction({
			channelId: "newsletter-room",
			commandName: "newslettermessagedebug",
			stringOptions: {
				messageid: "dc-news-debug-1",
			},
		});
		fakeClient.emit("interactionCreate", interaction);
		await delay(0);

		assert.equal(interaction.records.editReply.length, 1);
		const content = String(interaction.records.editReply[0]?.content || "");
		assert.ok(content.includes("Discord message ID: `dc-news-debug-1`"));
		assert.ok(content.includes("`3EB0DEBUGOUTBOUNDABC123456789`"));
		assert.ok(
			content.includes("Ack errors: `3EB0DEBUGOUTBOUNDABC123456789` -> 479"),
		);
		assert.ok(content.includes('"pendingSend"'));
		assert.ok(content.includes('"operationHistory"'));
	} finally {
		clearPendingNewsletterSends({ jid: "120363123456789012@newsletter" });

		utils.discord.getGuild = originalDiscordUtils.getGuild;
		utils.discord.getControlChannel = originalDiscordUtils.getControlChannel;

		state.settings.Token = originalSettings.Token;
		state.settings.GuildID = originalSettings.GuildID;
		state.settings.ControlChannelID = originalSettings.ControlChannelID;

		restoreObject(state.chats, originalChats);
		state.lastMessages = originalLastMessages;
		state.dcClient = originalDcClient;
		state.waClient = originalWaClient;
		resetClientFactoryOverrides();
	}
});

test("/poll in a newsletter-linked channel sends interactive payload first", async () => {
	const originalDiscordUtils = {
		getGuild: utils.discord.getGuild,
		getControlChannel: utils.discord.getControlChannel,
	};
	const originalSettings = {
		Token: state.settings.Token,
		GuildID: state.settings.GuildID,
		ControlChannelID: state.settings.ControlChannelID,
	};
	const originalDcClient = state.dcClient;
	const originalWaClient = state.waClient;
	const originalChats = { ...state.chats };

	try {
		state.settings.Token = "TEST_TOKEN";
		state.settings.GuildID = "guild";
		state.settings.ControlChannelID = "control";
		restoreObject(state.chats, {
			"120363123456789012@newsletter": { channelId: "newsletter-room" },
		});

		utils.discord.getGuild = async () => ({
			commands: { set: async () => {} },
		});
		utils.discord.getControlChannel = async () => ({ send: async () => {} });

		const sendCalls = [];
		state.waClient = {
			async sendMessage(jid, content) {
				sendCalls.push({ jid, content });
				return {
					key: {
						id: "poll-msg-1",
						remoteJid: jid,
						server_id: "poll-server-1",
					},
				};
			},
		};

		const fakeClient = new FakeDiscordClient();
		setClientFactoryOverrides({ createDiscordClient: () => fakeClient });
		const discordHandler = await importDiscordHandler(
			"poll-newsletter-interactive-success",
		);
		state.dcClient = await discordHandler.start();
		await delay(0);

		const interaction = createInteraction({
			channelId: "newsletter-room",
			commandName: "poll",
			stringOptions: {
				question: "Bridge poll?",
				options: "Yes,No",
			},
			integerOptions: {
				select: 1,
			},
		});
		fakeClient.emit("interactionCreate", interaction);
		const completed = await waitFor(
			() =>
				sendCalls.length === 1 && interaction.records.editReply.length === 1,
			{ timeoutMs: 3200 },
		);

		assert.equal(completed, true);
		assert.equal(sendCalls.length, 1);
		assert.equal(sendCalls[0]?.jid, "120363123456789012@newsletter");
		assert.equal(sendCalls[0]?.content?.poll?.name, "Bridge poll?");
		assert.deepEqual(sendCalls[0]?.content?.poll?.values, ["Yes", "No"]);
		assert.equal(
			interaction.records.editReply[0]?.content,
			"Interactive newsletter poll sent to WhatsApp!",
		);
	} finally {
		utils.discord.getGuild = originalDiscordUtils.getGuild;
		utils.discord.getControlChannel = originalDiscordUtils.getControlChannel;

		state.settings.Token = originalSettings.Token;
		state.settings.GuildID = originalSettings.GuildID;
		state.settings.ControlChannelID = originalSettings.ControlChannelID;

		state.dcClient = originalDcClient;
		state.waClient = originalWaClient;
		restoreObject(state.chats, originalChats);
		resetClientFactoryOverrides();
	}
});

test("/poll in a newsletter-linked channel falls back to text when interactive send fails", async () => {
	const originalDiscordUtils = {
		getGuild: utils.discord.getGuild,
		getControlChannel: utils.discord.getControlChannel,
	};
	const originalSettings = {
		Token: state.settings.Token,
		GuildID: state.settings.GuildID,
		ControlChannelID: state.settings.ControlChannelID,
	};
	const originalDcClient = state.dcClient;
	const originalWaClient = state.waClient;
	const originalChats = { ...state.chats };

	try {
		state.settings.Token = "TEST_TOKEN";
		state.settings.GuildID = "guild";
		state.settings.ControlChannelID = "control";
		restoreObject(state.chats, {
			"120363123456789012@newsletter": { channelId: "newsletter-room" },
		});

		utils.discord.getGuild = async () => ({
			commands: { set: async () => {} },
		});
		utils.discord.getControlChannel = async () => ({ send: async () => {} });

		const sendCalls = [];
		state.waClient = {
			async sendMessage(jid, content) {
				sendCalls.push({ jid, content });
				if (content?.poll) {
					throw new Error("interactive newsletter poll rejected");
				}
				return {
					key: {
						id: "poll-msg-fallback-1",
						remoteJid: jid,
					},
				};
			},
		};

		const fakeClient = new FakeDiscordClient();
		setClientFactoryOverrides({ createDiscordClient: () => fakeClient });
		const discordHandler = await importDiscordHandler(
			"poll-newsletter-interactive-fallback",
		);
		state.dcClient = await discordHandler.start();
		await delay(0);

		const interaction = createInteraction({
			channelId: "newsletter-room",
			commandName: "poll",
			stringOptions: {
				question: "Bridge poll?",
				options: "Yes,No",
			},
			integerOptions: {
				select: 1,
			},
		});
		fakeClient.emit("interactionCreate", interaction);
		await delay(0);

		assert.equal(sendCalls.length, 2);
		assert.equal(sendCalls[0]?.jid, "120363123456789012@newsletter");
		assert.equal(sendCalls[0]?.content?.poll?.name, "Bridge poll?");
		assert.equal(typeof sendCalls[1]?.content?.text, "string");
		assert.ok(sendCalls[1]?.content?.text?.includes("📊 Poll: Bridge poll?"));
		assert.equal(
			interaction.records.editReply[0]?.content,
			"Interactive newsletter poll failed, so WA2DC sent a text fallback poll.",
		);
	} finally {
		utils.discord.getGuild = originalDiscordUtils.getGuild;
		utils.discord.getControlChannel = originalDiscordUtils.getControlChannel;

		state.settings.Token = originalSettings.Token;
		state.settings.GuildID = originalSettings.GuildID;
		state.settings.ControlChannelID = originalSettings.ControlChannelID;

		state.dcClient = originalDcClient;
		state.waClient = originalWaClient;
		restoreObject(state.chats, originalChats);
		resetClientFactoryOverrides();
	}
});

test("/poll in a newsletter-linked channel falls back to text when interactive ack is rejected", async () => {
	const originalDiscordUtils = {
		getGuild: utils.discord.getGuild,
		getControlChannel: utils.discord.getControlChannel,
	};
	const originalSettings = {
		Token: state.settings.Token,
		GuildID: state.settings.GuildID,
		ControlChannelID: state.settings.ControlChannelID,
	};
	const originalDcClient = state.dcClient;
	const originalWaClient = state.waClient;
	const originalChats = { ...state.chats };

	try {
		state.settings.Token = "TEST_TOKEN";
		state.settings.GuildID = "guild";
		state.settings.ControlChannelID = "control";
		restoreObject(state.chats, {
			"120363123456789012@newsletter": { channelId: "newsletter-room" },
		});

		utils.discord.getGuild = async () => ({
			commands: { set: async () => {} },
		});
		utils.discord.getControlChannel = async () => ({ send: async () => {} });

		const sendCalls = [];
		state.waClient = {
			async sendMessage(jid, content) {
				sendCalls.push({ jid, content });
				if (content?.poll) {
					setTimeout(() => {
						noteNewsletterAckError({
							messageId: "poll-msg-ack-reject",
							jid,
							errorCode: "479",
						});
					}, 1400);
					return {
						key: {
							id: "poll-msg-ack-reject",
							remoteJid: jid,
							server_id: "poll-server-ack-reject",
						},
					};
				}
				return {
					key: {
						id: "poll-msg-fallback-ack-1",
						remoteJid: jid,
						server_id: "poll-server-fallback-ack-1",
					},
				};
			},
		};

		const fakeClient = new FakeDiscordClient();
		setClientFactoryOverrides({ createDiscordClient: () => fakeClient });
		const discordHandler = await importDiscordHandler(
			"poll-newsletter-ack-fallback",
		);
		state.dcClient = await discordHandler.start();
		await delay(0);

		const interaction = createInteraction({
			channelId: "newsletter-room",
			commandName: "poll",
			stringOptions: {
				question: "Bridge poll?",
				options: "Yes,No",
			},
			integerOptions: {
				select: 1,
			},
		});
		fakeClient.emit("interactionCreate", interaction);
		const completed = await waitFor(
			() =>
				sendCalls.length === 2 && interaction.records.editReply.length === 1,
			{ timeoutMs: 3200 },
		);

		assert.equal(completed, true);
		assert.equal(sendCalls.length, 2);
		assert.equal(sendCalls[0]?.jid, "120363123456789012@newsletter");
		assert.equal(sendCalls[0]?.content?.poll?.name, "Bridge poll?");
		assert.equal(typeof sendCalls[1]?.content?.text, "string");
		assert.ok(sendCalls[1]?.content?.text?.includes("📊 Poll: Bridge poll?"));
		assert.equal(
			interaction.records.editReply[0]?.content,
			"Interactive newsletter poll was rejected (ack 479), so WA2DC sent a text fallback poll.",
		);
	} finally {
		utils.discord.getGuild = originalDiscordUtils.getGuild;
		utils.discord.getControlChannel = originalDiscordUtils.getControlChannel;

		state.settings.Token = originalSettings.Token;
		state.settings.GuildID = originalSettings.GuildID;
		state.settings.ControlChannelID = originalSettings.ControlChannelID;

		state.dcClient = originalDcClient;
		state.waClient = originalWaClient;
		restoreObject(state.chats, originalChats);
		resetClientFactoryOverrides();
	}
});

test("/pairwithcode registers a phone string option", async () => {
	const originalDiscordUtils = {
		getGuild: utils.discord.getGuild,
		getControlChannel: utils.discord.getControlChannel,
	};
	const originalSettings = {
		Token: state.settings.Token,
		GuildID: state.settings.GuildID,
		ControlChannelID: state.settings.ControlChannelID,
	};
	const originalDcClient = state.dcClient;

	try {
		state.settings.Token = "TEST_TOKEN";
		state.settings.GuildID = "guild";
		state.settings.ControlChannelID = "control";

		let registeredCommands = null;
		utils.discord.getGuild = async () => ({
			commands: {
				set: async (commands) => {
					registeredCommands = commands;
				},
			},
		});
		utils.discord.getControlChannel = async () => ({ send: async () => {} });

		const fakeClient = new FakeDiscordClient();
		setClientFactoryOverrides({ createDiscordClient: () => fakeClient });
		const discordHandler = await importDiscordHandler(
			"pairwithcode-registration",
		);
		state.dcClient = await discordHandler.start();

		assert.equal(await waitFor(() => registeredCommands), true);
		const command = registeredCommands.find(
			(candidate) => candidate.name === "pairwithcode",
		);
		assert.ok(command);
		assert.deepEqual(command.options, [
			{
				name: "phone",
				description: "Phone number with country code, such as +12025550123.",
				type: ApplicationCommandOptionType.String,
				required: true,
			},
		]);
	} finally {
		utils.discord.getGuild = originalDiscordUtils.getGuild;
		utils.discord.getControlChannel = originalDiscordUtils.getControlChannel;

		state.settings.Token = originalSettings.Token;
		state.settings.GuildID = originalSettings.GuildID;
		state.settings.ControlChannelID = originalSettings.ControlChannelID;

		state.dcClient = originalDcClient;
		resetClientFactoryOverrides();
	}
});

test("/pairwithcode accepts E.164 input and sends digits to Baileys", async () => {
	const originalDiscordUtils = {
		getGuild: utils.discord.getGuild,
		getControlChannel: utils.discord.getControlChannel,
	};
	const originalSettings = {
		Token: state.settings.Token,
		GuildID: state.settings.GuildID,
		ControlChannelID: state.settings.ControlChannelID,
	};
	const originalDcClient = state.dcClient;
	const originalWaClient = state.waClient;
	const originalWaConnection = state.waConnection;

	try {
		state.settings.Token = "TEST_TOKEN";
		state.settings.GuildID = "guild";
		state.settings.ControlChannelID = "control";

		utils.discord.getGuild = async () => ({
			commands: { set: async () => {} },
		});
		utils.discord.getControlChannel = async () => ({ send: async () => {} });

		const pairingRequests = [];
		state.waClient = {
			ev: new EventEmitter(),
			async requestPairingCode(phoneNumber) {
				pairingRequests.push(phoneNumber);
				return "ABCD-1234";
			},
		};
		state.waConnection = {
			browserProfile: ["Mac OS", "Chrome", "14.4.1"],
			connection: "connecting",
			hasQr: false,
			qrAt: 0,
			registered: false,
			updatedAt: Date.now() - 6000,
		};

		const fakeClient = new FakeDiscordClient();
		setClientFactoryOverrides({ createDiscordClient: () => fakeClient });
		const discordHandler = await importDiscordHandler("pairwithcode-e164");
		state.dcClient = await discordHandler.start();
		await delay(0);

		const interaction = createInteraction({
			channelId: "control",
			commandName: "pairwithcode",
			stringOptions: {
				phone: "+20 (10) 123-4567",
			},
		});
		fakeClient.emit("interactionCreate", interaction);
		await delay(0);

		assert.deepEqual(pairingRequests, ["20101234567"]);
		assert.equal(interaction.records.editReply.length, 1);
		assert.equal(
			interaction.records.editReply[0]?.content,
			"Your pairing code is: ABCD-1234\nEnter it immediately in WhatsApp. If it is rejected, wait for the next QR/pairing prompt and request a fresh code.",
		);
	} finally {
		utils.discord.getGuild = originalDiscordUtils.getGuild;
		utils.discord.getControlChannel = originalDiscordUtils.getControlChannel;

		state.settings.Token = originalSettings.Token;
		state.settings.GuildID = originalSettings.GuildID;
		state.settings.ControlChannelID = originalSettings.ControlChannelID;

		state.dcClient = originalDcClient;
		state.waClient = originalWaClient;
		state.waConnection = originalWaConnection;
		resetClientFactoryOverrides();
	}
});

test("/pairwithcode refuses to request codes after WhatsApp is connected", async () => {
	const originalDiscordUtils = {
		getGuild: utils.discord.getGuild,
		getControlChannel: utils.discord.getControlChannel,
	};
	const originalSettings = {
		Token: state.settings.Token,
		GuildID: state.settings.GuildID,
		ControlChannelID: state.settings.ControlChannelID,
	};
	const originalDcClient = state.dcClient;
	const originalWaClient = state.waClient;
	const originalWaConnection = state.waConnection;

	try {
		state.settings.Token = "TEST_TOKEN";
		state.settings.GuildID = "guild";
		state.settings.ControlChannelID = "control";

		utils.discord.getGuild = async () => ({
			commands: { set: async () => {} },
		});
		utils.discord.getControlChannel = async () => ({ send: async () => {} });

		const pairingRequests = [];
		state.waClient = {
			ev: new EventEmitter(),
			async requestPairingCode(phoneNumber) {
				pairingRequests.push(phoneNumber);
				return "ABCD-1234";
			},
		};
		state.waConnection = {
			browserProfile: ["Mac OS", "Chrome", "14.4.1"],
			connection: "open",
			hasQr: false,
			qrAt: 0,
			registered: true,
			updatedAt: Date.now(),
		};

		const fakeClient = new FakeDiscordClient();
		setClientFactoryOverrides({ createDiscordClient: () => fakeClient });
		const discordHandler = await importDiscordHandler("pairwithcode-connected");
		state.dcClient = await discordHandler.start();
		await delay(0);

		const interaction = createInteraction({
			channelId: "control",
			commandName: "pairwithcode",
			stringOptions: {
				phone: "+1 202 555 0123",
			},
		});
		fakeClient.emit("interactionCreate", interaction);

		assert.equal(
			await waitFor(() => interaction.records.editReply.length === 1),
			true,
		);
		assert.deepEqual(pairingRequests, []);
		assert.match(
			interaction.records.editReply[0]?.content,
			/WhatsApp is already connected/,
		);
	} finally {
		utils.discord.getGuild = originalDiscordUtils.getGuild;
		utils.discord.getControlChannel = originalDiscordUtils.getControlChannel;

		state.settings.Token = originalSettings.Token;
		state.settings.GuildID = originalSettings.GuildID;
		state.settings.ControlChannelID = originalSettings.ControlChannelID;

		state.dcClient = originalDcClient;
		state.waClient = originalWaClient;
		state.waConnection = originalWaConnection;
		resetClientFactoryOverrides();
	}
});

test("/pairwithcode refuses to request codes when auth is already registered", async () => {
	const originalDiscordUtils = {
		getGuild: utils.discord.getGuild,
		getControlChannel: utils.discord.getControlChannel,
	};
	const originalSettings = {
		Token: state.settings.Token,
		GuildID: state.settings.GuildID,
		ControlChannelID: state.settings.ControlChannelID,
	};
	const originalDcClient = state.dcClient;
	const originalWaClient = state.waClient;
	const originalWaConnection = state.waConnection;

	try {
		state.settings.Token = "TEST_TOKEN";
		state.settings.GuildID = "guild";
		state.settings.ControlChannelID = "control";

		utils.discord.getGuild = async () => ({
			commands: { set: async () => {} },
		});
		utils.discord.getControlChannel = async () => ({ send: async () => {} });

		const pairingRequests = [];
		state.waClient = {
			authState: { creds: { registered: true } },
			ev: new EventEmitter(),
			async requestPairingCode(phoneNumber) {
				pairingRequests.push(phoneNumber);
				return "ABCD-1234";
			},
		};
		state.waConnection = {
			browserProfile: ["Mac OS", "Chrome", "14.4.1"],
			connection: "connecting",
			hasQr: false,
			qrAt: 0,
			registered: true,
			updatedAt: Date.now() - 6000,
		};

		const fakeClient = new FakeDiscordClient();
		setClientFactoryOverrides({ createDiscordClient: () => fakeClient });
		const discordHandler = await importDiscordHandler(
			"pairwithcode-registered",
		);
		state.dcClient = await discordHandler.start();
		await delay(0);

		const interaction = createInteraction({
			channelId: "control",
			commandName: "pairwithcode",
			stringOptions: {
				phone: "+1 202 555 0123",
			},
		});
		fakeClient.emit("interactionCreate", interaction);

		assert.equal(
			await waitFor(() => interaction.records.editReply.length === 1),
			true,
		);
		assert.deepEqual(pairingRequests, []);
		assert.match(
			interaction.records.editReply[0]?.content,
			/already has a registered auth session/,
		);
	} finally {
		utils.discord.getGuild = originalDiscordUtils.getGuild;
		utils.discord.getControlChannel = originalDiscordUtils.getControlChannel;

		state.settings.Token = originalSettings.Token;
		state.settings.GuildID = originalSettings.GuildID;
		state.settings.ControlChannelID = originalSettings.ControlChannelID;

		state.dcClient = originalDcClient;
		state.waClient = originalWaClient;
		state.waConnection = originalWaConnection;
		resetClientFactoryOverrides();
	}
});

test("/pairwithcode on Android schedules a pairing-browser restart", async () => {
	const originalDiscordUtils = {
		getGuild: utils.discord.getGuild,
		getControlChannel: utils.discord.getControlChannel,
	};
	const originalSettings = {
		Token: state.settings.Token,
		GuildID: state.settings.GuildID,
		ControlChannelID: state.settings.ControlChannelID,
	};
	const originalDcClient = state.dcClient;
	const originalWaClient = state.waClient;
	const originalWaConnection = state.waConnection;
	const originalShutdownRequested = state.shutdownRequested;
	const originalDeleteSession = utils.whatsapp.deleteSession;
	const originalExit = process.exit;
	const originalRestartFlagPath = process.env.WA2DC_RESTART_FLAG_PATH;
	const originalBrowserEnv = process.env.WA2DC_WHATSAPP_BROWSER;
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "wa2dc-pair-"));
	const flagPath = path.join(tempDir, "restart.flag");
	let exitCode = null;
	let deletedSession = false;

	try {
		process.env.WA2DC_RESTART_FLAG_PATH = flagPath;
		delete process.env.WA2DC_WHATSAPP_BROWSER;
		process.exit = (code) => {
			exitCode = code;
		};
		state.shutdownRequested = false;
		state.settings.Token = "TEST_TOKEN";
		state.settings.GuildID = "guild";
		state.settings.ControlChannelID = "control";

		utils.discord.getGuild = async () => ({
			commands: { set: async () => {} },
		});
		utils.discord.getControlChannel = async () => ({ send: async () => {} });
		utils.whatsapp.deleteSession = async () => {
			deletedSession = true;
		};

		const pairingRequests = [];
		state.waClient = {
			ev: new EventEmitter(),
			async requestPairingCode(phoneNumber) {
				pairingRequests.push(phoneNumber);
				return "ABCD-1234";
			},
		};
		state.waConnection = {
			browserProfile: ["13", "Android", ""],
			connection: "connecting",
			hasQr: false,
			qrAt: 0,
			registered: false,
			updatedAt: Date.now() - 6000,
		};

		const fakeClient = new FakeDiscordClient();
		fakeClient.destroy = () => {};
		setClientFactoryOverrides({ createDiscordClient: () => fakeClient });
		const discordHandler = await importDiscordHandler(
			"pairwithcode-android-restart",
		);
		state.dcClient = await discordHandler.start();
		await delay(0);

		const interaction = createInteraction({
			channelId: "control",
			commandName: "pairwithcode",
			stringOptions: {
				phone: "+1 202 555 0123",
			},
		});
		fakeClient.emit("interactionCreate", interaction);

		assert.equal(
			await waitFor(() => interaction.records.editReply.length === 1),
			true,
		);
		assert.deepEqual(pairingRequests, []);
		assert.equal(deletedSession, true);
		assert.match(interaction.records.editReply[0]?.content, /will restart/);
		assert.match(interaction.records.editReply[0]?.content, /view-once/i);

		const pendingProfile = await storage.get(
			"whatsapp-pairing-code-browser-profile",
		);
		assert.equal(pendingProfile?.toString("utf8"), "macos-chrome");
		assert.equal(await waitFor(() => exitCode === 0), true);
		const flag = JSON.parse(await fs.readFile(flagPath, "utf8"));
		assert.equal(flag.reason, "pairing-code-browser-profile");
	} finally {
		process.exit = originalExit;
		if (originalRestartFlagPath == null) {
			delete process.env.WA2DC_RESTART_FLAG_PATH;
		} else {
			process.env.WA2DC_RESTART_FLAG_PATH = originalRestartFlagPath;
		}
		if (originalBrowserEnv == null) {
			delete process.env.WA2DC_WHATSAPP_BROWSER;
		} else {
			process.env.WA2DC_WHATSAPP_BROWSER = originalBrowserEnv;
		}
		await storage.upsert("whatsapp-pairing-code-browser-profile", "");
		await fs.rm(tempDir, { recursive: true, force: true });
		utils.discord.getGuild = originalDiscordUtils.getGuild;
		utils.discord.getControlChannel = originalDiscordUtils.getControlChannel;
		utils.whatsapp.deleteSession = originalDeleteSession;

		state.settings.Token = originalSettings.Token;
		state.settings.GuildID = originalSettings.GuildID;
		state.settings.ControlChannelID = originalSettings.ControlChannelID;
		state.shutdownRequested = originalShutdownRequested;
		state.dcClient = originalDcClient;
		state.waClient = originalWaClient;
		state.waConnection = originalWaConnection;
		resetClientFactoryOverrides();
	}
});

test("/setwamediaburstsize updates WhatsApp to Discord media burst size", async () => {
	const originalDiscordUtils = {
		getGuild: utils.discord.getGuild,
		getControlChannel: utils.discord.getControlChannel,
	};
	const originalSettings = {
		Token: state.settings.Token,
		GuildID: state.settings.GuildID,
		ControlChannelID: state.settings.ControlChannelID,
		WhatsAppDiscordMediaBurstSize: state.settings.WhatsAppDiscordMediaBurstSize,
	};
	const originalDcClient = state.dcClient;

	try {
		state.settings.Token = "TEST_TOKEN";
		state.settings.GuildID = "guild";
		state.settings.ControlChannelID = "control";
		state.settings.WhatsAppDiscordMediaBurstSize = 10;

		utils.discord.getGuild = async () => ({
			commands: { set: async () => {} },
		});
		utils.discord.getControlChannel = async () => ({ send: async () => {} });

		const fakeClient = new FakeDiscordClient();
		setClientFactoryOverrides({ createDiscordClient: () => fakeClient });
		const discordHandler = await importDiscordHandler(
			"set-wa-media-burst-size",
		);
		state.dcClient = await discordHandler.start();
		await delay(0);

		const interaction = createInteraction({
			channelId: "control",
			commandName: "setwamediaburstsize",
			integerOptions: {
				count: 4,
			},
		});
		fakeClient.emit("interactionCreate", interaction);
		await delay(0);

		assert.equal(state.settings.WhatsAppDiscordMediaBurstSize, 4);
		assert.equal(interaction.records.editReply.length, 1);
		assert.equal(
			interaction.records.editReply[0]?.content,
			"WhatsApp to Discord media burst size is set to 4 attachments per batch.",
		);
	} finally {
		utils.discord.getGuild = originalDiscordUtils.getGuild;
		utils.discord.getControlChannel = originalDiscordUtils.getControlChannel;

		state.settings.Token = originalSettings.Token;
		state.settings.GuildID = originalSettings.GuildID;
		state.settings.ControlChannelID = originalSettings.ControlChannelID;
		state.settings.WhatsAppDiscordMediaBurstSize =
			originalSettings.WhatsAppDiscordMediaBurstSize;

		state.dcClient = originalDcClient;
		resetClientFactoryOverrides();
	}
});

test("/waaudiomp3 toggles WhatsApp audio MP3 conversion", async () => {
	const originalDiscordUtils = {
		getGuild: utils.discord.getGuild,
		getControlChannel: utils.discord.getControlChannel,
	};
	const originalSettings = {
		Token: state.settings.Token,
		GuildID: state.settings.GuildID,
		ControlChannelID: state.settings.ControlChannelID,
		WhatsAppAudioConversionFormat: state.settings.WhatsAppAudioConversionFormat,
	};
	const originalDcClient = state.dcClient;

	try {
		state.settings.Token = "TEST_TOKEN";
		state.settings.GuildID = "guild";
		state.settings.ControlChannelID = "control";
		state.settings.WhatsAppAudioConversionFormat = "original";

		utils.discord.getGuild = async () => ({
			commands: { set: async () => {} },
		});
		utils.discord.getControlChannel = async () => ({ send: async () => {} });

		const fakeClient = new FakeDiscordClient();
		setClientFactoryOverrides({ createDiscordClient: () => fakeClient });
		const discordHandler = await importDiscordHandler("wa-audio-mp3");
		state.dcClient = await discordHandler.start();
		await delay(0);

		const interaction = createInteraction({
			channelId: "control",
			commandName: "waaudiomp3",
			booleanOptions: {
				enabled: true,
			},
		});
		fakeClient.emit("interactionCreate", interaction);
		await delay(0);

		assert.equal(state.settings.WhatsAppAudioConversionFormat, "mp3");
		assert.equal(interaction.records.editReply.length, 1);
		assert.equal(
			interaction.records.editReply[0]?.content,
			"WhatsApp audio MP3 conversion is enabled. Install ffmpeg on the host for conversion.",
		);
	} finally {
		utils.discord.getGuild = originalDiscordUtils.getGuild;
		utils.discord.getControlChannel = originalDiscordUtils.getControlChannel;

		state.settings.Token = originalSettings.Token;
		state.settings.GuildID = originalSettings.GuildID;
		state.settings.ControlChannelID = originalSettings.ControlChannelID;
		state.settings.WhatsAppAudioConversionFormat =
			originalSettings.WhatsAppAudioConversionFormat;

		state.dcClient = originalDcClient;
		resetClientFactoryOverrides();
	}
});
