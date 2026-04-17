import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import discordJs from "discord.js";

import {
	resetClientFactoryOverrides,
	setClientFactoryOverrides,
} from "../src/clientFactories.js";
import state from "../src/state.js";
import utils from "../src/utils.js";
import initIsolatedStorage from "./helpers/initIsolatedStorage.js";

await initIsolatedStorage(import.meta.url);

const { ChannelType, Collection } = discordJs;

const importDiscordHandler = async (tag) =>
	(await import(`../src/discordHandler.js?test=${encodeURIComponent(tag)}`))
		.default;

const restoreObject = (target, snapshot) => {
	Object.keys(target).forEach((key) => {
		delete target[key];
	});
	Object.assign(target, snapshot);
};

const createInteraction = ({
	channelId,
	commandName,
	stringOptions = {},
	booleanOptions = {},
	channelOptions = {},
	userOptions = {},
	roleOptions = {},
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
			getInteger: () => null,
			getNumber: () => null,
			getChannel: (name) =>
				name in channelOptions ? channelOptions[name] : null,
			getUser: (name) => (name in userOptions ? userOptions[name] : null),
			getRole: (name) => (name in roleOptions ? roleOptions[name] : null),
		},
		isButton: () => false,
		isCommand: () => true,
		isChatInputCommand: () => true,
		async deferReply(payload) {
			records.deferReply.push(payload);
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

test("utils.discord.safeWebhookSend forwards threadId for thread-backed chats", async () => {
	const originalChats = { ...state.chats };

	try {
		restoreObject(state.chats, {
			"123@s.whatsapp.net": {
				id: "wh-1",
				type: 1,
				token: "tok",
				channelId: "forum-1",
				threadId: "thread-1",
			},
		});

		const sends = [];
		await utils.discord.safeWebhookSend(
			{
				async send(payload) {
					sends.push(payload);
					return { id: "dc-1", channelId: "thread-1" };
				},
			},
			{ content: "hello from whatsapp" },
			"123@s.whatsapp.net",
		);

		assert.equal(sends.length, 1);
		assert.equal(sends[0]?.threadId, "thread-1");
	} finally {
		restoreObject(state.chats, originalChats);
	}
});

test("utils.discord.getOrCreateChannel creates a managed forum thread when thread mode is enabled", async () => {
	const originalDiscordUtils = {
		getGuild: utils.discord.getGuild,
	};
	const originalSettings = {
		DefaultChatType: state.settings.DefaultChatType,
		Categories: Array.isArray(state.settings.Categories)
			? [...state.settings.Categories]
			: [],
		ThreadNotificationsEnabled: state.settings.ThreadNotificationsEnabled,
		ThreadNotificationRoles: [...(state.settings.ThreadNotificationRoles || [])],
		ThreadNotificationUsers: [...(state.settings.ThreadNotificationUsers || [])],
	};
	const originalContacts = { ...state.contacts };
	const originalChats = { ...state.chats };
	const originalGoccRuns = { ...state.goccRuns };
	const originalDcClient = state.dcClient;

	try {
		state.settings.DefaultChatType = "thread";
		state.settings.Categories = ["cat-1"];
		state.settings.ThreadNotificationsEnabled = true;
		state.settings.ThreadNotificationRoles = ["111"];
		state.settings.ThreadNotificationUsers = ["222"];
		state.contacts["123@s.whatsapp.net"] = "Alice";
		restoreObject(state.chats, {});
		restoreObject(state.goccRuns, {});
		state.dcClient = { user: { id: "bot-1" } };

		const channels = new Collection();
		channels.set("cat-1", {
			id: "cat-1",
			type: ChannelType.GuildCategory,
		});

		const createdChannels = [];
		const createdThreads = [];
		const forumHost = {
			id: "forum-1",
			name: "whatsapp-threads",
			type: ChannelType.GuildForum,
			parentId: "cat-1",
			async fetchWebhooks() {
				return { find: () => null };
			},
			async createWebhook() {
				return {
					id: "wh-1",
					type: 1,
					token: "tok",
					channelId: "forum-1",
					client: { options: {} },
				};
			},
			threads: {
				create: async (payload) => {
					createdThreads.push(payload);
					const thread = {
						id: "thread-1",
						type: ChannelType.PublicThread,
						parentId: "forum-1",
						name: payload.name,
					};
					channels.set(thread.id, thread);
					return thread;
				},
			},
		};

		utils.discord.getGuild = async () => ({
			channels: {
				cache: channels,
				async fetch(id) {
					if (typeof id === "undefined") return channels;
					return channels.get(id) || null;
				},
				async create(payload) {
					createdChannels.push(payload);
					if (payload.type === ChannelType.GuildForum) {
						channels.set(forumHost.id, forumHost);
						return forumHost;
					}
					const category = {
						id: "cat-created",
						name: payload.name,
						type: payload.type,
					};
					channels.set(category.id, category);
					return category;
				},
			},
		});

		const webhook = await utils.discord.getOrCreateChannel("123@s.whatsapp.net");

		assert.equal(createdChannels.length, 1);
		assert.equal(createdChannels[0]?.type, ChannelType.GuildForum);
		assert.equal(createdThreads.length, 1);
		assert.equal(createdThreads[0]?.name, "Alice");
		assert.match(createdThreads[0]?.message?.content || "", /New WhatsApp chat/);
		assert.match(createdThreads[0]?.message?.content || "", /<@&111>/);
		assert.match(createdThreads[0]?.message?.content || "", /<@222>/);
		assert.equal(state.chats["123@s.whatsapp.net"]?.channelId, "forum-1");
		assert.equal(state.chats["123@s.whatsapp.net"]?.threadId, "thread-1");
		assert.equal(webhook?.wa2dcTargetChannelId, "thread-1");
	} finally {
		utils.discord.getGuild = originalDiscordUtils.getGuild;
		state.settings.DefaultChatType = originalSettings.DefaultChatType;
		state.settings.Categories = originalSettings.Categories;
		state.settings.ThreadNotificationsEnabled =
			originalSettings.ThreadNotificationsEnabled;
		state.settings.ThreadNotificationRoles =
			originalSettings.ThreadNotificationRoles;
		state.settings.ThreadNotificationUsers =
			originalSettings.ThreadNotificationUsers;
		restoreObject(state.contacts, originalContacts);
		restoreObject(state.chats, originalChats);
		restoreObject(state.goccRuns, originalGoccRuns);
		state.dcClient = originalDcClient;
	}
});

test("/defaultchat and /threadnotifications update persisted thread settings", async () => {
	const originalDiscordUtils = {
		getGuild: utils.discord.getGuild,
		getControlChannel: utils.discord.getControlChannel,
	};
	const originalSettings = {
		Token: state.settings.Token,
		GuildID: state.settings.GuildID,
		ControlChannelID: state.settings.ControlChannelID,
		DefaultChatType: state.settings.DefaultChatType,
		ThreadNotificationsEnabled: state.settings.ThreadNotificationsEnabled,
	};
	const originalDcClient = state.dcClient;

	try {
		state.settings.Token = "TEST_TOKEN";
		state.settings.GuildID = "guild";
		state.settings.ControlChannelID = "control";
		state.settings.DefaultChatType = "channel";
		state.settings.ThreadNotificationsEnabled = false;

		utils.discord.getGuild = async () => ({
			commands: { set: async () => {} },
		});
		utils.discord.getControlChannel = async () => ({ send: async () => {} });

		const fakeClient = new FakeDiscordClient();
		setClientFactoryOverrides({ createDiscordClient: () => fakeClient });
		const discordHandler = await importDiscordHandler("thread-settings-commands");
		state.dcClient = await discordHandler.start();
		await delay(0);

		const defaultChatInteraction = createInteraction({
			channelId: "control",
			commandName: "defaultchat",
			stringOptions: { mode: "thread" },
		});
		fakeClient.emit("interactionCreate", defaultChatInteraction);
		await delay(0);

		assert.equal(state.settings.DefaultChatType, "thread");
		assert.match(
			String(defaultChatInteraction.records.editReply[0]?.content || ""),
			/Default chat mode set to `thread`/i,
		);

		const notificationsInteraction = createInteraction({
			channelId: "control",
			commandName: "threadnotifications",
			booleanOptions: { enabled: true },
		});
		fakeClient.emit("interactionCreate", notificationsInteraction);
		await delay(0);

		assert.equal(state.settings.ThreadNotificationsEnabled, true);
		assert.equal(
			notificationsInteraction.records.editReply[0]?.content,
			"Thread creation notifications are enabled.",
		);
	} finally {
		utils.discord.getGuild = originalDiscordUtils.getGuild;
		utils.discord.getControlChannel = originalDiscordUtils.getControlChannel;
		state.settings.Token = originalSettings.Token;
		state.settings.GuildID = originalSettings.GuildID;
		state.settings.ControlChannelID = originalSettings.ControlChannelID;
		state.settings.DefaultChatType = originalSettings.DefaultChatType;
		state.settings.ThreadNotificationsEnabled =
			originalSettings.ThreadNotificationsEnabled;
		state.dcClient = originalDcClient;
		resetClientFactoryOverrides();
	}
});

test("/threadtargets uses one command for add/remove/list across roles and users", async () => {
	const originalDiscordUtils = {
		getGuild: utils.discord.getGuild,
		getControlChannel: utils.discord.getControlChannel,
	};
	const originalSettings = {
		Token: state.settings.Token,
		GuildID: state.settings.GuildID,
		ControlChannelID: state.settings.ControlChannelID,
		ThreadNotificationsEnabled: state.settings.ThreadNotificationsEnabled,
		ThreadNotificationRoles: [...(state.settings.ThreadNotificationRoles || [])],
		ThreadNotificationUsers: [...(state.settings.ThreadNotificationUsers || [])],
	};
	const originalDcClient = state.dcClient;

	try {
		state.settings.Token = "TEST_TOKEN";
		state.settings.GuildID = "guild";
		state.settings.ControlChannelID = "control";
		state.settings.ThreadNotificationsEnabled = true;
		state.settings.ThreadNotificationRoles = [];
		state.settings.ThreadNotificationUsers = [];

		utils.discord.getGuild = async () => ({
			commands: { set: async () => {} },
		});
		utils.discord.getControlChannel = async () => ({ send: async () => {} });

		const fakeClient = new FakeDiscordClient();
		setClientFactoryOverrides({ createDiscordClient: () => fakeClient });
		const discordHandler = await importDiscordHandler("threadtargets-command");
		state.dcClient = await discordHandler.start();
		await delay(0);

		const addRole = createInteraction({
			channelId: "control",
			commandName: "threadtargets",
			stringOptions: { action: "add" },
			roleOptions: { role: { id: "333", name: "Support" } },
		});
		fakeClient.emit("interactionCreate", addRole);
		await delay(0);
		assert.deepEqual(state.settings.ThreadNotificationRoles, ["333"]);
		assert.equal(
			addRole.records.editReply[0]?.content,
			"Added <@&333> to thread notifications.",
		);

		const addUser = createInteraction({
			channelId: "control",
			commandName: "threadtargets",
			stringOptions: { action: "add" },
			userOptions: { user: { id: "444", username: "Alice" } },
		});
		fakeClient.emit("interactionCreate", addUser);
		await delay(0);
		assert.deepEqual(state.settings.ThreadNotificationUsers, ["444"]);

		const listTargets = createInteraction({
			channelId: "control",
			commandName: "threadtargets",
			stringOptions: { action: "list" },
		});
		fakeClient.emit("interactionCreate", listTargets);
		await delay(0);
		const listed = String(listTargets.records.editReply[0]?.content || "");
		assert.match(listed, /Roles: <@&333>/);
		assert.match(listed, /Users: <@444>/);

		const removeRole = createInteraction({
			channelId: "control",
			commandName: "threadtargets",
			stringOptions: { action: "remove" },
			roleOptions: { role: { id: "333", name: "Support" } },
		});
		fakeClient.emit("interactionCreate", removeRole);
		await delay(0);
		assert.deepEqual(state.settings.ThreadNotificationRoles, []);
		assert.equal(
			removeRole.records.editReply[0]?.content,
			"Removed <@&333> from thread notifications.",
		);
	} finally {
		utils.discord.getGuild = originalDiscordUtils.getGuild;
		utils.discord.getControlChannel = originalDiscordUtils.getControlChannel;
		state.settings.Token = originalSettings.Token;
		state.settings.GuildID = originalSettings.GuildID;
		state.settings.ControlChannelID = originalSettings.ControlChannelID;
		state.settings.ThreadNotificationsEnabled =
			originalSettings.ThreadNotificationsEnabled;
		state.settings.ThreadNotificationRoles =
			originalSettings.ThreadNotificationRoles;
		state.settings.ThreadNotificationUsers =
			originalSettings.ThreadNotificationUsers;
		state.dcClient = originalDcClient;
		resetClientFactoryOverrides();
	}
});

test("/link accepts forum threads and stores the parent webhook channel plus threadId", async () => {
	const originalDiscordUtils = {
		getGuild: utils.discord.getGuild,
		getControlChannel: utils.discord.getControlChannel,
		getChannel: utils.discord.getChannel,
	};
	const originalWhatsAppUtils = {
		toJid: utils.whatsapp.toJid,
	};
	const originalSettings = {
		Token: state.settings.Token,
		GuildID: state.settings.GuildID,
		ControlChannelID: state.settings.ControlChannelID,
	};
	const originalChats = { ...state.chats };
	const originalGoccRuns = { ...state.goccRuns };
	const originalDcClient = state.dcClient;

	try {
		state.settings.Token = "TEST_TOKEN";
		state.settings.GuildID = "guild";
		state.settings.ControlChannelID = "control";
		restoreObject(state.chats, {});
		restoreObject(state.goccRuns, {});

		utils.discord.getGuild = async () => ({
			commands: { set: async () => {} },
		});
		utils.discord.getControlChannel = async () => ({ send: async () => {} });
		utils.discord.getChannel = async () => null;
		utils.whatsapp.toJid = () => "123@s.whatsapp.net";

		const forumHost = {
			id: "forum-1",
			name: "whatsapp-threads",
			type: ChannelType.GuildForum,
			async fetchWebhooks() {
				return { find: () => null };
			},
			async createWebhook() {
				return {
					id: "wh-1",
					type: 1,
					token: "tok",
					channelId: "forum-1",
					client: { options: {} },
				};
			},
		};
		const targetThread = {
			id: "thread-1",
			type: ChannelType.PublicThread,
			parentId: "forum-1",
			parent: forumHost,
			guildId: "guild",
		};

		const fakeClient = new FakeDiscordClient();
		setClientFactoryOverrides({ createDiscordClient: () => fakeClient });
		const discordHandler = await importDiscordHandler("link-forum-thread");
		state.dcClient = await discordHandler.start();
		await delay(0);

		const interaction = createInteraction({
			channelId: "control",
			commandName: "link",
			stringOptions: { contact: "Alice" },
			channelOptions: { channel: targetThread },
		});
		fakeClient.emit("interactionCreate", interaction);
		await delay(0);

		assert.equal(state.chats["123@s.whatsapp.net"]?.channelId, "forum-1");
		assert.equal(state.chats["123@s.whatsapp.net"]?.threadId, "thread-1");
		assert.match(
			String(interaction.records.editReply[0]?.content || ""),
			/Linked <#thread-1>/,
		);
	} finally {
		utils.discord.getGuild = originalDiscordUtils.getGuild;
		utils.discord.getControlChannel = originalDiscordUtils.getControlChannel;
		utils.discord.getChannel = originalDiscordUtils.getChannel;
		utils.whatsapp.toJid = originalWhatsAppUtils.toJid;
		state.settings.Token = originalSettings.Token;
		state.settings.GuildID = originalSettings.GuildID;
		state.settings.ControlChannelID = originalSettings.ControlChannelID;
		restoreObject(state.chats, originalChats);
		restoreObject(state.goccRuns, originalGoccRuns);
		state.dcClient = originalDcClient;
		resetClientFactoryOverrides();
	}
});
