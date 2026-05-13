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

const restoreObject = (target, snapshot) => {
	Object.keys(target).forEach((key) => {
		delete target[key];
	});
	Object.assign(target, snapshot);
};
const waitFor = async (
	predicate,
	{ timeoutMs = 1000, intervalMs = 5 } = {},
) => {
	const deadline = Date.now() + timeoutMs;
	while (true) {
		if (predicate()) return true;
		if (Date.now() >= deadline) return false;
		await delay(intervalMs);
	}
};

const importDiscordHandler = async (tag) =>
	(await import(`../src/discordHandler.js?test=${encodeURIComponent(tag)}`))
		.default;

test("Discord typing updates WhatsApp presence", async () => {
	const originalSetTimeout = global.setTimeout;
	const originalDiscordUtils = {
		getGuild: utils.discord.getGuild,
		getControlChannel: utils.discord.getControlChannel,
		channelIdToJid: utils.discord.channelIdToJid,
	};
	const originalSettings = {
		Token: state.settings.Token,
		GuildID: state.settings.GuildID,
		oneWay: state.settings.oneWay,
	};
	const originalDcClient = state.dcClient;
	const originalWaClient = state.waClient;
	const originalChat = state.chats["123@jid"];

	try {
		global.setTimeout = (fn, ms, ...args) => {
			if (typeof ms === "number" && ms >= 1000) {
				return originalSetTimeout(fn, 0, ...args);
			}
			return originalSetTimeout(fn, ms, ...args);
		};

		const presenceUpdates = [];
		state.waClient = {
			async sendPresenceUpdate(status, jid) {
				presenceUpdates.push({ status, jid });
			},
		};

		state.settings.Token = "TEST_TOKEN";
		state.settings.GuildID = "guild";
		state.chats["123@jid"] = { channelId: "chan-1" };

		utils.discord.getGuild = async () => ({
			commands: { set: async () => {} },
		});
		utils.discord.getControlChannel = async () => ({ send: async () => {} });
		utils.discord.channelIdToJid = () => "123@jid";

		class FakeDiscordClient extends EventEmitter {
			constructor() {
				super();
				this.loginCalls = [];
			}

			async login(token) {
				this.loginCalls.push(token);
				queueMicrotask(() => this.emit("ready"));
				return this;
			}
		}

		const fakeClient = new FakeDiscordClient();
		setClientFactoryOverrides({ createDiscordClient: () => fakeClient });

		const discordHandler = await importDiscordHandler("typing");
		state.dcClient = await discordHandler.start();

		fakeClient.emit("typingStart", { channel: { id: "chan-1" } });

		await Promise.resolve();
		await delay(0);

		assert.deepEqual(fakeClient.loginCalls, ["TEST_TOKEN"]);
		assert.deepEqual(presenceUpdates, [
			{ status: "composing", jid: "123@jid" },
			{ status: "paused", jid: "123@jid" },
		]);
	} finally {
		global.setTimeout = originalSetTimeout;

		utils.discord.getGuild = originalDiscordUtils.getGuild;
		utils.discord.getControlChannel = originalDiscordUtils.getControlChannel;
		utils.discord.channelIdToJid = originalDiscordUtils.channelIdToJid;

		state.settings.Token = originalSettings.Token;
		state.settings.GuildID = originalSettings.GuildID;
		state.settings.oneWay = originalSettings.oneWay;

		if (originalChat === undefined) {
			delete state.chats["123@jid"];
		} else {
			state.chats["123@jid"] = originalChat;
		}

		state.dcClient = originalDcClient;
		state.waClient = originalWaClient;
		resetClientFactoryOverrides();
	}
});

test("oneWay gating blocks WhatsApp -> Discord forwards in discordHandler", async () => {
	const originalDiscordUtils = {
		getGuild: utils.discord.getGuild,
		getControlChannel: utils.discord.getControlChannel,
		getOrCreateChannel: utils.discord.getOrCreateChannel,
	};
	const originalSettings = {
		Token: state.settings.Token,
		GuildID: state.settings.GuildID,
		oneWay: state.settings.oneWay,
	};
	const originalDcClient = state.dcClient;

	try {
		state.settings.Token = "TEST_TOKEN";
		state.settings.GuildID = "guild";
		state.settings.oneWay = 0b10;

		utils.discord.getGuild = async () => ({
			commands: { set: async () => {} },
		});
		utils.discord.getControlChannel = async () => ({ send: async () => {} });

		const getOrCreateCalls = [];
		utils.discord.getOrCreateChannel = async (jid) => {
			getOrCreateCalls.push(jid);
			return { send: async () => {} };
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
		const discordHandler = await importDiscordHandler("oneway-wa-block");
		state.dcClient = await discordHandler.start();

		fakeClient.emit("whatsappMessage", {
			id: "wa-1",
			name: "Tester",
			content: "hello",
			channelJid: "jid@s.whatsapp.net",
			file: null,
			quote: null,
			profilePic: null,
			isGroup: false,
			isForwarded: false,
			isEdit: false,
		});
		await delay(0);
		assert.equal(getOrCreateCalls.length, 0);

		state.settings.oneWay = 0b11;
		fakeClient.emit("whatsappMessage", {
			id: "wa-2",
			name: "Tester",
			content: "hello",
			channelJid: "jid@s.whatsapp.net",
			file: null,
			quote: null,
			profilePic: null,
			isGroup: false,
			isForwarded: false,
			isEdit: false,
		});
		await delay(0);
		assert.equal(getOrCreateCalls.length, 1);
	} finally {
		utils.discord.getGuild = originalDiscordUtils.getGuild;
		utils.discord.getControlChannel = originalDiscordUtils.getControlChannel;
		utils.discord.getOrCreateChannel = originalDiscordUtils.getOrCreateChannel;

		state.settings.Token = originalSettings.Token;
		state.settings.GuildID = originalSettings.GuildID;
		state.settings.oneWay = originalSettings.oneWay;

		state.dcClient = originalDcClient;
		resetClientFactoryOverrides();
	}
});

test("WhatsApp call notification send failures do not crash discordHandler", async () => {
	const originalDiscordUtils = {
		getGuild: utils.discord.getGuild,
		getControlChannel: utils.discord.getControlChannel,
		getOrCreateChannel: utils.discord.getOrCreateChannel,
		safeWebhookSend: utils.discord.safeWebhookSend,
	};
	const originalWhatsappUtils = {
		jidToName: utils.whatsapp.jidToName,
		getProfilePic: utils.whatsapp.getProfilePic,
	};
	const originalSettings = {
		Token: state.settings.Token,
		GuildID: state.settings.GuildID,
		oneWay: state.settings.oneWay,
	};
	const originalLogger = state.logger;
	const originalDcClient = state.dcClient;

	try {
		state.settings.Token = "TEST_TOKEN";
		state.settings.GuildID = "guild";
		state.settings.oneWay = 0b11;

		const errors = [];
		state.logger = {
			error(...args) {
				errors.push(args);
			},
		};
		utils.discord.getGuild = async () => ({
			commands: { set: async () => {} },
		});
		utils.discord.getControlChannel = async () => ({ send: async () => {} });
		utils.discord.getOrCreateChannel = async () => ({ id: "webhook-1" });
		utils.discord.safeWebhookSend = async () => {
			throw new Error("discord send failed");
		};
		utils.whatsapp.jidToName = () => "B Welcomehost Discord Whatsapp";
		utils.whatsapp.getProfilePic = async () => null;

		let unhandled;
		const onUnhandled = (err) => {
			unhandled = err;
		};
		process.once("unhandledRejection", onUnhandled);

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
		const discordHandler = await importDiscordHandler("wa-call-send-failure");
		state.dcClient = await discordHandler.start();

		fakeClient.emit("whatsappCall", {
			jid: "jid@s.whatsapp.net",
			call: { status: "offer", isVideo: false },
		});

		assert.equal(
			await waitFor(() => errors.length > 0 || Boolean(unhandled)),
			true,
		);
		process.removeListener("unhandledRejection", onUnhandled);

		assert.equal(unhandled, undefined);
		assert.equal(errors[0]?.[1], "Failed to process WhatsApp call notification");
	} finally {
		utils.discord.getGuild = originalDiscordUtils.getGuild;
		utils.discord.getControlChannel = originalDiscordUtils.getControlChannel;
		utils.discord.getOrCreateChannel = originalDiscordUtils.getOrCreateChannel;
		utils.discord.safeWebhookSend = originalDiscordUtils.safeWebhookSend;
		utils.whatsapp.jidToName = originalWhatsappUtils.jidToName;
		utils.whatsapp.getProfilePic = originalWhatsappUtils.getProfilePic;

		state.settings.Token = originalSettings.Token;
		state.settings.GuildID = originalSettings.GuildID;
		state.settings.oneWay = originalSettings.oneWay;
		state.logger = originalLogger;

		state.dcClient = originalDcClient;
		resetClientFactoryOverrides();
	}
});

test("WhatsApp view once media is sent to Discord as a spoiler attachment", async () => {
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
	};
	const originalLastMessages = state.lastMessages;
	const originalDcClient = state.dcClient;

	try {
		state.settings.Token = "TEST_TOKEN";
		state.settings.GuildID = "guild";
		state.settings.oneWay = 0b11;
		state.lastMessages = {};

		utils.discord.getGuild = async () => ({
			commands: { set: async () => {} },
		});
		utils.discord.getControlChannel = async () => ({ send: async () => {} });
		utils.discord.getOrCreateChannel = async () => ({
			id: "hook-1",
			token: "token",
			channel: { type: "GUILD_TEXT" },
		});

		const sent = [];
		utils.discord.safeWebhookSend = async (_webhook, args) => {
			sent.push(args);
			return { id: `dc-${sent.length}`, channel: { type: "GUILD_TEXT" } };
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
		const discordHandler = await importDiscordHandler("wa-view-once-spoiler");
		state.dcClient = await discordHandler.start();

		fakeClient.emit("whatsappMessage", {
			id: "wa-view-once",
			name: "Tester",
			content: "View once message:",
			channelJid: "jid@s.whatsapp.net",
			file: {
				name: "SPOILER_imageMessage.jpeg",
				attachment: Buffer.from("image"),
				spoiler: true,
			},
			quote: null,
			profilePic: null,
			isGroup: false,
			isForwarded: false,
			isEdit: false,
		});

		assert.equal(await waitFor(() => sent.length === 1), true);
		assert.equal(sent[0]?.files?.[0]?.name, "SPOILER_imageMessage.jpeg");
	} finally {
		utils.discord.getGuild = originalDiscordUtils.getGuild;
		utils.discord.getControlChannel = originalDiscordUtils.getControlChannel;
		utils.discord.getOrCreateChannel = originalDiscordUtils.getOrCreateChannel;
		utils.discord.safeWebhookSend = originalDiscordUtils.safeWebhookSend;

		state.settings.Token = originalSettings.Token;
		state.settings.GuildID = originalSettings.GuildID;
		state.settings.oneWay = originalSettings.oneWay;

		state.lastMessages = originalLastMessages;
		state.dcClient = originalDcClient;
		resetClientFactoryOverrides();
	}
});

test("WhatsApp view once media flag is sent to Discord as a spoiler attachment", async () => {
	const originalLocalDownloads = state.settings.LocalDownloads;
	const originalDiscordFileSizeLimit = state.settings.DiscordFileSizeLimit;
	try {
		state.settings.LocalDownloads = true;
		state.settings.DiscordFileSizeLimit = 1;
		const file = await utils.whatsapp.getFile(
			{
				key: {
					id: "wa-view-once-flag",
					remoteJid: "jid@s.whatsapp.net",
				},
				message: {
					imageMessage: {
						mimetype: "image/jpeg",
						fileLength: 2,
						viewOnce: true,
					},
				},
			},
			"imageMessage",
		);

		assert.equal(file?.name, "SPOILER_imageMessage.jpeg");
		assert.equal(file?.spoiler, true);
	} finally {
		state.settings.LocalDownloads = originalLocalDownloads;
		state.settings.DiscordFileSizeLimit = originalDiscordFileSizeLimit;
	}
});

test("WhatsApp spoiler files are uploaded to Discord with spoiler filenames", async () => {
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
	};
	const originalLastMessages = state.lastMessages;
	const originalDcClient = state.dcClient;

	try {
		state.settings.Token = "TEST_TOKEN";
		state.settings.GuildID = "guild";
		state.settings.oneWay = 0b11;
		state.lastMessages = {};

		utils.discord.getGuild = async () => ({
			commands: { set: async () => {} },
		});
		utils.discord.getControlChannel = async () => ({ send: async () => {} });
		utils.discord.getOrCreateChannel = async () => ({
			id: "hook-1",
			token: "token",
			channel: { type: "GUILD_TEXT" },
		});

		const sent = [];
		utils.discord.safeWebhookSend = async (_webhook, args) => {
			sent.push(args);
			return { id: `dc-${sent.length}`, channel: { type: "GUILD_TEXT" } };
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
		const discordHandler = await importDiscordHandler(
			"wa-spoiler-file-name-normalization",
		);
		state.dcClient = await discordHandler.start();

		fakeClient.emit("whatsappMessage", {
			id: "wa-view-once-unprefixed",
			name: "Tester",
			content: "",
			channelJid: "jid@s.whatsapp.net",
			file: {
				name: "imageMessage.jpeg",
				attachment: Buffer.from("image"),
				spoiler: true,
			},
			quote: null,
			profilePic: null,
			isGroup: false,
			isForwarded: false,
			isEdit: false,
		});

		assert.equal(await waitFor(() => sent.length === 1), true);
		assert.equal(sent[0]?.files?.[0]?.name, "SPOILER_imageMessage.jpeg");
	} finally {
		utils.discord.getGuild = originalDiscordUtils.getGuild;
		utils.discord.getControlChannel = originalDiscordUtils.getControlChannel;
		utils.discord.getOrCreateChannel = originalDiscordUtils.getOrCreateChannel;
		utils.discord.safeWebhookSend = originalDiscordUtils.safeWebhookSend;

		state.settings.Token = originalSettings.Token;
		state.settings.GuildID = originalSettings.GuildID;
		state.settings.oneWay = originalSettings.oneWay;

		state.lastMessages = originalLastMessages;
		state.dcClient = originalDcClient;
		resetClientFactoryOverrides();
	}
});

test("WhatsApp newsletter reactions resolve Discord message via value-side mapping fallback", async () => {
	const originalDiscordUtils = {
		getGuild: utils.discord.getGuild,
		getControlChannel: utils.discord.getControlChannel,
		getChannel: utils.discord.getChannel,
	};
	const originalSettings = {
		Token: state.settings.Token,
		GuildID: state.settings.GuildID,
		oneWay: state.settings.oneWay,
	};
	const originalChats = { ...state.chats };
	const originalReactions = state.reactions;
	const originalLastMessages = state.lastMessages;
	const originalDcClient = state.dcClient;

	try {
		state.settings.Token = "TEST_TOKEN";
		state.settings.GuildID = "guild";
		state.settings.oneWay = 0b11;
		state.lastMessages = {
			"dc-news-1": "137",
		};
		state.reactions = {};
		restoreObject(state.chats, {
			"120363123456789@newsletter": {
				channelId: "chan-news-1",
			},
		});

		utils.discord.getGuild = async () => ({
			commands: { set: async () => {} },
		});
		utils.discord.getControlChannel = async () => ({ send: async () => {} });

		const reacted = [];
		const fetchedIds = [];
		const fakeMessage = {
			reactions: { cache: new Map() },
			react: async (emoji) => {
				reacted.push(emoji);
			},
		};
		utils.discord.getChannel = async (channelId) => {
			assert.equal(channelId, "chan-news-1");
			return {
				id: channelId,
				messages: {
					fetch: async (messageId) => {
						fetchedIds.push(messageId);
						return fakeMessage;
					},
				},
				send: async () => {},
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

		const fakeClient = new FakeDiscordClient();
		setClientFactoryOverrides({ createDiscordClient: () => fakeClient });
		const discordHandler = await importDiscordHandler(
			"newsletter-reaction-value-map-fallback",
		);
		state.dcClient = await discordHandler.start();

		fakeClient.emit("whatsappReaction", {
			id: "137",
			jid: "120363123456789@newsletter",
			text: "👍",
			author: "newsletter:137:👍",
		});
		await delay(0);

		assert.deepEqual(fetchedIds, ["dc-news-1"]);
		assert.deepEqual(reacted, ["👍"]);
		assert.equal(state.reactions["dc-news-1"]?.["newsletter:137:👍"], "👍");
	} finally {
		utils.discord.getGuild = originalDiscordUtils.getGuild;
		utils.discord.getControlChannel = originalDiscordUtils.getControlChannel;
		utils.discord.getChannel = originalDiscordUtils.getChannel;

		state.settings.Token = originalSettings.Token;
		state.settings.GuildID = originalSettings.GuildID;
		state.settings.oneWay = originalSettings.oneWay;

		restoreObject(state.chats, originalChats);
		state.reactions = originalReactions;
		state.lastMessages = originalLastMessages;
		state.dcClient = originalDcClient;
		resetClientFactoryOverrides();
	}
});

test("WhatsApp sender platform suffix appends to mirrored Discord messages", async () => {
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
		WASenderPlatformSuffix: state.settings.WASenderPlatformSuffix,
	};
	const originalLastMessages = state.lastMessages;
	const originalDcClient = state.dcClient;

	try {
		state.settings.Token = "TEST_TOKEN";
		state.settings.GuildID = "guild";
		state.settings.oneWay = 0b11;
		state.settings.WASenderPlatformSuffix = true;
		state.lastMessages = {};

		utils.discord.getGuild = async () => ({
			commands: { set: async () => {} },
		});
		utils.discord.getControlChannel = async () => ({ send: async () => {} });
		utils.discord.getOrCreateChannel = async () => ({
			id: "hook-1",
			token: "token",
			channel: { type: "GUILD_TEXT" },
		});

		const sent = [];
		utils.discord.safeWebhookSend = async (_webhook, args) => {
			sent.push(args);
			return { id: `dc-${sent.length}`, channel: { type: "GUILD_TEXT" } };
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
		const discordHandler = await importDiscordHandler("wa-platform-suffix");
		state.dcClient = await discordHandler.start();

		fakeClient.emit("whatsappMessage", {
			id: "a".repeat(21),
			name: "Tester",
			content: "hello",
			channelJid: "jid@s.whatsapp.net",
			file: null,
			quote: null,
			profilePic: null,
			isGroup: false,
			isForwarded: false,
			isEdit: false,
		});
		await delay(0);

		assert.equal(sent.length, 1);
		assert.equal(sent[0]?.content, "hello\n\n*(Android)*");
	} finally {
		utils.discord.getGuild = originalDiscordUtils.getGuild;
		utils.discord.getControlChannel = originalDiscordUtils.getControlChannel;
		utils.discord.getOrCreateChannel = originalDiscordUtils.getOrCreateChannel;
		utils.discord.safeWebhookSend = originalDiscordUtils.safeWebhookSend;

		state.settings.Token = originalSettings.Token;
		state.settings.GuildID = originalSettings.GuildID;
		state.settings.oneWay = originalSettings.oneWay;
		state.settings.WASenderPlatformSuffix =
			originalSettings.WASenderPlatformSuffix;

		state.lastMessages = originalLastMessages;
		state.dcClient = originalDcClient;
		resetClientFactoryOverrides();
	}
});

test("WhatsApp @all payload allows Discord @everyone mention", async () => {
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
	};
	const originalLastMessages = state.lastMessages;
	const originalDcClient = state.dcClient;

	try {
		state.settings.Token = "TEST_TOKEN";
		state.settings.GuildID = "guild";
		state.settings.oneWay = 0b11;
		state.lastMessages = {};

		utils.discord.getGuild = async () => ({
			commands: { set: async () => {} },
		});
		utils.discord.getControlChannel = async () => ({ send: async () => {} });
		utils.discord.getOrCreateChannel = async () => ({
			id: "hook-1",
			token: "token",
			channel: { type: "GUILD_TEXT" },
		});

		const sent = [];
		utils.discord.safeWebhookSend = async (_webhook, args) => {
			sent.push(args);
			return { id: `dc-${sent.length}`, channel: { type: "GUILD_TEXT" } };
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
		const discordHandler = await importDiscordHandler("wa-mention-all");
		state.dcClient = await discordHandler.start();

		fakeClient.emit("whatsappMessage", {
			id: "wa-mention-all",
			name: "Tester",
			content: "hello @everyone",
			channelJid: "jid@s.whatsapp.net",
			file: null,
			quote: null,
			profilePic: null,
			isGroup: false,
			isForwarded: false,
			isEdit: false,
			discordMentionEveryone: true,
		});
		await delay(0);

		assert.equal(sent.length, 1);
		assert.equal(sent[0]?.content, "hello @everyone");
		assert.deepEqual(sent[0]?.allowedMentions, { parse: ["everyone"] });

		fakeClient.emit("whatsappMessage", {
			id: "wa-manual-everyone",
			name: "Tester",
			content: "manual @everyone",
			channelJid: "jid@s.whatsapp.net",
			file: null,
			quote: null,
			profilePic: null,
			isGroup: false,
			isForwarded: false,
			isEdit: false,
			discordMentionEveryone: false,
		});
		await delay(0);

		assert.equal(sent.length, 2);
		assert.equal(sent[1]?.content, "manual @everyone");
		assert.deepEqual(sent[1]?.allowedMentions, { parse: [] });
	} finally {
		utils.discord.getGuild = originalDiscordUtils.getGuild;
		utils.discord.getControlChannel = originalDiscordUtils.getControlChannel;
		utils.discord.getOrCreateChannel = originalDiscordUtils.getOrCreateChannel;
		utils.discord.safeWebhookSend = originalDiscordUtils.safeWebhookSend;

		state.settings.Token = originalSettings.Token;
		state.settings.GuildID = originalSettings.GuildID;
		state.settings.oneWay = originalSettings.oneWay;

		state.lastMessages = originalLastMessages;
		state.dcClient = originalDcClient;
		resetClientFactoryOverrides();
	}
});

test("Discord messageDelete emits discordDelete for bridged messages", async () => {
	const originalDiscordUtils = {
		getGuild: utils.discord.getGuild,
		getControlChannel: utils.discord.getControlChannel,
		channelIdToJid: utils.discord.channelIdToJid,
	};
	const originalSettings = {
		Token: state.settings.Token,
		GuildID: state.settings.GuildID,
	};
	const originalDcClient = state.dcClient;
	const originalWaClient = state.waClient;
	const originalLastMessages = state.lastMessages;
	const originalReactions = state.reactions;

	try {
		state.settings.Token = "TEST_TOKEN";
		state.settings.GuildID = "guild";
		state.lastMessages = { "wa-1": "dc-1", "dc-1": "wa-1" };
		state.reactions = {};

		utils.discord.getGuild = async () => ({
			commands: { set: async () => {} },
		});
		utils.discord.getControlChannel = async () => ({ send: async () => {} });
		utils.discord.channelIdToJid = () => "jid@s.whatsapp.net";

		const waEvents = [];
		const waEv = new EventEmitter();
		waEv.on("discordDelete", (payload) => waEvents.push(payload));
		state.waClient = { ev: waEv };

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
		const discordHandler = await importDiscordHandler("delete");
		state.dcClient = await discordHandler.start();

		fakeClient.emit("messageDelete", {
			id: "dc-1",
			channelId: "chan-1",
			webhookId: null,
			author: { id: "user-1" },
			channel: { send: async () => {} },
		});
		await delay(0);

		assert.deepEqual(waEvents, [
			{ jid: "jid@s.whatsapp.net", id: "wa-1", discordMessageId: "dc-1" },
		]);
		assert.equal(state.lastMessages["wa-1"], undefined);
		assert.equal(state.lastMessages["dc-1"], undefined);
	} finally {
		utils.discord.getGuild = originalDiscordUtils.getGuild;
		utils.discord.getControlChannel = originalDiscordUtils.getControlChannel;
		utils.discord.channelIdToJid = originalDiscordUtils.channelIdToJid;

		state.settings.Token = originalSettings.Token;
		state.settings.GuildID = originalSettings.GuildID;

		state.dcClient = originalDcClient;
		state.waClient = originalWaClient;
		state.lastMessages = originalLastMessages;
		state.reactions = originalReactions;
		resetClientFactoryOverrides();
	}
});

test("Discord messageDelete in newsletter channels notifies manual WhatsApp delete and skips discordDelete", async () => {
	const originalDiscordUtils = {
		getGuild: utils.discord.getGuild,
		getControlChannel: utils.discord.getControlChannel,
		channelIdToJid: utils.discord.channelIdToJid,
		getOrCreateChannel: utils.discord.getOrCreateChannel,
		safeWebhookSend: utils.discord.safeWebhookSend,
	};
	const originalSettings = {
		Token: state.settings.Token,
		GuildID: state.settings.GuildID,
	};
	const originalDcClient = state.dcClient;
	const originalWaClient = state.waClient;
	const originalLastMessages = state.lastMessages;
	const originalReactions = state.reactions;
	const originalChats = { ...state.chats };

	try {
		state.settings.Token = "TEST_TOKEN";
		state.settings.GuildID = "guild";
		state.lastMessages = {};
		state.reactions = {};
		restoreObject(state.chats, {
			"120363123456789@newsletter": {
				id: "wh",
				token: "tok",
				type: "incoming",
				channelId: "chan-1",
			},
		});

		utils.discord.getGuild = async () => ({
			commands: { set: async () => {} },
		});
		utils.discord.getControlChannel = async () => ({ send: async () => {} });
		utils.discord.channelIdToJid = () => "120363123456789@newsletter";
		utils.discord.getOrCreateChannel = async () => ({
			id: "wh",
			token: "tok",
			type: "incoming",
			channelId: "chan-1",
			channel: { type: "GUILD_TEXT" },
		});
		utils.discord.safeWebhookSend = async () => ({
			id: "dc-news-1",
			channel: { type: "GUILD_TEXT" },
			channelId: "chan-1",
			guildId: "guild",
			url: "https://discord.com/channels/guild/chan-1/dc-news-1",
		});

		const waEvents = [];
		const waEv = new EventEmitter();
		waEv.on("discordDelete", (payload) => waEvents.push(payload));
		state.waClient = { ev: waEv };

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
		const discordHandler = await importDiscordHandler(
			"newsletter-message-delete-server-id",
		);
		state.dcClient = await discordHandler.start();

		fakeClient.emit("whatsappMessage", {
			id: "newsletter-server-id-1",
			name: "Channel Owner",
			content: "newsletter content",
			channelJid: "120363123456789@newsletter",
			file: null,
			quote: null,
			profilePic: null,
			isGroup: false,
			isForwarded: false,
			isEdit: false,
		});
		await delay(0);

		assert.equal(state.lastMessages["newsletter-server-id-1"], "dc-news-1");
		assert.equal(state.lastMessages["dc-news-1"], "newsletter-server-id-1");

		const notices = [];
		fakeClient.emit("messageDelete", {
			id: "dc-news-1",
			channelId: "chan-1",
			webhookId: null,
			author: { id: "user-1" },
			channel: {
				send: async (value) => {
					notices.push(value);
				},
			},
		});
		await delay(0);

		assert.deepEqual(waEvents, []);
		assert.equal(state.lastMessages["newsletter-server-id-1"], undefined);
		assert.equal(state.lastMessages["dc-news-1"], undefined);
		assert.equal(notices.length, 1);
		assert.match(
			notices[0],
			/Please delete the message directly in WhatsApp on your phone/i,
		);
	} finally {
		utils.discord.getGuild = originalDiscordUtils.getGuild;
		utils.discord.getControlChannel = originalDiscordUtils.getControlChannel;
		utils.discord.channelIdToJid = originalDiscordUtils.channelIdToJid;
		utils.discord.getOrCreateChannel = originalDiscordUtils.getOrCreateChannel;
		utils.discord.safeWebhookSend = originalDiscordUtils.safeWebhookSend;

		state.settings.Token = originalSettings.Token;
		state.settings.GuildID = originalSettings.GuildID;

		state.dcClient = originalDcClient;
		state.waClient = originalWaClient;
		state.lastMessages = originalLastMessages;
		state.reactions = originalReactions;
		restoreObject(state.chats, originalChats);
		resetClientFactoryOverrides();
	}
});

test("Discord messageDelete in newsletter channels does not wait for server_id mapping", async () => {
	const originalDiscordUtils = {
		getGuild: utils.discord.getGuild,
		getControlChannel: utils.discord.getControlChannel,
		channelIdToJid: utils.discord.channelIdToJid,
	};
	const originalSettings = {
		Token: state.settings.Token,
		GuildID: state.settings.GuildID,
	};
	const originalDcClient = state.dcClient;
	const originalWaClient = state.waClient;
	const originalLastMessages = state.lastMessages;
	const originalReactions = state.reactions;

	try {
		state.settings.Token = "TEST_TOKEN";
		state.settings.GuildID = "guild";
		state.lastMessages = {};
		state.reactions = {};

		utils.discord.getGuild = async () => ({
			commands: { set: async () => {} },
		});
		utils.discord.getControlChannel = async () => ({ send: async () => {} });
		utils.discord.channelIdToJid = () => "120363123456789@newsletter";

		const waEvents = [];
		const waEv = new EventEmitter();
		waEv.on("discordDelete", (payload) => waEvents.push(payload));
		state.waClient = { ev: waEv };

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
		const discordHandler = await importDiscordHandler(
			"newsletter-message-delete-wait-server-id",
		);
		state.dcClient = await discordHandler.start();

		const notices = [];
		fakeClient.emit("messageDelete", {
			id: "dc-news-delayed",
			channelId: "chan-1",
			webhookId: null,
			author: { id: "user-1" },
			channel: {
				send: async (value) => {
					notices.push(value);
				},
			},
		});
		await delay(0);

		assert.deepEqual(waEvents, []);
		assert.equal(notices.length, 1);
		assert.match(
			notices[0],
			/Please delete the message directly in WhatsApp on your phone/i,
		);
	} finally {
		utils.discord.getGuild = originalDiscordUtils.getGuild;
		utils.discord.getControlChannel = originalDiscordUtils.getControlChannel;
		utils.discord.channelIdToJid = originalDiscordUtils.channelIdToJid;

		state.settings.Token = originalSettings.Token;
		state.settings.GuildID = originalSettings.GuildID;

		state.dcClient = originalDcClient;
		state.waClient = originalWaClient;
		state.lastMessages = originalLastMessages;
		state.reactions = originalReactions;
		resetClientFactoryOverrides();
	}
});

test("Discord newsletter deletes clear local mappings and skip WhatsApp delete", async () => {
	const originalDiscordUtils = {
		getGuild: utils.discord.getGuild,
		getControlChannel: utils.discord.getControlChannel,
		channelIdToJid: utils.discord.channelIdToJid,
	};
	const originalSettings = {
		Token: state.settings.Token,
		GuildID: state.settings.GuildID,
	};
	const originalDcClient = state.dcClient;
	const originalWaClient = state.waClient;
	const originalLastMessages = state.lastMessages;
	const originalReactions = state.reactions;

	try {
		state.settings.Token = "TEST_TOKEN";
		state.settings.GuildID = "guild";
		state.lastMessages = {
			"dc-news-outbound": "3EB0DD14CD06ABCE146147",
			"3EB0DD14CD06ABCE146147": "dc-news-outbound",
		};
		state.reactions = {};

		utils.discord.getGuild = async () => ({
			commands: { set: async () => {} },
		});
		utils.discord.getControlChannel = async () => ({ send: async () => {} });
		utils.discord.channelIdToJid = () => "120363123456789@newsletter";

		const waEvents = [];
		const waEv = new EventEmitter();
		waEv.on("discordDelete", (payload) => waEvents.push(payload));
		state.waClient = { ev: waEv };

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
		const discordHandler = await importDiscordHandler(
			"newsletter-message-delete-ignore-outbound-id",
		);
		state.dcClient = await discordHandler.start();

		const notices = [];
		fakeClient.emit("messageDelete", {
			id: "dc-news-outbound",
			channelId: "chan-1",
			webhookId: null,
			author: { id: "user-1" },
			channel: {
				send: async (value) => {
					notices.push(value);
				},
			},
		});
		await delay(0);

		assert.deepEqual(waEvents, []);
		assert.equal(state.lastMessages["dc-news-outbound"], undefined);
		assert.equal(state.lastMessages["3EB0DD14CD06ABCE146147"], undefined);
		assert.equal(notices.length, 1);
		assert.match(
			notices[0],
			/Please delete the message directly in WhatsApp on your phone/i,
		);
	} finally {
		utils.discord.getGuild = originalDiscordUtils.getGuild;
		utils.discord.getControlChannel = originalDiscordUtils.getControlChannel;
		utils.discord.channelIdToJid = originalDiscordUtils.channelIdToJid;

		state.settings.Token = originalSettings.Token;
		state.settings.GuildID = originalSettings.GuildID;

		state.dcClient = originalDcClient;
		state.waClient = originalWaClient;
		state.lastMessages = originalLastMessages;
		state.reactions = originalReactions;
		resetClientFactoryOverrides();
	}
});

test("Discord pin system messages are not forwarded to WhatsApp", async () => {
	const originalDiscordUtils = {
		getGuild: utils.discord.getGuild,
		getControlChannel: utils.discord.getControlChannel,
		channelIdToJid: utils.discord.channelIdToJid,
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
		utils.discord.channelIdToJid = () => "jid@s.whatsapp.net";

		const waEvents = [];
		const waEv = new EventEmitter();
		waEv.on("discordMessage", (payload) => waEvents.push(payload));
		state.waClient = { ev: waEv };

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

		const discordHandler = await importDiscordHandler("pin-system-message");
		state.dcClient = await discordHandler.start();

		const pinnedType = discordJs.MessageType.ChannelPinnedMessage;
		fakeClient.emit("messageCreate", {
			author: { id: "user-1" },
			applicationId: null,
			webhookId: null,
			type: pinnedType,
			channel: { id: "chan-1" },
		});
		await delay(0);

		assert.equal(waEvents.length, 0);
	} finally {
		utils.discord.getGuild = originalDiscordUtils.getGuild;
		utils.discord.getControlChannel = originalDiscordUtils.getControlChannel;
		utils.discord.channelIdToJid = originalDiscordUtils.channelIdToJid;

		state.settings.Token = originalSettings.Token;
		state.settings.GuildID = originalSettings.GuildID;
		state.settings.ControlChannelID = originalSettings.ControlChannelID;

		state.dcClient = originalDcClient;
		state.waClient = originalWaClient;
		resetClientFactoryOverrides();
	}
});

test("Discord raw forward metadata is emitted in discordMessage payload", async () => {
	const originalDiscordUtils = {
		getGuild: utils.discord.getGuild,
		getControlChannel: utils.discord.getControlChannel,
		channelIdToJid: utils.discord.channelIdToJid,
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
		utils.discord.channelIdToJid = () => "jid@s.whatsapp.net";

		const waEvents = [];
		const waEv = new EventEmitter();
		waEv.on("discordMessage", (payload) => waEvents.push(payload));
		state.waClient = { ev: waEv };

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

		const discordHandler = await importDiscordHandler("forward-raw-metadata");
		state.dcClient = await discordHandler.start();

		fakeClient.emit("raw", {
			t: "MESSAGE_CREATE",
			d: {
				id: "discord-msg-1",
				message_snapshots: [
					{
						id: "snap-1",
						message: {
							content: "forward snapshot body",
							attachments: [
								{
									id: "att-1",
									filename: "forward.png",
									content_type: "image/png",
									url: "https://cdn.discordapp.com/attachments/forward.png",
								},
							],
							embeds: [
								{
									title: "Forwarded Embed",
									description: "embed text",
									url: "https://example.com/embed",
									image: {
										proxy_url:
											"https://media.discordapp.net/attachments/forward-embed.png",
									},
								},
							],
						},
					},
				],
				message_reference: {
					channel_id: "source-channel",
					message_id: "source-message",
					guild_id: "source-guild",
				},
			},
		});
		fakeClient.emit("messageCreate", {
			id: "discord-msg-1",
			author: { id: "user-1", bot: false },
			applicationId: null,
			webhookId: null,
			type: 0,
			reference: {
				channelId: "source-channel",
				messageId: "source-message",
				guildId: "source-guild",
			},
			channel: { id: "chan-1" },
		});
		await delay(0);

		assert.equal(waEvents.length, 1);
		assert.deepEqual(waEvents[0].forwardContext, {
			isForwarded: true,
			sourceChannelId: "source-channel",
			sourceMessageId: "source-message",
			sourceGuildId: "source-guild",
		});
		assert.deepEqual(waEvents[0].message.wa2dcForwardSnapshot, {
			content: "forward snapshot body",
			attachments: [
				{
					url: "https://cdn.discordapp.com/attachments/forward.png",
					name: "forward.png",
					contentType: "image/png",
				},
			],
			embeds: [
				{
					title: "Forwarded Embed",
					description: "embed text",
					url: "https://example.com/embed",
					image: {
						proxyURL:
							"https://media.discordapp.net/attachments/forward-embed.png",
					},
				},
			],
		});
	} finally {
		utils.discord.getGuild = originalDiscordUtils.getGuild;
		utils.discord.getControlChannel = originalDiscordUtils.getControlChannel;
		utils.discord.channelIdToJid = originalDiscordUtils.channelIdToJid;

		state.settings.Token = originalSettings.Token;
		state.settings.GuildID = originalSettings.GuildID;
		state.settings.ControlChannelID = originalSettings.ControlChannelID;

		state.dcClient = originalDcClient;
		state.waClient = originalWaClient;
		resetClientFactoryOverrides();
	}
});

test("WhatsApp forwarded message includes bridged source channel and jump link when resolvable", async () => {
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
	};
	const originalLastMessages = state.lastMessages;
	const originalDcClient = state.dcClient;

	try {
		state.settings.Token = "TEST_TOKEN";
		state.settings.GuildID = "guild";
		state.settings.oneWay = 0b11;
		state.lastMessages = {};

		utils.discord.getGuild = async () => ({
			commands: { set: async () => {} },
		});
		utils.discord.getControlChannel = async () => ({ send: async () => {} });
		utils.discord.getOrCreateChannel = async (jid) => ({
			id: `wh-${jid}`,
			token: "token",
			channel: { type: "GUILD_TEXT" },
			channelId:
				jid === "source@s.whatsapp.net" ? "source-channel" : "target-channel",
		});

		const sent = [];
		utils.discord.safeWebhookSend = async (webhook, args) => {
			const messageId =
				sent.length === 0 ? "dc-source" : `dc-${sent.length + 1}`;
			sent.push({ webhook, args, messageId });
			return {
				id: messageId,
				channel: { type: "GUILD_TEXT" },
				channelId: webhook.channelId,
				guildId: "guild",
				url: `https://discord.com/channels/guild/${webhook.channelId}/${messageId}`,
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

		const fakeClient = new FakeDiscordClient();
		setClientFactoryOverrides({ createDiscordClient: () => fakeClient });
		const discordHandler = await importDiscordHandler(
			"wa-forwarded-source-link",
		);
		state.dcClient = await discordHandler.start();

		fakeClient.emit("whatsappMessage", {
			id: "wa-source",
			name: "Alice",
			content: "source text",
			channelJid: "source@s.whatsapp.net",
			file: null,
			quote: null,
			profilePic: null,
			isGroup: false,
			isForwarded: false,
			isEdit: false,
		});
		await delay(0);

		fakeClient.emit("whatsappMessage", {
			id: "wa-forward",
			name: "Bob",
			content: "forward body",
			channelJid: "target@s.whatsapp.net",
			file: null,
			quote: { id: "wa-source", name: "Alice", content: "source text" },
			profilePic: null,
			isGroup: false,
			isForwarded: true,
			isEdit: false,
		});
		await delay(0);

		assert.equal(sent.length, 2);
		const forwardedContent = sent[1]?.args?.content || "";
		assert.ok(forwardedContent.includes("Forwarded"));
		assert.ok(forwardedContent.includes("Source: <#source-channel>"));
		assert.ok(
			forwardedContent.includes(
				"Jump: https://discord.com/channels/guild/source-channel/dc-source",
			),
		);
	} finally {
		utils.discord.getGuild = originalDiscordUtils.getGuild;
		utils.discord.getControlChannel = originalDiscordUtils.getControlChannel;
		utils.discord.getOrCreateChannel = originalDiscordUtils.getOrCreateChannel;
		utils.discord.safeWebhookSend = originalDiscordUtils.safeWebhookSend;

		state.settings.Token = originalSettings.Token;
		state.settings.GuildID = originalSettings.GuildID;
		state.settings.oneWay = originalSettings.oneWay;
		state.lastMessages = originalLastMessages;

		state.dcClient = originalDcClient;
		resetClientFactoryOverrides();
	}
});

test("WhatsApp forwarded message without resolvable source keeps clean forwarded text", async () => {
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
	};
	const originalLastMessages = state.lastMessages;
	const originalDcClient = state.dcClient;

	try {
		state.settings.Token = "TEST_TOKEN";
		state.settings.GuildID = "guild";
		state.settings.oneWay = 0b11;
		state.lastMessages = {};

		utils.discord.getGuild = async () => ({
			commands: { set: async () => {} },
		});
		utils.discord.getControlChannel = async () => ({ send: async () => {} });
		utils.discord.getOrCreateChannel = async () => ({
			id: "wh-1",
			token: "token",
			channel: { type: "GUILD_TEXT" },
			channelId: "target-channel",
		});

		const sent = [];
		utils.discord.safeWebhookSend = async (_webhook, args) => {
			sent.push(args);
			return {
				id: `dc-${sent.length}`,
				channel: { type: "GUILD_TEXT" },
				channelId: "target-channel",
				guildId: "guild",
				url: `https://discord.com/channels/guild/target-channel/dc-${sent.length}`,
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

		const fakeClient = new FakeDiscordClient();
		setClientFactoryOverrides({ createDiscordClient: () => fakeClient });
		const discordHandler = await importDiscordHandler("wa-forwarded-no-source");
		state.dcClient = await discordHandler.start();

		fakeClient.emit("whatsappMessage", {
			id: "wa-forward-only",
			name: "Bob",
			content: "forward body",
			channelJid: "target@s.whatsapp.net",
			file: null,
			quote: { id: "wa-unknown" },
			profilePic: null,
			isGroup: false,
			isForwarded: true,
			isEdit: false,
		});
		await delay(0);

		assert.equal(sent.length, 1);
		const forwardedContent = sent[0]?.content || "";
		assert.ok(forwardedContent.includes("Forwarded"));
		assert.equal(forwardedContent.includes("Source:"), false);
		assert.equal(forwardedContent.includes("Jump:"), false);
	} finally {
		utils.discord.getGuild = originalDiscordUtils.getGuild;
		utils.discord.getControlChannel = originalDiscordUtils.getControlChannel;
		utils.discord.getOrCreateChannel = originalDiscordUtils.getOrCreateChannel;
		utils.discord.safeWebhookSend = originalDiscordUtils.safeWebhookSend;

		state.settings.Token = originalSettings.Token;
		state.settings.GuildID = originalSettings.GuildID;
		state.settings.oneWay = originalSettings.oneWay;
		state.lastMessages = originalLastMessages;

		state.dcClient = originalDcClient;
		resetClientFactoryOverrides();
	}
});

test("WhatsApp forwarded message links source channel when quote sourceJid is bridged", async () => {
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
	};
	const originalChats = { ...state.chats };
	const originalLastMessages = state.lastMessages;
	const originalDcClient = state.dcClient;

	try {
		state.settings.Token = "TEST_TOKEN";
		state.settings.GuildID = "guild";
		state.settings.oneWay = 0b11;
		state.lastMessages = {};
		restoreObject(state.chats, {
			"source@s.whatsapp.net": {
				channelId: "source-channel",
				id: "wh-source",
				token: "tok",
				type: 0,
			},
			"target@s.whatsapp.net": {
				channelId: "target-channel",
				id: "wh-target",
				token: "tok",
				type: 0,
			},
		});

		utils.discord.getGuild = async () => ({
			commands: { set: async () => {} },
		});
		utils.discord.getControlChannel = async () => ({ send: async () => {} });
		utils.discord.getOrCreateChannel = async () => ({
			id: "wh-1",
			token: "token",
			channel: { type: "GUILD_TEXT" },
			channelId: "target-channel",
		});

		const sent = [];
		utils.discord.safeWebhookSend = async (_webhook, args) => {
			sent.push(args);
			return {
				id: `dc-${sent.length}`,
				channel: { type: "GUILD_TEXT" },
				channelId: "target-channel",
				guildId: "guild",
				url: `https://discord.com/channels/guild/target-channel/dc-${sent.length}`,
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

		const fakeClient = new FakeDiscordClient();
		setClientFactoryOverrides({ createDiscordClient: () => fakeClient });
		const discordHandler = await importDiscordHandler("wa-forwarded-sourcejid");
		state.dcClient = await discordHandler.start();

		fakeClient.emit("whatsappMessage", {
			id: "wa-forward-sourcejid",
			name: "Bob",
			content: "forward body",
			channelJid: "target@s.whatsapp.net",
			file: null,
			quote: { id: "wa-unknown", sourceJid: "source@s.whatsapp.net" },
			profilePic: null,
			isGroup: false,
			isForwarded: true,
			isEdit: false,
		});
		await delay(0);

		assert.equal(sent.length, 1);
		const forwardedContent = sent[0]?.content || "";
		assert.ok(forwardedContent.includes("Forwarded"));
		assert.ok(forwardedContent.includes("Source: <#source-channel>"));
		assert.equal(forwardedContent.includes("Jump:"), false);
	} finally {
		utils.discord.getGuild = originalDiscordUtils.getGuild;
		utils.discord.getControlChannel = originalDiscordUtils.getControlChannel;
		utils.discord.getOrCreateChannel = originalDiscordUtils.getOrCreateChannel;
		utils.discord.safeWebhookSend = originalDiscordUtils.safeWebhookSend;

		state.settings.Token = originalSettings.Token;
		state.settings.GuildID = originalSettings.GuildID;
		state.settings.oneWay = originalSettings.oneWay;
		restoreObject(state.chats, originalChats);
		state.lastMessages = originalLastMessages;

		state.dcClient = originalDcClient;
		resetClientFactoryOverrides();
	}
});

test("WhatsApp forwarded message links source channel when quote sourceJid resolves from LID to PN", async () => {
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
	};
	const originalChats = { ...state.chats };
	const originalLastMessages = state.lastMessages;
	const originalDcClient = state.dcClient;
	const originalWaClient = state.waClient;

	try {
		state.settings.Token = "TEST_TOKEN";
		state.settings.GuildID = "guild";
		state.settings.oneWay = 0b11;
		state.lastMessages = {};
		restoreObject(state.chats, {
			"14155550123@s.whatsapp.net": {
				channelId: "source-channel",
				id: "wh-source",
				token: "tok",
				type: 0,
			},
			"target@s.whatsapp.net": {
				channelId: "target-channel",
				id: "wh-target",
				token: "tok",
				type: 0,
			},
		});
		state.waClient = {
			signalRepository: {
				lidMapping: {
					getPNForLID: async (jid) =>
						jid === "161040050426060@lid" ? "14155550123@s.whatsapp.net" : null,
				},
			},
		};

		utils.discord.getGuild = async () => ({
			commands: { set: async () => {} },
		});
		utils.discord.getControlChannel = async () => ({ send: async () => {} });
		utils.discord.getOrCreateChannel = async () => ({
			id: "wh-1",
			token: "token",
			channel: { type: "GUILD_TEXT" },
			channelId: "target-channel",
		});

		const sent = [];
		utils.discord.safeWebhookSend = async (_webhook, args) => {
			sent.push(args);
			return {
				id: `dc-${sent.length}`,
				channel: { type: "GUILD_TEXT" },
				channelId: "target-channel",
				guildId: "guild",
				url: `https://discord.com/channels/guild/target-channel/dc-${sent.length}`,
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

		const fakeClient = new FakeDiscordClient();
		setClientFactoryOverrides({ createDiscordClient: () => fakeClient });
		const discordHandler = await importDiscordHandler(
			"wa-forwarded-sourcejid-lid",
		);
		state.dcClient = await discordHandler.start();

		fakeClient.emit("whatsappMessage", {
			id: "wa-forward-sourcejid-lid",
			name: "Bob",
			content: "forward body",
			channelJid: "target@s.whatsapp.net",
			file: null,
			quote: { id: "wa-unknown", sourceJid: "161040050426060@lid" },
			profilePic: null,
			isGroup: false,
			isForwarded: true,
			isEdit: false,
		});
		await delay(0);

		assert.equal(sent.length, 1);
		const forwardedContent = sent[0]?.content || "";
		assert.ok(forwardedContent.includes("Forwarded"));
		assert.ok(forwardedContent.includes("Source: <#source-channel>"));
		assert.equal(forwardedContent.includes("Jump:"), false);
	} finally {
		utils.discord.getGuild = originalDiscordUtils.getGuild;
		utils.discord.getControlChannel = originalDiscordUtils.getControlChannel;
		utils.discord.getOrCreateChannel = originalDiscordUtils.getOrCreateChannel;
		utils.discord.safeWebhookSend = originalDiscordUtils.safeWebhookSend;

		state.settings.Token = originalSettings.Token;
		state.settings.GuildID = originalSettings.GuildID;
		state.settings.oneWay = originalSettings.oneWay;
		restoreObject(state.chats, originalChats);
		state.lastMessages = originalLastMessages;
		state.waClient = originalWaClient;

		state.dcClient = originalDcClient;
		resetClientFactoryOverrides();
	}
});

test("Discord bot messages can be blocked from forwarding to WhatsApp", async () => {
	const originalDiscordUtils = {
		getGuild: utils.discord.getGuild,
		getControlChannel: utils.discord.getControlChannel,
		channelIdToJid: utils.discord.channelIdToJid,
	};
	const originalSettings = {
		Token: state.settings.Token,
		GuildID: state.settings.GuildID,
		ControlChannelID: state.settings.ControlChannelID,
		redirectBots: state.settings.redirectBots,
		redirectWebhooks: state.settings.redirectWebhooks,
	};
	const originalDcClient = state.dcClient;
	const originalWaClient = state.waClient;

	try {
		state.settings.Token = "TEST_TOKEN";
		state.settings.GuildID = "guild";
		state.settings.ControlChannelID = "control";
		state.settings.redirectBots = false;
		state.settings.redirectWebhooks = true;

		utils.discord.getGuild = async () => ({
			commands: { set: async () => {} },
		});
		utils.discord.getControlChannel = async () => ({ send: async () => {} });
		utils.discord.channelIdToJid = () => "jid@s.whatsapp.net";

		const waEvents = [];
		const waEv = new EventEmitter();
		waEv.on("discordMessage", (payload) => waEvents.push(payload));
		state.waClient = { ev: waEv };

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

		const discordHandler = await importDiscordHandler(
			"bot-filter-message-create",
		);
		state.dcClient = await discordHandler.start();

		fakeClient.emit("messageCreate", {
			author: { id: "bot-2", bot: true },
			applicationId: null,
			webhookId: null,
			channel: { id: "chan-1" },
		});
		await delay(0);
		assert.equal(waEvents.length, 0);

		fakeClient.emit("messageCreate", {
			author: { id: "user-1", bot: false },
			applicationId: null,
			webhookId: null,
			channel: { id: "chan-1" },
		});
		await delay(0);
		assert.equal(waEvents.length, 1);

		fakeClient.emit("messageCreate", {
			author: { id: "bot-3", bot: true },
			applicationId: null,
			webhookId: "wh-1",
			channel: { id: "chan-1" },
		});
		await delay(0);
		assert.equal(waEvents.length, 2);
	} finally {
		utils.discord.getGuild = originalDiscordUtils.getGuild;
		utils.discord.getControlChannel = originalDiscordUtils.getControlChannel;
		utils.discord.channelIdToJid = originalDiscordUtils.channelIdToJid;

		state.settings.Token = originalSettings.Token;
		state.settings.GuildID = originalSettings.GuildID;
		state.settings.ControlChannelID = originalSettings.ControlChannelID;
		state.settings.redirectBots = originalSettings.redirectBots;
		state.settings.redirectWebhooks = originalSettings.redirectWebhooks;

		state.dcClient = originalDcClient;
		state.waClient = originalWaClient;
		resetClientFactoryOverrides();
	}
});

test("Discord broadcast/crosspost webhooks require redirectannouncements when redirectWebhooks is disabled", async () => {
	const originalDiscordUtils = {
		getGuild: utils.discord.getGuild,
		getControlChannel: utils.discord.getControlChannel,
		channelIdToJid: utils.discord.channelIdToJid,
	};
	const originalSettings = {
		Token: state.settings.Token,
		GuildID: state.settings.GuildID,
		ControlChannelID: state.settings.ControlChannelID,
		redirectBots: state.settings.redirectBots,
		redirectWebhooks: state.settings.redirectWebhooks,
		redirectAnnouncementWebhooks: state.settings.redirectAnnouncementWebhooks,
	};
	const originalChats = { ...state.chats };
	const originalDcClient = state.dcClient;
	const originalWaClient = state.waClient;

	try {
		state.settings.Token = "TEST_TOKEN";
		state.settings.GuildID = "guild";
		state.settings.ControlChannelID = "control";
		state.settings.redirectBots = false;
		state.settings.redirectWebhooks = false;
		state.settings.redirectAnnouncementWebhooks = false;
		restoreObject(state.chats, {
			"jid@s.whatsapp.net": {
				id: "bridge-wh-1",
				type: 1,
				token: "tok",
				channelId: "chan-1",
			},
		});

		utils.discord.getGuild = async () => ({
			commands: { set: async () => {} },
		});
		utils.discord.getControlChannel = async () => ({ send: async () => {} });
		utils.discord.channelIdToJid = () => "jid@s.whatsapp.net";

		const waEvents = [];
		const waEv = new EventEmitter();
		waEv.on("discordMessage", (payload) => waEvents.push(payload));
		state.waClient = { ev: waEv };

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

		const discordHandler = await importDiscordHandler(
			"broadcast-webhook-forward",
		);
		state.dcClient = await discordHandler.start();
		fakeClient.emit("messageCreate", {
			id: "bridge-webhook-msg",
			author: { id: "bot-3", bot: true },
			applicationId: null,
			webhookId: "bridge-wh-1",
			type: "DEFAULT",
			flags: { bitfield: 1 },
			channel: { id: "chan-1", type: "GUILD_TEXT" },
		});
		await delay(0);
		assert.equal(waEvents.length, 0);
		fakeClient.emit("messageCreate", {
			id: "external-webhook-msg",
			author: { id: "bot-4", bot: true },
			applicationId: null,
			webhookId: "external-news-webhook",
			type: "DEFAULT",
			flags: { bitfield: 1 },
			channel: { id: "chan-1", type: "GUILD_TEXT" },
		});
		await delay(0);
		assert.equal(waEvents.length, 0);
		state.settings.redirectAnnouncementWebhooks = true;
		fakeClient.emit("messageCreate", {
			id: "external-webhook-msg-2",
			author: { id: "bot-4", bot: true },
			applicationId: null,
			webhookId: "external-news-webhook",
			type: "DEFAULT",
			flags: { bitfield: 1 },
			channel: { id: "chan-1", type: "GUILD_TEXT" },
		});
		await delay(0);
		assert.equal(waEvents.length, 1);
	} finally {
		utils.discord.getGuild = originalDiscordUtils.getGuild;
		utils.discord.getControlChannel = originalDiscordUtils.getControlChannel;
		utils.discord.channelIdToJid = originalDiscordUtils.channelIdToJid;

		state.settings.Token = originalSettings.Token;
		state.settings.GuildID = originalSettings.GuildID;
		state.settings.ControlChannelID = originalSettings.ControlChannelID;
		state.settings.redirectBots = originalSettings.redirectBots;
		state.settings.redirectWebhooks = originalSettings.redirectWebhooks;
		state.settings.redirectAnnouncementWebhooks =
			originalSettings.redirectAnnouncementWebhooks;
		restoreObject(state.chats, originalChats);

		state.dcClient = originalDcClient;
		state.waClient = originalWaClient;
		resetClientFactoryOverrides();
	}
});

test("Unbridged bot deletes do not spam errors when redirectBots is disabled", async () => {
	const originalDiscordUtils = {
		getGuild: utils.discord.getGuild,
		getControlChannel: utils.discord.getControlChannel,
		channelIdToJid: utils.discord.channelIdToJid,
	};
	const originalSettings = {
		Token: state.settings.Token,
		GuildID: state.settings.GuildID,
		redirectBots: state.settings.redirectBots,
	};
	const originalDcClient = state.dcClient;
	const originalWaClient = state.waClient;
	const originalLastMessages = state.lastMessages;

	try {
		state.settings.Token = "TEST_TOKEN";
		state.settings.GuildID = "guild";
		state.settings.redirectBots = false;
		state.lastMessages = {};

		utils.discord.getGuild = async () => ({
			commands: { set: async () => {} },
		});
		utils.discord.getControlChannel = async () => ({ send: async () => {} });
		utils.discord.channelIdToJid = () => "jid@s.whatsapp.net";

		const waEv = new EventEmitter();
		state.waClient = { ev: waEv };

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

		const discordHandler = await importDiscordHandler(
			"bot-filter-message-delete",
		);
		state.dcClient = await discordHandler.start();

		const sends = [];
		fakeClient.emit("messageDelete", {
			id: "dc-1",
			channelId: "chan-1",
			webhookId: null,
			author: { id: "bot-2", bot: true },
			channel: { send: async (text) => sends.push(text) },
		});
		await delay(0);

		assert.equal(sends.length, 0);
	} finally {
		utils.discord.getGuild = originalDiscordUtils.getGuild;
		utils.discord.getControlChannel = originalDiscordUtils.getControlChannel;
		utils.discord.channelIdToJid = originalDiscordUtils.channelIdToJid;

		state.settings.Token = originalSettings.Token;
		state.settings.GuildID = originalSettings.GuildID;
		state.settings.redirectBots = originalSettings.redirectBots;

		state.dcClient = originalDcClient;
		state.waClient = originalWaClient;
		state.lastMessages = originalLastMessages;
		resetClientFactoryOverrides();
	}
});

test("Discord messageUpdate emits discordEdit for bridged messages", async () => {
	const originalDiscordUtils = {
		getGuild: utils.discord.getGuild,
		getControlChannel: utils.discord.getControlChannel,
		channelIdToJid: utils.discord.channelIdToJid,
	};
	const originalSettings = {
		Token: state.settings.Token,
		GuildID: state.settings.GuildID,
	};
	const originalDcClient = state.dcClient;
	const originalWaClient = state.waClient;
	const originalLastMessages = state.lastMessages;

	try {
		state.settings.Token = "TEST_TOKEN";
		state.settings.GuildID = "guild";
		state.lastMessages = { "dc-edit": "wa-edit" };

		utils.discord.getGuild = async () => ({
			commands: { set: async () => {} },
		});
		utils.discord.getControlChannel = async () => ({ send: async () => {} });
		utils.discord.channelIdToJid = () => "jid@s.whatsapp.net";

		const waEvents = [];
		const waEv = new EventEmitter();
		waEv.on("discordEdit", (payload) => waEvents.push(payload));
		state.waClient = { ev: waEv };

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
		const discordHandler = await importDiscordHandler("edit");
		state.dcClient = await discordHandler.start();

		fakeClient.emit(
			"messageUpdate",
			{ pinned: false },
			{
				id: "dc-edit",
				channelId: "chan-1",
				webhookId: null,
				partial: false,
				pinned: false,
				editedTimestamp: Date.now(),
				content: "updated",
				channel: { send: async () => {} },
			},
		);
		await delay(0);

		assert.equal(waEvents.length, 1);
		assert.equal(waEvents[0].jid, "jid@s.whatsapp.net");
		assert.equal(waEvents[0].message.id, "dc-edit");
	} finally {
		utils.discord.getGuild = originalDiscordUtils.getGuild;
		utils.discord.getControlChannel = originalDiscordUtils.getControlChannel;
		utils.discord.channelIdToJid = originalDiscordUtils.channelIdToJid;

		state.settings.Token = originalSettings.Token;
		state.settings.GuildID = originalSettings.GuildID;

		state.dcClient = originalDcClient;
		state.waClient = originalWaClient;
		state.lastMessages = originalLastMessages;
		resetClientFactoryOverrides();
	}
});

test("Discord pin changes sync to WhatsApp via waClient.sendMessage", async () => {
	const originalSetTimeout = global.setTimeout;
	const originalDiscordUtils = {
		getGuild: utils.discord.getGuild,
		getControlChannel: utils.discord.getControlChannel,
		channelIdToJid: utils.discord.channelIdToJid,
	};
	const originalSettings = {
		Token: state.settings.Token,
		GuildID: state.settings.GuildID,
	};
	const originalDcClient = state.dcClient;
	const originalWaClient = state.waClient;
	const originalLastMessages = state.lastMessages;
	const originalSentPins = new Set(state.sentPins);

	try {
		global.setTimeout = (fn, ms, ...args) => {
			const handle = originalSetTimeout(fn, ms, ...args);
			if (handle && typeof handle.unref === "function") {
				handle.unref();
			}
			return handle;
		};

		state.settings.Token = "TEST_TOKEN";
		state.settings.GuildID = "guild";
		state.lastMessages = { "dc-pin": "wa-pin" };
		state.sentPins.clear();

		utils.discord.getGuild = async () => ({
			commands: { set: async () => {} },
		});
		utils.discord.getControlChannel = async () => ({ send: async () => {} });
		utils.discord.channelIdToJid = () => "jid@s.whatsapp.net";

		const sendCalls = [];
		state.waClient = {
			ev: new EventEmitter(),
			async sendMessage(jid, content) {
				sendCalls.push({ jid, content });
				return {};
			},
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
		const discordHandler = await importDiscordHandler("pin");
		state.dcClient = await discordHandler.start();

		fakeClient.emit(
			"messageUpdate",
			{ pinned: false },
			{
				id: "dc-pin",
				channelId: "chan-1",
				webhookId: null,
				partial: false,
				pinned: true,
				editedTimestamp: null,
				content: "",
				channel: { send: async () => {} },
			},
		);
		await delay(0);

		assert.equal(sendCalls.length, 1);
		assert.equal(sendCalls[0].jid, "jid@s.whatsapp.net");
		assert.equal(sendCalls[0].content.type, 1);
		assert.equal(sendCalls[0].content.pin.id, "wa-pin");
		assert.equal(state.sentPins.has("wa-pin"), true);
	} finally {
		global.setTimeout = originalSetTimeout;

		utils.discord.getGuild = originalDiscordUtils.getGuild;
		utils.discord.getControlChannel = originalDiscordUtils.getControlChannel;
		utils.discord.channelIdToJid = originalDiscordUtils.channelIdToJid;

		state.settings.Token = originalSettings.Token;
		state.settings.GuildID = originalSettings.GuildID;

		state.dcClient = originalDcClient;
		state.waClient = originalWaClient;
		state.lastMessages = originalLastMessages;
		state.sentPins.clear();
		originalSentPins.forEach((id) => {
			state.sentPins.add(id);
		});
		resetClientFactoryOverrides();
	}
});

test("Discord reactions emit discordReaction towards WhatsApp", async () => {
	const originalDiscordUtils = {
		getGuild: utils.discord.getGuild,
		getControlChannel: utils.discord.getControlChannel,
		channelIdToJid: utils.discord.channelIdToJid,
	};
	const originalSettings = {
		Token: state.settings.Token,
		GuildID: state.settings.GuildID,
	};
	const originalDcClient = state.dcClient;
	const originalWaClient = state.waClient;
	const originalLastMessages = state.lastMessages;

	try {
		state.settings.Token = "TEST_TOKEN";
		state.settings.GuildID = "guild";
		state.lastMessages = { "dc-react": "wa-react" };

		utils.discord.getGuild = async () => ({
			commands: { set: async () => {} },
		});
		utils.discord.getControlChannel = async () => ({ send: async () => {} });
		utils.discord.channelIdToJid = () => "jid@s.whatsapp.net";

		const waEvents = [];
		const waEv = new EventEmitter();
		waEv.on("discordReaction", (payload) => waEvents.push(payload));
		state.waClient = { ev: waEv };

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
		const discordHandler = await importDiscordHandler("reaction");
		state.dcClient = await discordHandler.start();

		fakeClient.emit(
			"messageReactionAdd",
			{
				emoji: { name: "🔥" },
				message: {
					id: "dc-react",
					channel: { id: "chan-1", send: async () => {} },
				},
			},
			{ id: "user-1" },
		);

		await delay(0);

		assert.equal(waEvents.length, 1);
		assert.equal(waEvents[0].jid, "jid@s.whatsapp.net");
		assert.equal(waEvents[0].removed, false);
		assert.equal(waEvents[0].reaction.emoji.name, "🔥");
	} finally {
		utils.discord.getGuild = originalDiscordUtils.getGuild;
		utils.discord.getControlChannel = originalDiscordUtils.getControlChannel;
		utils.discord.channelIdToJid = originalDiscordUtils.channelIdToJid;

		state.settings.Token = originalSettings.Token;
		state.settings.GuildID = originalSettings.GuildID;

		state.dcClient = originalDcClient;
		state.waClient = originalWaClient;
		state.lastMessages = originalLastMessages;
		resetClientFactoryOverrides();
	}
});

test("Discord newsletter reactions require a mapped server_id before emitting", async () => {
	const originalDiscordUtils = {
		getGuild: utils.discord.getGuild,
		getControlChannel: utils.discord.getControlChannel,
		channelIdToJid: utils.discord.channelIdToJid,
	};
	const originalSettings = {
		Token: state.settings.Token,
		GuildID: state.settings.GuildID,
	};
	const originalDcClient = state.dcClient;
	const originalWaClient = state.waClient;
	const originalLastMessages = state.lastMessages;
	const originalReactions = state.reactions;

	try {
		state.settings.Token = "TEST_TOKEN";
		state.settings.GuildID = "guild";
		state.lastMessages = {};
		state.reactions = {};

		utils.discord.getGuild = async () => ({
			commands: { set: async () => {} },
		});
		utils.discord.getControlChannel = async () => ({ send: async () => {} });
		utils.discord.channelIdToJid = () => "120363123456789@newsletter";

		const waEvents = [];
		const waEv = new EventEmitter();
		waEv.on("discordReaction", (payload) => waEvents.push(payload));
		state.waClient = { ev: waEv, user: { id: "bridge@s.whatsapp.net" } };

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
		const discordHandler = await importDiscordHandler(
			"newsletter-reaction-wait-server-id",
		);
		state.dcClient = await discordHandler.start();

		fakeClient.emit(
			"messageReactionAdd",
			{
				emoji: { name: "🔥" },
				message: {
					id: "dc-news-react-delayed",
					channel: { id: "chan-1", send: async () => {} },
					webhookId: null,
					author: { id: "user-1", bot: false },
					reactions: { cache: new Map() },
				},
			},
			{ id: "user-1" },
		);

		await delay(200);

		assert.equal(waEvents.length, 0);
	} finally {
		utils.discord.getGuild = originalDiscordUtils.getGuild;
		utils.discord.getControlChannel = originalDiscordUtils.getControlChannel;
		utils.discord.channelIdToJid = originalDiscordUtils.channelIdToJid;

		state.settings.Token = originalSettings.Token;
		state.settings.GuildID = originalSettings.GuildID;

		state.dcClient = originalDcClient;
		state.waClient = originalWaClient;
		state.lastMessages = originalLastMessages;
		state.reactions = originalReactions;
		resetClientFactoryOverrides();
	}
});
