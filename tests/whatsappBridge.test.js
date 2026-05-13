import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { proto, WAMessageStatus } from "@whiskeysockets/baileys";

import {
	resetClientFactoryOverrides,
	setClientFactoryOverrides,
} from "../src/clientFactories.js";
import {
	resetImageLibTestOverrides,
	setImageLibTestOverrides,
} from "../src/imageLibs.js";
import messageStore from "../src/messageStore.js";
import { resetNewsletterBridgeState } from "../src/newsletterBridge.js";
import state from "../src/state.js";
import utils from "../src/utils.js";
import initIsolatedStorage from "./helpers/initIsolatedStorage.js";

await initIsolatedStorage(import.meta.url);

const snapshotObject = (value) => ({ ...value });
const restoreObject = (target, snapshot) => {
	Object.keys(target).forEach((key) => {
		delete target[key];
	});
	Object.assign(target, snapshot);
};
const snapshotSet = (value) => Array.from(value);
const restoreSet = (target, snapshot) => {
	target.clear();
	snapshot.forEach((entry) => {
		target.add(entry);
	});
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
const extractUrls = (value = "") =>
	String(value).match(/https?:\/\/[^\s>]+/gu) || [];

const setupWhatsAppHarness = async ({
	oneWay = 0b11,
	inWhitelist = () => true,
	sentAfterStart = () => true,
	getMessageType = () => "conversation",
	formatJid = (jid) => jid,
} = {}) => {
	const originalLogger = state.logger;
	const originalOneWay = state.settings.oneWay;
	const originalMirrorWAStatuses = state.settings.MirrorWAStatuses;
	const originalNewsletterMediaUrlFallback =
		state.settings.NewsletterMediaUrlFallback;
	const originalLastMessages = state.lastMessages;
	const originalStartTime = state.startTime;
	const originalSentMessages = snapshotSet(state.sentMessages);
	const originalSentReactions = snapshotSet(state.sentReactions);
	const originalSentPins = snapshotSet(state.sentPins);
	const originalChats = snapshotObject(state.chats);
	const originalContacts = snapshotObject(state.contacts);
	const originalDcClient = state.dcClient;
	const originalWaClient = state.waClient;
	const originalGetControlChannel = utils.discord.getControlChannel;
	const originalWhatsappUtils = utils.whatsapp;

	try {
		state.logger = { info() {}, error() {}, warn() {}, debug() {} };
		state.settings.oneWay = oneWay;
		state.settings.NewsletterMediaUrlFallback = false;
		state.lastMessages = {};
		state.startTime = 0;
		state.sentMessages.clear();
		state.sentReactions.clear();
		state.sentPins.clear();
		resetNewsletterBridgeState();
		restoreObject(state.chats, {});
		restoreObject(state.contacts, {});

		const controlMessages = [];
		const controlChannel = {
			send: async (msg) => {
				controlMessages.push(msg);
			},
		};
		utils.discord.getControlChannel = async () => controlChannel;

		utils.whatsapp = {
			_profilePicsCache: {},
			sendQR() {},
			getId: (...args) => originalWhatsappUtils.getId(...args),
			getMessageType: (...args) => getMessageType(...args),
			inWhitelist: (...args) => inWhitelist(...args),
			sentAfterStart: (...args) => sentAfterStart(...args),
			isStatusBroadcast: (raw) => raw?.key?.remoteJid === "status@broadcast",
			getMessage: (raw) => ["conversation", { text: raw.message }],
			getSenderName: async () => "Tester",
			getContent: async (message) => ({
				content: message.text,
				discordMentions: [],
			}),
			getQuote: async () => null,
			getFile: async () => null,
			getProfilePic: async () => null,
			getChannelJid: async (raw) => raw.key.remoteJid,
			isGroup: () => false,
			isForwarded: () => false,
			getTimestamp: () => Date.now(),
			formatJid: (...args) => formatJid(...args),
			migrateLegacyJid: () => {},
			isLidJid: () => true,
			toJid: (value) => value,
			deleteSession: async () => {},
			getSenderJid: async (raw) => raw.key.remoteJid,
			getMentionedJids: (...args) =>
				originalWhatsappUtils.getMentionedJids(...args),
			convertDiscordFormatting: (text) => text,
			createQuoteMessage: async () => null,
			createDocumentContent: () => ({}),
			jidToName: (jid) => jid,
			applyDiscordMentionLinks: (...args) =>
				originalWhatsappUtils.applyDiscordMentionLinks(...args),
			preferMentionJidForChat: (...args) =>
				originalWhatsappUtils.preferMentionJidForChat(...args),
			updateContacts() {},
			generateLinkPreview: async () => null,
		};

		const forwarded = {
			messages: [],
			reactions: [],
			deletes: [],
			pins: [],
		};
		state.dcClient = new EventEmitter();
		state.dcClient.on("whatsappMessage", (payload) =>
			forwarded.messages.push(payload),
		);
		state.dcClient.on("whatsappReaction", (payload) =>
			forwarded.reactions.push(payload),
		);
		state.dcClient.on("whatsappDelete", (payload) =>
			forwarded.deletes.push(payload),
		);
		state.dcClient.on("whatsappPin", (payload) => forwarded.pins.push(payload));

		class FakeWhatsAppClient {
			constructor() {
				this.ev = new EventEmitter();
				this.sendCalls = [];
				this.relayCalls = [];
				this.newsletterReactionCalls = [];
				this._sendCounter = 0;
				this.contacts = {};
				this.signalRepository = {};
				this.user = { id: "15550001111@s.whatsapp.net" };
				this.ws = new EventEmitter();
			}

			async sendMessage(jid, content, options) {
				this.sendCalls.push({ jid, content, options });
				this._sendCounter += 1;
				const key = { id: `sent-${this._sendCounter}`, remoteJid: jid };
				if (typeof jid === "string" && jid.endsWith("@newsletter")) {
					key.server_id = `server-${this._sendCounter}`;
				}
				return { key };
			}

			async newsletterReactMessage(jid, serverId, reaction) {
				this.newsletterReactionCalls.push({ jid, serverId, reaction });
			}

			async relayMessage(jid, message, options = {}) {
				this.relayCalls.push({ jid, message, options });
				return options.messageId || `relay-${this.relayCalls.length}`;
			}

			async groupFetchAllParticipating() {
				return {};
			}

			async profilePictureUrl() {
				return null;
			}
		}

		const fakeClient = new FakeWhatsAppClient();
		setClientFactoryOverrides({
			createWhatsAppClient: () => fakeClient,
			getBaileysVersion: async () => ({ version: [1, 0, 0] }),
		});

		const { connectToWhatsApp } = await import("../src/whatsappHandler.js");
		await connectToWhatsApp();

		fakeClient.ev.emit("connection.update", { connection: "open" });

		const cleanup = () => {
			state.logger = originalLogger;
			state.settings.oneWay = originalOneWay;
			state.settings.MirrorWAStatuses = originalMirrorWAStatuses;
			state.settings.NewsletterMediaUrlFallback =
				originalNewsletterMediaUrlFallback;
			state.lastMessages = originalLastMessages;
			state.startTime = originalStartTime;
			restoreSet(state.sentMessages, originalSentMessages);
			restoreSet(state.sentReactions, originalSentReactions);
			restoreSet(state.sentPins, originalSentPins);
			resetNewsletterBridgeState();
			restoreObject(state.chats, originalChats);
			restoreObject(state.contacts, originalContacts);
			state.dcClient = originalDcClient;
			state.waClient = originalWaClient;
			utils.discord.getControlChannel = originalGetControlChannel;
			utils.whatsapp = originalWhatsappUtils;
			resetClientFactoryOverrides();
		};

		return {
			fakeClient,
			forwarded,
			controlMessages,
			cleanup,
		};
	} catch (err) {
		state.logger = originalLogger;
		state.settings.oneWay = originalOneWay;
		state.settings.MirrorWAStatuses = originalMirrorWAStatuses;
		state.settings.NewsletterMediaUrlFallback =
			originalNewsletterMediaUrlFallback;
		state.lastMessages = originalLastMessages;
		state.startTime = originalStartTime;
		restoreSet(state.sentMessages, originalSentMessages);
		restoreSet(state.sentReactions, originalSentReactions);
		restoreSet(state.sentPins, originalSentPins);
		resetNewsletterBridgeState();
		restoreObject(state.chats, originalChats);
		restoreObject(state.contacts, originalContacts);
		state.dcClient = originalDcClient;
		state.waClient = originalWaClient;
		utils.discord.getControlChannel = originalGetControlChannel;
		utils.whatsapp = originalWhatsappUtils;
		resetClientFactoryOverrides();
		throw err;
	}
};

test("WhatsApp message emits Discord event", async () => {
	const harness = await setupWhatsAppHarness();
	try {
		messageStore.clear();
		harness.fakeClient.ev.emit("messages.upsert", {
			type: "notify",
			messages: [
				{
					key: { id: "abc", remoteJid: "jid@s.whatsapp.net" },
					message: "hello world",
				},
			],
		});

		await delay(0);

		assert.equal(harness.forwarded.messages[0]?.id, "abc");
		assert.equal(harness.forwarded.messages[0]?.content, "hello world");
		assert.equal(
			harness.forwarded.messages[0]?.channelJid,
			"jid@s.whatsapp.net",
		);
		assert.ok(
			messageStore.get({
				id: "abc",
				remoteJid: "jid@s.whatsapp.net",
			}),
		);
		assert.ok(harness.controlMessages.length >= 1);
	} finally {
		messageStore.clear();
		harness.cleanup();
	}
});

test("WhatsApp stale pre-start messages are not stored", async () => {
	const harness = await setupWhatsAppHarness({
		sentAfterStart: () => false,
	});
	try {
		messageStore.clear();
		harness.fakeClient.ev.emit("messages.upsert", {
			type: "notify",
			messages: [
				{
					key: { id: "stale", remoteJid: "jid@s.whatsapp.net" },
					message: "old message",
				},
			],
		});

		await delay(0);

		assert.equal(harness.forwarded.messages.length, 0);
		assert.equal(
			messageStore.get({
				id: "stale",
				remoteJid: "jid@s.whatsapp.net",
			}),
			null,
		);
	} finally {
		messageStore.clear();
		harness.cleanup();
	}
});

test("WhatsApp newsletter server-id mapping runs before stale message skip", async () => {
	const harness = await setupWhatsAppHarness({
		sentAfterStart: () => false,
	});
	try {
		messageStore.clear();
		state.lastMessages["newsletter-outbound"] = "dc-news";
		state.lastMessages["dc-news"] = "newsletter-outbound";

		harness.fakeClient.ev.emit("messages.upsert", {
			type: "notify",
			messages: [
				{
					key: {
						id: "newsletter-outbound",
						server_id: "newsletter-server",
						remoteJid: "120363123456789@newsletter",
						fromMe: true,
					},
					message: "newsletter post",
				},
			],
		});

		await delay(0);

		assert.equal(harness.forwarded.messages.length, 0);
		assert.equal(state.lastMessages["dc-news"], "newsletter-server");
		assert.equal(state.lastMessages["newsletter-server"], "dc-news");
		assert.equal(state.sentMessages.has("newsletter-server"), true);
		assert.equal(
			messageStore.get({
				id: "newsletter-outbound",
				remoteJid: "120363123456789@newsletter",
			}),
			null,
		);
	} finally {
		messageStore.clear();
		harness.cleanup();
	}
});

test("WhatsApp whitelist gating prevents emitting Discord events", async () => {
	const harness = await setupWhatsAppHarness({
		inWhitelist: () => false,
	});
	try {
		harness.fakeClient.ev.emit("messages.upsert", {
			type: "notify",
			messages: [
				{
					key: { id: "blocked", remoteJid: "jid@s.whatsapp.net" },
					message: "should not forward",
				},
			],
		});
		await delay(0);
		assert.equal(harness.forwarded.messages.length, 0);
	} finally {
		harness.cleanup();
	}
});

test("WhatsApp Status messages are skipped when status mirroring is disabled", async () => {
	const harness = await setupWhatsAppHarness();
	const originalMirrorWAStatuses = state.settings.MirrorWAStatuses;
	try {
		state.settings.MirrorWAStatuses = false;
		harness.fakeClient.ev.emit("messages.upsert", {
			type: "notify",
			messages: [
				{
					key: { id: "status-1", remoteJid: "status@broadcast" },
					message: "status update",
				},
			],
		});

		await delay(0);

		assert.equal(harness.forwarded.messages.length, 0);
	} finally {
		state.settings.MirrorWAStatuses = originalMirrorWAStatuses;
		harness.cleanup();
	}
});

test("WhatsApp sentMessages prevents echoing messages back to Discord", async () => {
	const harness = await setupWhatsAppHarness();
	try {
		state.sentMessages.add("echo-id");
		harness.fakeClient.ev.emit("messages.upsert", {
			type: "notify",
			messages: [
				{
					key: { id: "echo-id", remoteJid: "jid@s.whatsapp.net" },
					message: "echo loop",
				},
			],
		});
		await delay(0);
		assert.equal(harness.forwarded.messages.length, 0);
		assert.equal(state.sentMessages.has("echo-id"), false);
	} finally {
		harness.cleanup();
	}
});

test("WhatsApp sentReactions prevents echoing reactions back to Discord", async () => {
	const harness = await setupWhatsAppHarness();
	try {
		state.sentReactions.add("react-id");
		harness.fakeClient.ev.emit("messages.reaction", [
			{
				key: { id: "react-id", remoteJid: "jid@s.whatsapp.net", fromMe: false },
				reaction: { text: "👍" },
			},
		]);
		await delay(0);
		assert.equal(harness.forwarded.reactions.length, 0);
		assert.equal(state.sentReactions.has("react-id"), false);
	} finally {
		harness.cleanup();
	}
});

test("WhatsApp newsletter upserts prefer server_id as bridged message id", async () => {
	const harness = await setupWhatsAppHarness();
	try {
		harness.fakeClient.ev.emit("messages.upsert", {
			type: "notify",
			messages: [
				{
					key: {
						id: "newsletter-client-id",
						server_id: "newsletter-server-id",
						remoteJid: "120363123456789@newsletter",
					},
					message: "newsletter post",
				},
			],
		});

		await delay(0);

		assert.equal(harness.forwarded.messages.length, 1);
		assert.equal(harness.forwarded.messages[0]?.id, "newsletter-server-id");
		assert.equal(
			harness.forwarded.messages[0]?.channelJid,
			"120363123456789@newsletter",
		);
	} finally {
		harness.cleanup();
	}
});

test("WhatsApp newsletter reactions are mirrored through newsletter.reaction events", async () => {
	const harness = await setupWhatsAppHarness();
	try {
		harness.fakeClient.ev.emit("newsletter.reaction", {
			id: "120363123456789@newsletter",
			server_id: "newsletter-server-id",
			reaction: {
				code: "🔥",
				count: 1,
			},
		});

		await delay(0);

		assert.equal(harness.forwarded.reactions.length, 1);
		assert.equal(harness.forwarded.reactions[0]?.id, "newsletter-server-id");
		assert.equal(
			harness.forwarded.reactions[0]?.jid,
			"120363123456789@newsletter",
		);
		assert.equal(harness.forwarded.reactions[0]?.text, "🔥");
	} finally {
		harness.cleanup();
	}
});

test("WhatsApp newsletter reaction echo suppression uses server_id", async () => {
	const harness = await setupWhatsAppHarness();
	try {
		state.sentReactions.add("newsletter-server-id");

		harness.fakeClient.ev.emit("newsletter.reaction", {
			id: "120363123456789@newsletter",
			server_id: "newsletter-server-id",
			reaction: {
				code: "🔥",
				count: 1,
			},
		});

		await delay(0);

		assert.equal(harness.forwarded.reactions.length, 0);
		assert.equal(state.sentReactions.has("newsletter-server-id"), false);
	} finally {
		harness.cleanup();
	}
});

test("WhatsApp sentPins prevents echoing pins back to Discord", async () => {
	const harness = await setupWhatsAppHarness();
	try {
		state.sentPins.add("pinned-id");
		harness.fakeClient.ev.emit("messages.upsert", {
			type: "notify",
			messages: [
				{
					key: { id: "pin-notice", remoteJid: "jid@s.whatsapp.net" },
					message: {
						pinInChatMessage: {
							key: { id: "pinned-id", remoteJid: "jid@s.whatsapp.net" },
							type: 1,
						},
					},
				},
			],
		});
		await delay(0);
		assert.equal(harness.forwarded.pins.length, 0);
		assert.equal(state.sentPins.has("pinned-id"), false);

		const deleteCalls = harness.fakeClient.sendCalls.filter(
			(call) => call.content?.delete,
		);
		assert.equal(deleteCalls.length, 1);
		assert.equal(deleteCalls[0].content.delete.id, "pin-notice");
	} finally {
		harness.cleanup();
	}
});

test("Discord delete/edit/reaction events send the expected WhatsApp actions", async () => {
	const harness = await setupWhatsAppHarness({ oneWay: 0b11 });
	try {
		state.lastMessages["dc-msg"] = "wa-msg";

		harness.fakeClient.ev.emit("discordDelete", {
			jid: "jid@s.whatsapp.net",
			id: "wa-msg",
		});
		await delay(0);
		assert.equal(harness.fakeClient.sendCalls[0].content.delete.id, "wa-msg");

		harness.fakeClient.sendCalls.length = 0;

		harness.fakeClient.ev.emit("discordEdit", {
			jid: "jid@s.whatsapp.net",
			message: {
				id: "dc-msg",
				cleanContent: "edited",
				content: "edited",
				webhookId: null,
				author: { username: "You" },
				channel: { send: async () => {} },
			},
		});
		await delay(0);
		assert.equal(harness.fakeClient.sendCalls[0].content.edit.id, "wa-msg");

		harness.fakeClient.sendCalls.length = 0;
		state.lastMessages["dc-react"] = "wa-react-target";
		harness.fakeClient.ev.emit("discordReaction", {
			jid: "jid@s.whatsapp.net",
			removed: false,
			reaction: {
				emoji: { name: "🔥" },
				message: {
					id: "dc-react",
					webhookId: null,
					author: { username: "You" },
				},
			},
		});
		await delay(0);
		assert.equal(
			harness.fakeClient.sendCalls[0].content.react.key.id,
			"wa-react-target",
		);
		assert.equal(state.sentReactions.has("wa-react-target"), true);
	} finally {
		harness.cleanup();
	}
});

test("Discord reactions in newsletter chats use newsletter-specific API", async () => {
	const harness = await setupWhatsAppHarness({ oneWay: 0b11 });
	try {
		state.lastMessages["dc-news-react"] = "newsletter-server-id-1";

		harness.fakeClient.ev.emit("discordReaction", {
			jid: "1203630@newsletter",
			removed: false,
			reaction: {
				emoji: { name: "🔥" },
				message: {
					id: "dc-news-react",
					webhookId: null,
					author: { username: "You" },
				},
			},
		});

		await delay(0);

		assert.equal(harness.fakeClient.newsletterReactionCalls.length, 1);
		assert.equal(
			harness.fakeClient.newsletterReactionCalls[0]?.jid,
			"1203630@newsletter",
		);
		assert.equal(
			harness.fakeClient.newsletterReactionCalls[0]?.serverId,
			"newsletter-server-id-1",
		);
		assert.equal(harness.fakeClient.newsletterReactionCalls[0]?.reaction, "🔥");
		assert.equal(harness.fakeClient.sendCalls.length, 0);
		assert.equal(state.sentReactions.has("newsletter-server-id-1"), true);

		harness.fakeClient.ev.emit("discordReaction", {
			jid: "1203630@newsletter",
			removed: true,
			reaction: {
				emoji: { name: "🔥" },
				message: {
					id: "dc-news-react",
					webhookId: null,
					author: { username: "You" },
				},
			},
		});

		await delay(0);

		assert.equal(harness.fakeClient.newsletterReactionCalls.length, 2);
		assert.equal(
			harness.fakeClient.newsletterReactionCalls[1]?.reaction,
			undefined,
		);
	} finally {
		harness.cleanup();
	}
});

test("Discord newsletter deletes notify manual action and skip WhatsApp delete", async () => {
	const harness = await setupWhatsAppHarness({ oneWay: 0b11 });
	const originalGetChannel = utils.discord.getChannel;
	try {
		const linkedNotices = [];
		state.chats["1203630@newsletter"] = { channelId: "chan-newsletter-1" };
		utils.discord.getChannel = async (channelId) =>
			channelId === "chan-newsletter-1"
				? {
						send: async (value) => {
							linkedNotices.push(value);
						},
					}
				: null;

		harness.fakeClient.ev.emit("discordDelete", {
			jid: "1203630@newsletter",
			id: "  newsletter-server-id-1  ",
		});

		await delay(0);

		assert.equal(harness.fakeClient.sendCalls.length, 0);
		assert.equal(linkedNotices.length, 1);
		assert.match(
			linkedNotices[0],
			/Please delete the message directly in WhatsApp on your phone/i,
		);
	} finally {
		utils.discord.getChannel = originalGetChannel;
		harness.cleanup();
	}
});

test("Newsletter edit/delete notify manual action while reactions still wait for server ids", async () => {
	const harness = await setupWhatsAppHarness({ oneWay: 0b11 });
	const originalGetChannel = utils.discord.getChannel;
	try {
		const editNotices = [];
		const linkedNotices = [];
		state.chats["1203630@newsletter"] = { channelId: "chan-newsletter-2" };
		utils.discord.getChannel = async (channelId) =>
			channelId === "chan-newsletter-2"
				? {
						send: async (value) => {
							linkedNotices.push(value);
						},
					}
				: null;

		setTimeout(() => {
			state.lastMessages["server-react-1"] = "dc-news-react-wait";
			state.lastMessages["dc-news-react-wait"] = "server-react-1";
		}, 120);

		harness.fakeClient.ev.emit("discordEdit", {
			jid: "1203630@newsletter",
			message: {
				id: "dc-news-edit-wait",
				cleanContent: "edited",
				content: "edited",
				webhookId: null,
				author: { username: "You" },
				channel: {
					send: async (value) => {
						editNotices.push(value);
					},
				},
			},
		});

		harness.fakeClient.ev.emit("discordReaction", {
			jid: "1203630@newsletter",
			removed: false,
			reaction: {
				emoji: { name: "🔥" },
				message: {
					id: "dc-news-react-wait",
					webhookId: null,
					author: { username: "You" },
					channel: { send: async () => {} },
				},
			},
		});

		harness.fakeClient.ev.emit("discordDelete", {
			jid: "1203630@newsletter",
			id: null,
			discordMessageId: "dc-news-delete-wait",
		});

		await delay(450);

		assert.equal(editNotices.length, 1);
		assert.match(
			editNotices[0],
			/Please edit the message directly in WhatsApp on your phone/i,
		);
		assert.equal(linkedNotices.length, 1);
		assert.match(
			linkedNotices[0],
			/Please delete the message directly in WhatsApp on your phone/i,
		);
		const newsletterEditOrDeleteCalls = harness.fakeClient.sendCalls.filter(
			(call) => call.content?.edit || call.content?.delete,
		);
		assert.equal(newsletterEditOrDeleteCalls.length, 0);

		assert.equal(harness.fakeClient.newsletterReactionCalls.length, 1);
		assert.equal(
			harness.fakeClient.newsletterReactionCalls[0]?.serverId,
			"server-react-1",
		);
	} finally {
		utils.discord.getChannel = originalGetChannel;
		harness.cleanup();
	}
});

test("Newsletter reactions wait past outbound client ids for resolved server ids", async () => {
	const harness = await setupWhatsAppHarness({ oneWay: 0b11 });
	try {
		state.lastMessages["dc-news-react-outbound"] = "3EB0DD14CD06ABCE146147";
		state.lastMessages["3EB0DD14CD06ABCE146147"] = "dc-news-react-outbound";

		setTimeout(() => {
			state.lastMessages["server-react-outbound-1"] = "dc-news-react-outbound";
			state.lastMessages["dc-news-react-outbound"] = "server-react-outbound-1";
		}, 120);

		harness.fakeClient.ev.emit("discordReaction", {
			jid: "1203630@newsletter",
			removed: false,
			reaction: {
				emoji: { name: "🔥" },
				message: {
					id: "dc-news-react-outbound",
					webhookId: null,
					author: { username: "You" },
					channel: { send: async () => {} },
				},
			},
		});

		await delay(500);

		assert.equal(harness.fakeClient.newsletterReactionCalls.length, 1);
		assert.equal(
			harness.fakeClient.newsletterReactionCalls[0]?.serverId,
			"server-react-outbound-1",
		);
		assert.equal(harness.fakeClient.newsletterReactionCalls[0]?.reaction, "🔥");
	} finally {
		harness.cleanup();
	}
});

test("Newsletter reactions recover server ids from stored outbound messages after restart", async () => {
	const harness = await setupWhatsAppHarness({ oneWay: 0b11 });
	try {
		messageStore.clear();
		const outboundId = "3EB0DD14CD06ABCE146147";
		harness.fakeClient.sendMessage = async (jid, content, options) => {
			harness.fakeClient.sendCalls.push({ jid, content, options });
			return {
				key: {
					id: outboundId,
					remoteJid: jid,
				},
				message: {
					conversation: content?.text || "",
				},
				messageTimestamp: Math.floor(Date.now() / 1000),
			};
		};
		harness.fakeClient.newsletterFetchMessages = async () => [
			{
				key: {
					server_id: "server-react-restart-1",
					remoteJid: "1203630@newsletter",
				},
				message: {
					conversation: "newsletter restart map text",
				},
				messageTimestamp: Math.floor(Date.now() / 1000),
			},
		];

		harness.fakeClient.ev.emit("discordMessage", {
			jid: "1203630@newsletter",
			message: {
				id: "dc-news-react-restart",
				content: "newsletter restart map text",
				cleanContent: "newsletter restart map text",
				webhookId: null,
				author: { username: "BridgeUser" },
				member: { displayName: "BridgeUser" },
				channel: { send: async () => {} },
				attachments: new Map(),
				stickers: new Map(),
				embeds: [],
				mentions: { users: new Map(), members: new Map(), roles: new Map() },
			},
		});
		await delay(0);

		assert.equal(state.lastMessages["dc-news-react-restart"], outboundId);
		assert.ok(
			messageStore.get({ remoteJid: "1203630@newsletter", id: outboundId }),
		);

		// Simulate process restart: in-memory pending-send state is lost.
		resetNewsletterBridgeState();

		harness.fakeClient.ev.emit("discordReaction", {
			jid: "1203630@newsletter",
			removed: false,
			reaction: {
				emoji: { name: "🔥" },
				message: {
					id: "dc-news-react-restart",
					webhookId: null,
					author: { username: "You" },
					channel: { send: async () => {} },
				},
			},
		});
		await delay(500);

		assert.equal(harness.fakeClient.newsletterReactionCalls.length, 1);
		assert.equal(
			harness.fakeClient.newsletterReactionCalls[0]?.serverId,
			"server-react-restart-1",
		);
		assert.equal(
			state.lastMessages["dc-news-react-restart"],
			"server-react-restart-1",
		);
		assert.equal(
			state.lastMessages["server-react-restart-1"],
			"dc-news-react-restart",
		);
		assert.equal(state.lastMessages[outboundId], "dc-news-react-restart");
	} finally {
		messageStore.clear();
		harness.cleanup();
	}
});

test("Discord newsletter sends use normalized JIDs and map server IDs", async () => {
	const harness = await setupWhatsAppHarness({
		oneWay: 0b11,
		formatJid: (jid) => (typeof jid === "string" ? jid.trim() : jid),
	});
	try {
		messageStore.clear();
		harness.fakeClient.ev.emit("discordMessage", {
			jid: "1203630@newsletter   ",
			message: {
				id: "dc-news-send",
				content: "newsletter publish text",
				cleanContent: "newsletter publish text",
				webhookId: null,
				author: { username: "BridgeUser" },
				member: { displayName: "BridgeUser" },
				channel: { send: async () => {} },
				attachments: new Map(),
				stickers: new Map(),
				embeds: [],
				mentions: { users: new Map(), members: new Map(), roles: new Map() },
			},
		});

		await delay(0);

		assert.equal(harness.fakeClient.sendCalls.length, 1);
		assert.equal(harness.fakeClient.sendCalls[0]?.jid, "1203630@newsletter");
		assert.equal(
			harness.fakeClient.sendCalls[0]?.options?.getUrlInfo,
			undefined,
		);
		assert.equal(state.lastMessages["dc-news-send"], "server-1");
		assert.equal(state.lastMessages["server-1"], "dc-news-send");
		assert.ok(
			messageStore.get({ remoteJid: "1203630@newsletter", id: "sent-1" }),
		);
		assert.ok(
			messageStore.get({ remoteJid: "1203630@newsletter", id: "server-1" }),
		);
	} finally {
		messageStore.clear();
		harness.cleanup();
	}
});

test("Discord newsletter send maps server ids from pending upsert notifications", async () => {
	const harness = await setupWhatsAppHarness({
		oneWay: 0b11,
		formatJid: (jid) => (typeof jid === "string" ? jid.trim() : jid),
	});
	try {
		messageStore.clear();
		let outboundCounter = 0;
		harness.fakeClient.sendMessage = async (jid, content, options) => {
			harness.fakeClient.sendCalls.push({ jid, content, options });
			outboundCounter += 1;
			return {
				key: {
					id: `3EB0PENDING${outboundCounter.toString().padStart(2, "0")}ABCD1234EF`,
					remoteJid: jid,
				},
			};
		};

		harness.fakeClient.ev.emit("discordMessage", {
			jid: "1203630@newsletter",
			message: {
				id: "dc-news-pending-map",
				content: "newsletter pending map text",
				cleanContent: "newsletter pending map text",
				webhookId: null,
				author: { username: "BridgeUser" },
				member: { displayName: "BridgeUser" },
				channel: { send: async () => {} },
				attachments: new Map(),
				stickers: new Map(),
				embeds: [],
				mentions: { users: new Map(), members: new Map(), roles: new Map() },
			},
		});
		await delay(0);

		const outboundId = state.lastMessages["dc-news-pending-map"];
		assert.ok(outboundId?.startsWith("3EB0PENDING"));

		harness.fakeClient.ev.emit("messages.upsert", {
			type: "notify",
			messages: [
				{
					key: {
						id: "48902.1-1",
						remoteJid: "1203630@newsletter",
					},
					message: {
						conversation: "newsletter pending map text",
					},
				},
			],
		});
		await delay(0);

		assert.equal(harness.forwarded.messages.length, 0);
		assert.equal(state.lastMessages["dc-news-pending-map"], "48902.1-1");
		assert.equal(state.lastMessages["48902.1-1"], "dc-news-pending-map");
		assert.equal(state.lastMessages[outboundId], "dc-news-pending-map");
	} finally {
		messageStore.clear();
		harness.cleanup();
	}
});

test("Newsletter live_updates notifications map pending outbound ids to server ids", async () => {
	const harness = await setupWhatsAppHarness({
		oneWay: 0b11,
		formatJid: (jid) => (typeof jid === "string" ? jid.trim() : jid),
	});
	try {
		messageStore.clear();
		harness.fakeClient.sendMessage = async (jid, content, options) => {
			harness.fakeClient.sendCalls.push({ jid, content, options });
			return {
				key: {
					id: "3EB0LIVEUPDATEMAPABCDEF123456",
					remoteJid: jid,
				},
			};
		};

		harness.fakeClient.ev.emit("discordMessage", {
			jid: "1203630@newsletter",
			message: {
				id: "dc-news-live-map",
				content: "live update mapping text",
				cleanContent: "live update mapping text",
				webhookId: null,
				author: { username: "BridgeUser" },
				member: { displayName: "BridgeUser" },
				channel: { send: async () => {} },
				attachments: new Map(),
				stickers: new Map(),
				embeds: [],
				mentions: { users: new Map(), members: new Map(), roles: new Map() },
			},
		});
		await delay(0);

		assert.equal(
			state.lastMessages["dc-news-live-map"],
			"3EB0LIVEUPDATEMAPABCDEF123456",
		);

		const nowTs = String(Math.floor(Date.now() / 1000));
		harness.fakeClient.ws.emit("CB:notification,type:newsletter", {
			tag: "notification",
			attrs: {
				from: "1203630@newsletter",
				type: "newsletter",
				id: "test-live-updates",
				t: nowTs,
			},
			content: [
				{
					tag: "live_updates",
					attrs: {},
					content: [
						{
							tag: "messages",
							attrs: { t: nowTs },
							content: [
								{
									tag: "message",
									attrs: { server_id: "131" },
								},
							],
						},
					],
				},
			],
		});
		await delay(0);

		assert.equal(state.lastMessages["dc-news-live-map"], "131");
		assert.equal(state.lastMessages["131"], "dc-news-live-map");
		assert.equal(
			state.lastMessages["3EB0LIVEUPDATEMAPABCDEF123456"],
			"dc-news-live-map",
		);
	} finally {
		messageStore.clear();
		harness.cleanup();
	}
});

test("Newsletter live_updates notifications mirror reactions to Discord", async () => {
	const harness = await setupWhatsAppHarness({
		oneWay: 0b11,
		formatJid: (jid) => (typeof jid === "string" ? jid.trim() : jid),
	});
	try {
		const nowTs = String(Math.floor(Date.now() / 1000));
		harness.fakeClient.ws.emit("CB:notification,type:newsletter", {
			tag: "notification",
			attrs: {
				from: "1203630@newsletter",
				type: "newsletter",
				id: "test-live-updates-reaction",
				t: nowTs,
			},
			content: [
				{
					tag: "live_updates",
					attrs: {},
					content: [
						{
							tag: "messages",
							attrs: { t: nowTs },
							content: [
								{
									tag: "message",
									attrs: { server_id: "133" },
									content: [
										{
											tag: "reactions",
											attrs: {},
											content: [
												{
													tag: "reaction",
													attrs: { code: "👍", count: "1" },
												},
											],
										},
									],
								},
							],
						},
					],
				},
			],
		});
		await delay(0);

		assert.equal(harness.forwarded.reactions.length, 1);
		assert.equal(harness.forwarded.reactions[0]?.id, "133");
		assert.equal(harness.forwarded.reactions[0]?.jid, "1203630@newsletter");
		assert.equal(harness.forwarded.reactions[0]?.text, "👍");
		assert.equal(harness.forwarded.reactions[0]?.author, "newsletter:133:👍");
	} finally {
		harness.cleanup();
	}
});

test("Newsletter live_updates reaction echo suppression uses server_id", async () => {
	const harness = await setupWhatsAppHarness({
		oneWay: 0b11,
		formatJid: (jid) => (typeof jid === "string" ? jid.trim() : jid),
	});
	try {
		state.sentReactions.add("133");
		const nowTs = String(Math.floor(Date.now() / 1000));
		harness.fakeClient.ws.emit("CB:notification,type:newsletter", {
			tag: "notification",
			attrs: {
				from: "1203630@newsletter",
				type: "newsletter",
				id: "test-live-updates-reaction-echo",
				t: nowTs,
			},
			content: [
				{
					tag: "live_updates",
					attrs: {},
					content: [
						{
							tag: "messages",
							attrs: { t: nowTs },
							content: [
								{
									tag: "message",
									attrs: { server_id: "133" },
									content: [
										{
											tag: "reactions",
											attrs: {},
											content: [
												{
													tag: "reaction",
													attrs: { code: "👍", count: "1" },
												},
											],
										},
									],
								},
							],
						},
					],
				},
			],
		});
		await delay(0);

		assert.equal(harness.forwarded.reactions.length, 0);
		assert.equal(state.sentReactions.has("133"), false);
	} finally {
		harness.cleanup();
	}
});

test("Newsletter live_updates empty reactions clear tracked newsletter reactions", async () => {
	const harness = await setupWhatsAppHarness({
		oneWay: 0b11,
		formatJid: (jid) => (typeof jid === "string" ? jid.trim() : jid),
	});
	try {
		const nowTs = String(Math.floor(Date.now() / 1000));
		harness.fakeClient.ws.emit("CB:notification,type:newsletter", {
			tag: "notification",
			attrs: {
				from: "1203630@newsletter",
				type: "newsletter",
				id: "test-live-updates-reaction-clear",
				t: nowTs,
			},
			content: [
				{
					tag: "live_updates",
					attrs: {},
					content: [
						{
							tag: "messages",
							attrs: { t: nowTs },
							content: [
								{
									tag: "message",
									attrs: { server_id: "133" },
									content: [
										{
											tag: "reactions",
											attrs: {},
										},
									],
								},
							],
						},
					],
				},
			],
		});
		await delay(0);

		assert.equal(harness.forwarded.reactions.length, 1);
		assert.equal(harness.forwarded.reactions[0]?.id, "133");
		assert.equal(harness.forwarded.reactions[0]?.jid, "1203630@newsletter");
		assert.equal(harness.forwarded.reactions[0]?.text, "");
		assert.equal(harness.forwarded.reactions[0]?.author, "newsletter:133");
	} finally {
		harness.cleanup();
	}
});

test("Discord to WhatsApp sends include broadcast mode for broadcast chats", async () => {
	const harness = await setupWhatsAppHarness({ oneWay: 0b11 });
	try {
		state.lastMessages["dc-broadcast-edit"] = "wa-broadcast-msg";
		state.lastMessages["dc-broadcast-react"] = "wa-broadcast-msg";

		harness.fakeClient.ev.emit("discordMessage", {
			jid: "12345678@broadcast",
			message: {
				id: "dc-broadcast-message",
				content: "broadcast text",
				cleanContent: "broadcast text",
				webhookId: null,
				author: { username: "BridgeUser" },
				member: { displayName: "BridgeUser" },
				channel: { send: async () => {} },
				attachments: new Map(),
				stickers: new Map(),
				embeds: [],
				mentions: { users: new Map(), members: new Map(), roles: new Map() },
			},
		});
		await delay(0);
		assert.equal(harness.fakeClient.sendCalls[0]?.options?.broadcast, true);

		harness.fakeClient.ev.emit("discordEdit", {
			jid: "12345678@broadcast",
			message: {
				id: "dc-broadcast-edit",
				cleanContent: "edited",
				content: "edited",
				webhookId: null,
				author: { username: "You" },
				channel: { send: async () => {} },
			},
		});
		await delay(0);
		assert.equal(harness.fakeClient.sendCalls[1]?.options?.broadcast, true);

		harness.fakeClient.ev.emit("discordReaction", {
			jid: "12345678@broadcast",
			removed: false,
			reaction: {
				emoji: { name: "🔥" },
				message: {
					id: "dc-broadcast-react",
					webhookId: null,
					author: { username: "You" },
				},
			},
		});
		await delay(0);
		assert.equal(harness.fakeClient.sendCalls[2]?.options?.broadcast, true);

		harness.fakeClient.ev.emit("discordDelete", {
			jid: "12345678@broadcast",
			id: "wa-broadcast-msg",
		});
		await delay(0);
		assert.equal(harness.fakeClient.sendCalls[3]?.options?.broadcast, true);
	} finally {
		harness.cleanup();
	}
});

test("Discord raw user and role mentions are converted before forwarding to WhatsApp", async () => {
	const harness = await setupWhatsAppHarness({ oneWay: 0b11 });
	try {
		harness.fakeClient.ev.emit("discordMessage", {
			jid: "jid@s.whatsapp.net",
			message: {
				id: "dc-mention-msg",
				content: "Hi <@123456789012345678> and <@&987654321098765432>",
				cleanContent: "Hi @Panos and @Moderators",
				webhookId: null,
				author: { username: "BridgeUser" },
				member: { displayName: "BridgeUser" },
				channel: { send: async () => {} },
				attachments: new Map(),
				stickers: new Map(),
				embeds: [],
				mentions: {
					users: new Map([
						[
							"123456789012345678",
							{
								id: "123456789012345678",
								username: "panos-discord",
								globalName: "Panos",
							},
						],
					]),
					members: new Map([["123456789012345678", { displayName: "Panos" }]]),
					roles: new Map([
						[
							"987654321098765432",
							{ id: "987654321098765432", name: "Moderators" },
						],
					]),
				},
			},
		});

		await delay(0);

		assert.equal(
			harness.fakeClient.sendCalls[0]?.content?.text,
			"Hi @Panos and @Moderators",
		);
	} finally {
		harness.cleanup();
	}
});

test("Discord everyone and here mentions become WhatsApp @all in group chats", async () => {
	const harness = await setupWhatsAppHarness({ oneWay: 0b11 });
	try {
		harness.fakeClient.ev.emit("discordMessage", {
			jid: "123456789@g.us",
			message: {
				id: "dc-everyone-msg",
				content: "Team @everyone",
				cleanContent: "Team @everyone",
				webhookId: null,
				author: { username: "BridgeUser" },
				member: { displayName: "BridgeUser" },
				channel: { send: async () => {} },
				attachments: new Map(),
				stickers: new Map(),
				embeds: [],
				mentions: {
					everyone: true,
					users: new Map(),
					members: new Map(),
					roles: new Map(),
				},
			},
		});
		await delay(0);

		assert.equal(harness.fakeClient.sendCalls[0]?.content?.text, "Team @all");
		assert.equal(harness.fakeClient.sendCalls[0]?.content?.mentionAll, true);

		harness.fakeClient.ev.emit("discordMessage", {
			jid: "123456789@g.us",
			message: {
				id: "dc-here-msg",
				content: "Team @here",
				cleanContent: "Team @here",
				webhookId: null,
				author: { username: "BridgeUser" },
				member: { displayName: "BridgeUser" },
				channel: { send: async () => {} },
				attachments: new Map(),
				stickers: new Map(),
				embeds: [],
				mentions: {
					everyone: true,
					users: new Map(),
					members: new Map(),
					roles: new Map(),
				},
			},
		});
		await delay(0);

		assert.equal(harness.fakeClient.sendCalls[1]?.content?.text, "Team @all");
		assert.equal(harness.fakeClient.sendCalls[1]?.content?.mentionAll, true);
	} finally {
		harness.cleanup();
	}
});

test("Plain Discord @everyone text is not promoted to WhatsApp @all", async () => {
	const harness = await setupWhatsAppHarness({ oneWay: 0b11 });
	try {
		harness.fakeClient.ev.emit("discordMessage", {
			jid: "123456789@g.us",
			message: {
				id: "dc-manual-everyone-msg",
				content: "Manual @everyone",
				cleanContent: "Manual @everyone",
				webhookId: null,
				author: { username: "BridgeUser" },
				member: { displayName: "BridgeUser" },
				channel: { send: async () => {} },
				attachments: new Map(),
				stickers: new Map(),
				embeds: [],
				mentions: {
					everyone: false,
					users: new Map(),
					members: new Map(),
					roles: new Map(),
				},
			},
		});
		await delay(0);

		assert.equal(
			harness.fakeClient.sendCalls[0]?.content?.text,
			"Manual @everyone",
		);
		assert.equal(
			harness.fakeClient.sendCalls[0]?.content?.mentionAll,
			undefined,
		);
	} finally {
		harness.cleanup();
	}
});

test("Discord edited everyone mentions keep WhatsApp mentionAll metadata", async () => {
	const harness = await setupWhatsAppHarness({ oneWay: 0b11 });
	try {
		state.lastMessages["dc-edit-everyone"] = "wa-edit-everyone";

		harness.fakeClient.ev.emit("discordEdit", {
			jid: "123456789@g.us",
			message: {
				id: "dc-edit-everyone",
				content: "Edited @everyone",
				cleanContent: "Edited @everyone",
				webhookId: null,
				author: { username: "BridgeUser" },
				member: { displayName: "BridgeUser" },
				channel: { send: async () => {} },
				mentions: {
					everyone: true,
					users: new Map(),
					members: new Map(),
					roles: new Map(),
				},
			},
		});
		await delay(0);

		assert.equal(harness.fakeClient.sendCalls[0]?.content?.text, "Edited @all");
		assert.equal(harness.fakeClient.sendCalls[0]?.content?.mentionAll, true);
		assert.equal(
			harness.fakeClient.sendCalls[0]?.content?.edit?.id,
			"wa-edit-everyone",
		);
	} finally {
		harness.cleanup();
	}
});

test("Discord embeds are ignored when DiscordEmbedsToWhatsApp is disabled", async () => {
	const harness = await setupWhatsAppHarness({ oneWay: 0b11 });
	const originalEmbedSetting = state.settings.DiscordEmbedsToWhatsApp;
	try {
		state.settings.DiscordEmbedsToWhatsApp = false;

		harness.fakeClient.ev.emit("discordMessage", {
			jid: "jid@s.whatsapp.net",
			message: {
				id: "dc-embed-disabled",
				content: "base text",
				cleanContent: "base text",
				webhookId: null,
				author: { username: "BridgeUser" },
				member: { displayName: "BridgeUser" },
				channel: { send: async () => {} },
				attachments: new Map(),
				stickers: new Map(),
				embeds: [
					{
						title: "Embed Title",
						description: "Embed body",
						url: "https://example.com/embed",
					},
				],
				mentions: { users: new Map(), members: new Map(), roles: new Map() },
			},
		});

		await delay(0);

		assert.equal(harness.fakeClient.sendCalls.length, 1);
		assert.equal(harness.fakeClient.sendCalls[0]?.content?.text, "base text");
	} finally {
		state.settings.DiscordEmbedsToWhatsApp = originalEmbedSetting;
		harness.cleanup();
	}
});

test("Discord embeds can be mirrored to WhatsApp with mention conversion", async () => {
	const harness = await setupWhatsAppHarness({ oneWay: 0b11 });
	const originalEmbedSetting = state.settings.DiscordEmbedsToWhatsApp;
	const originalMentionLinks = {
		...(state.settings.WhatsAppDiscordMentionLinks || {}),
	};
	const originalContacts = snapshotObject(state.contacts);
	try {
		state.settings.DiscordEmbedsToWhatsApp = true;
		const linkedJid = "14155550123@s.whatsapp.net";
		state.contacts[linkedJid] = "Panos";
		state.settings.WhatsAppDiscordMentionLinks = {
			[linkedJid]: "123456789012345678",
		};

		harness.fakeClient.ev.emit("discordMessage", {
			jid: "jid@s.whatsapp.net",
			message: {
				id: "dc-embed-enabled",
				content: "",
				cleanContent: "",
				webhookId: null,
				author: { username: "BridgeUser" },
				member: { displayName: "BridgeUser" },
				channel: { send: async () => {} },
				attachments: new Map(),
				stickers: new Map(),
				embeds: [
					{
						title: "Embed Title",
						description: "Hi <@123456789012345678> and <@&987654321098765432>",
						fields: [{ name: "Scope", value: "<@123456789012345678>" }],
						url: "https://example.com/embed",
					},
				],
				mentions: { users: new Map(), members: new Map(), roles: new Map() },
				client: {
					users: {
						fetch: async (id) =>
							id === "123456789012345678"
								? { id, username: "panos-discord", globalName: "Panos" }
								: null,
					},
				},
				guild: {
					members: {
						cache: new Map(),
						fetch: async (id) =>
							id === "123456789012345678" ? { id, displayName: "Panos" } : null,
					},
					roles: {
						cache: new Map(),
						fetch: async (id) =>
							id === "987654321098765432" ? { id, name: "Moderators" } : null,
					},
				},
			},
		});

		await delay(0);

		assert.equal(harness.fakeClient.sendCalls.length, 1);
		const mirrored = harness.fakeClient.sendCalls[0]?.content?.text || "";
		assert.ok(mirrored.includes("Embed Title"));
		assert.ok(mirrored.includes("Hi @14155550123 and @Moderators"));
		assert.ok(mirrored.includes("Scope: @14155550123"));
		assert.ok(
			extractUrls(mirrored).some((url) => url === "https://example.com/embed"),
		);
		assert.deepEqual(harness.fakeClient.sendCalls[0]?.content?.mentions, [
			linkedJid,
		]);
	} finally {
		state.settings.DiscordEmbedsToWhatsApp = originalEmbedSetting;
		state.settings.WhatsAppDiscordMentionLinks = originalMentionLinks;
		restoreObject(state.contacts, originalContacts);
		harness.cleanup();
	}
});

test("Discord embed images are not duplicated when CDN and proxy URLs point to the same media", async () => {
	const harness = await setupWhatsAppHarness({ oneWay: 0b11 });
	const originalEmbedSetting = state.settings.DiscordEmbedsToWhatsApp;
	try {
		state.settings.DiscordEmbedsToWhatsApp = true;
		utils.whatsapp.createDocumentContent = (attachment) => ({
			document: { url: attachment.url },
			fileName: attachment.name,
			mimetype: attachment.contentType,
		});

		const cdnUrl =
			"https://cdn.discordapp.com/attachments/123/456/embed-image.png?ex=abc&is=def&hm=123";
		const proxyUrl =
			"https://media.discordapp.net/attachments/123/456/embed-image.png?width=1024&height=768";
		harness.fakeClient.ev.emit("discordMessage", {
			jid: "jid@s.whatsapp.net",
			message: {
				id: "dc-embed-image-dedupe",
				content: "",
				cleanContent: "",
				webhookId: null,
				author: { username: "BridgeUser" },
				member: { displayName: "BridgeUser" },
				channel: { send: async () => {} },
				attachments: new Map([
					[
						"attachment-1",
						{
							id: "attachment-1",
							url: cdnUrl,
							name: "upload.png",
							contentType: "image/png",
						},
					],
				]),
				stickers: new Map(),
				embeds: [
					{
						title: "Embed Image",
						image: {
							url: cdnUrl,
							proxy_url: proxyUrl,
						},
					},
				],
				mentions: { users: new Map(), members: new Map(), roles: new Map() },
			},
		});

		await delay(0);

		assert.equal(harness.fakeClient.sendCalls.length, 1);
		assert.equal(
			harness.fakeClient.sendCalls[0]?.content?.document?.url,
			cdnUrl,
		);
	} finally {
		state.settings.DiscordEmbedsToWhatsApp = originalEmbedSetting;
		harness.cleanup();
	}
});

test("Discord voice-style audio attachments are sent as WhatsApp ptt messages", async () => {
	const harness = await setupWhatsAppHarness({ oneWay: 0b11 });
	try {
		utils.whatsapp.createDocumentContent = (attachment) => ({
			audio: { url: attachment.url },
			mimetype: attachment.contentType,
		});

		const voiceBytes = Buffer.from("not-real-ogg-audio");
		const waveformBytes = Buffer.from([1, 2, 3, 4]);
		const attachmentUrl = `data:audio/ogg;base64,${voiceBytes.toString("base64")}`;

		harness.fakeClient.ev.emit("discordMessage", {
			jid: "120363123456789@s.whatsapp.net",
			forwardContext: null,
			message: {
				id: "dc-voice-audio-ptt",
				content: "",
				cleanContent: "",
				webhookId: null,
				author: { username: "BridgeUser" },
				member: { displayName: "BridgeUser" },
				channel: { send: async () => {} },
				attachments: new Map([
					[
						"attachment-1",
						{
							id: "attachment-1",
							url: attachmentUrl,
							name: "voice-message",
							contentType: "audio/ogg",
							duration: 4,
							waveform: waveformBytes.toString("base64"),
						},
					],
				]),
				stickers: new Map(),
				embeds: [],
				mentions: { users: new Map(), members: new Map(), roles: new Map() },
			},
		});

		const sent = await waitFor(
			() => harness.fakeClient.sendCalls.length === 1,
			{
				timeoutMs: 1500,
			},
		);

		assert.equal(sent, true);
		assert.equal(harness.fakeClient.sendCalls.length, 1);
		const sentContent = harness.fakeClient.sendCalls[0]?.content || {};
		assert.equal(sentContent.ptt, true);
		assert.equal(sentContent.seconds, 4);
		assert.ok(Buffer.isBuffer(sentContent.audio));
		assert.equal("waveform" in sentContent, false);
		assert.ok(String(sentContent.mimetype || "").startsWith("audio/ogg"));
	} finally {
		harness.cleanup();
	}
});

test("Regular Discord audio attachments are not forced into ptt mode", async () => {
	const harness = await setupWhatsAppHarness({ oneWay: 0b11 });
	try {
		utils.whatsapp.createDocumentContent = (attachment) => ({
			audio: { url: attachment.url },
			mimetype: attachment.contentType,
		});

		const audioBytes = Buffer.from("not-real-mp3-audio");
		const attachmentUrl = `data:audio/mpeg;base64,${audioBytes.toString("base64")}`;

		harness.fakeClient.ev.emit("discordMessage", {
			jid: "120363123456789@s.whatsapp.net",
			forwardContext: null,
			message: {
				id: "dc-regular-audio",
				content: "",
				cleanContent: "",
				webhookId: null,
				author: { username: "BridgeUser" },
				member: { displayName: "BridgeUser" },
				channel: { send: async () => {} },
				attachments: new Map([
					[
						"attachment-1",
						{
							id: "attachment-1",
							url: attachmentUrl,
							name: "clip.mp3",
							contentType: "audio/mpeg",
						},
					],
				]),
				stickers: new Map(),
				embeds: [],
				mentions: { users: new Map(), members: new Map(), roles: new Map() },
			},
		});

		const sent = await waitFor(
			() => harness.fakeClient.sendCalls.length === 1,
			{
				timeoutMs: 1500,
			},
		);

		assert.equal(sent, true);
		assert.equal(harness.fakeClient.sendCalls.length, 1);
		const sentContent = harness.fakeClient.sendCalls[0]?.content || {};
		assert.notEqual(sentContent.ptt, true);
		assert.ok(Buffer.isBuffer(sentContent.audio));
		assert.equal(sentContent.mimetype, "audio/mpeg");
	} finally {
		harness.cleanup();
	}
});

test("Discord static stickers are sent to WhatsApp as sticker payloads", async () => {
	const harness = await setupWhatsAppHarness({ oneWay: 0b11 });
	try {
		const sharpMod = await import("sharp");
		const sharp = sharpMod?.default || sharpMod;
		const pngBytes = await sharp({
			create: {
				width: 16,
				height: 16,
				channels: 4,
				background: { r: 255, g: 180, b: 0, alpha: 1 },
			},
		})
			.png()
			.toBuffer();

		harness.fakeClient.ev.emit("discordMessage", {
			jid: "120363123456789@s.whatsapp.net",
			forwardContext: null,
			message: {
				id: "dc-static-sticker",
				content: "",
				cleanContent: "",
				webhookId: null,
				author: { username: "BridgeUser" },
				member: { displayName: "BridgeUser" },
				channel: { send: async () => {} },
				attachments: new Map(),
				stickers: new Map([
					[
						"sticker-1",
						{
							id: "sticker-1",
							name: "wave",
							format: 1,
							url: `data:image/png;base64,${pngBytes.toString("base64")}`,
						},
					],
				]),
				embeds: [],
				mentions: { users: new Map(), members: new Map(), roles: new Map() },
			},
		});

		const sent = await waitFor(
			() => harness.fakeClient.sendCalls.length === 1,
			{
				timeoutMs: 1500,
			},
		);

		assert.equal(sent, true);
		const sentContent = harness.fakeClient.sendCalls[0]?.content || {};
		assert.ok(Buffer.isBuffer(sentContent.sticker));
		assert.equal(sentContent.mimetype, "image/webp");
		assert.equal(sentContent.isAnimated, false);
		assert.equal(sentContent.width, 512);
		assert.equal(sentContent.height, 512);
		assert.equal(sentContent.document, undefined);
	} finally {
		harness.cleanup();
	}
});

test("Unsupported Discord static WebP attachments are normalized before WhatsApp send", async () => {
	const harness = await setupWhatsAppHarness({ oneWay: 0b11 });
	try {
		const sharpMod = await import("sharp");
		const sharp = sharpMod?.default || sharpMod;
		const webpBytes = await sharp({
			create: {
				width: 2,
				height: 2,
				channels: 4,
				background: { r: 255, g: 0, b: 0, alpha: 0.5 },
			},
		})
			.webp()
			.toBuffer();
		const attachmentUrl = `data:image/webp;base64,${webpBytes.toString("base64")}`;

		utils.whatsapp.createDocumentContent = (attachment) => ({
			image: { url: attachment.url },
			mimetype: attachment.contentType,
		});

		harness.fakeClient.ev.emit("discordMessage", {
			jid: "120363123456789@s.whatsapp.net",
			forwardContext: null,
			message: {
				id: "dc-static-webp",
				content: "",
				cleanContent: "",
				webhookId: null,
				author: { username: "BridgeUser" },
				member: { displayName: "BridgeUser" },
				channel: { send: async () => {} },
				attachments: new Map([
					[
						"attachment-1",
						{
							id: "attachment-1",
							url: attachmentUrl,
							name: "paste.webp",
							contentType: "image/webp",
						},
					],
				]),
				stickers: new Map(),
				embeds: [],
				mentions: { users: new Map(), members: new Map(), roles: new Map() },
			},
		});

		const sent = await waitFor(
			() => harness.fakeClient.sendCalls.length === 1,
			{
				timeoutMs: 1500,
			},
		);

		assert.equal(sent, true);
		const sentContent = harness.fakeClient.sendCalls[0]?.content || {};
		assert.ok(Buffer.isBuffer(sentContent.image));
		assert.equal(sentContent.mimetype, "image/png");
		assert.equal(sentContent.document, undefined);
		assert.equal(sentContent.width, 2);
		assert.equal(sentContent.height, 2);
		assert.ok(Buffer.isBuffer(sentContent.jpegThumbnail));
	} finally {
		harness.cleanup();
	}
});

test("Standard Discord PNG image attachments include a jpegThumbnail before WhatsApp send", async () => {
	const harness = await setupWhatsAppHarness({ oneWay: 0b11 });
	try {
		const sharpMod = await import("sharp");
		const sharp = sharpMod?.default || sharpMod;
		const pngBytes = await sharp({
			create: {
				width: 4,
				height: 3,
				channels: 4,
				background: { r: 12, g: 34, b: 56, alpha: 1 },
			},
		})
			.png()
			.toBuffer();
		const attachmentUrl = `data:image/png;base64,${pngBytes.toString("base64")}`;

		utils.whatsapp.createDocumentContent = (attachment) => ({
			image: { url: attachment.url },
			mimetype: attachment.contentType,
		});

		harness.fakeClient.ev.emit("discordMessage", {
			jid: "120363123456789@s.whatsapp.net",
			forwardContext: null,
			message: {
				id: "dc-static-png-thumb",
				content: "",
				cleanContent: "",
				webhookId: null,
				author: { username: "BridgeUser" },
				member: { displayName: "BridgeUser" },
				channel: { send: async () => {} },
				attachments: new Map([
					[
						"attachment-1",
						{
							id: "attachment-1",
							url: attachmentUrl,
							name: "paste.png",
							contentType: "image/png",
						},
					],
				]),
				stickers: new Map(),
				embeds: [],
				mentions: { users: new Map(), members: new Map(), roles: new Map() },
			},
		});

		const sent = await waitFor(
			() => harness.fakeClient.sendCalls.length === 1,
			{
				timeoutMs: 1500,
			},
		);

		assert.equal(sent, true);
		const sentContent = harness.fakeClient.sendCalls[0]?.content || {};
		assert.ok(Buffer.isBuffer(sentContent.jpegThumbnail));
		assert.equal(sentContent.width, 4);
		assert.equal(sentContent.height, 3);
		assert.equal(sentContent.document, undefined);
	} finally {
		harness.cleanup();
	}
});

test("Multiple Discord image attachments are sent to WhatsApp as a media album", async () => {
	const harness = await setupWhatsAppHarness({ oneWay: 0b11 });
	try {
		const sharpMod = await import("sharp");
		const sharp = sharpMod?.default || sharpMod;
		harness.fakeClient.waUploadToServer = async (
			_filePath,
			uploadOptions = {},
		) => {
			const mediaType = uploadOptions.mediaType || "image";
			return {
				mediaUrl: `https://mmg.whatsapp.net/${mediaType}/${Date.now()}`,
				directPath: `/m1/${mediaType}/${Date.now()}`,
			};
		};

		const firstPng = await sharp({
			create: {
				width: 3,
				height: 3,
				channels: 4,
				background: { r: 200, g: 10, b: 20, alpha: 1 },
			},
		})
			.png()
			.toBuffer();
		const secondPng = await sharp({
			create: {
				width: 4,
				height: 2,
				channels: 4,
				background: { r: 10, g: 80, b: 200, alpha: 1 },
			},
		})
			.png()
			.toBuffer();

		utils.whatsapp.createDocumentContent = (attachment) => ({
			image: { url: attachment.url },
			mimetype: attachment.contentType,
		});

		harness.fakeClient.ev.emit("discordMessage", {
			jid: "120363123456789@s.whatsapp.net",
			forwardContext: null,
			message: {
				id: "dc-media-album",
				content: "album caption",
				cleanContent: "album caption",
				webhookId: null,
				author: { username: "BridgeUser" },
				member: { displayName: "BridgeUser" },
				channel: { send: async () => {} },
				attachments: new Map([
					[
						"attachment-1",
						{
							id: "attachment-1",
							url: `data:image/png;base64,${firstPng.toString("base64")}`,
							name: "one.png",
							contentType: "image/png",
						},
					],
					[
						"attachment-2",
						{
							id: "attachment-2",
							url: `data:image/png;base64,${secondPng.toString("base64")}`,
							name: "two.png",
							contentType: "image/png",
						},
					],
				]),
				stickers: new Map(),
				embeds: [],
				mentions: { users: new Map(), members: new Map(), roles: new Map() },
			},
		});

		const settled = await waitFor(
			() => harness.fakeClient.relayCalls.length === 3,
			{ timeoutMs: 2500 },
		);

		assert.equal(settled, true);
		assert.equal(harness.fakeClient.sendCalls.length, 0);
		assert.equal(harness.fakeClient.relayCalls.length, 3);
		const parent = harness.fakeClient.relayCalls[0];
		const firstChild = harness.fakeClient.relayCalls[1];
		const secondChild = harness.fakeClient.relayCalls[2];
		assert.ok(parent?.message?.albumMessage);
		assert.equal(parent?.message?.albumMessage?.expectedImageCount, 2);
		assert.equal(parent?.message?.albumMessage?.expectedVideoCount, 0);
		assert.equal(
			firstChild?.message?.messageContextInfo?.messageAssociation
				?.associationType,
			proto.MessageAssociation.AssociationType.MEDIA_ALBUM,
		);
		assert.equal(
			firstChild?.message?.messageContextInfo?.messageAssociation
				?.parentMessageKey?.id,
			parent?.options?.messageId,
		);
		assert.equal(firstChild?.message?.imageMessage?.caption, "album caption");
		assert.equal(secondChild?.message?.imageMessage?.caption ?? null, null);
		assert.equal(
			state.lastMessages["dc-media-album"],
			parent?.options?.messageId,
		);
	} finally {
		harness.cleanup();
	}
});

test("Unsupported Discord AVIF attachments are normalized before WhatsApp send", async (t) => {
	const harness = await setupWhatsAppHarness({ oneWay: 0b11 });
	try {
		const sharpMod = await import("sharp");
		const sharp = sharpMod?.default || sharpMod;
		if (!sharp.format?.avif?.output?.buffer) {
			t.skip("sharp build does not support AVIF output");
			return;
		}
		const avifBytes = await sharp({
			create: {
				width: 2,
				height: 2,
				channels: 4,
				background: { r: 0, g: 0, b: 255, alpha: 1 },
			},
		})
			.avif()
			.toBuffer();
		const attachmentUrl = `data:image/avif;base64,${avifBytes.toString("base64")}`;

		utils.whatsapp.createDocumentContent = (attachment) => ({
			image: { url: attachment.url },
			mimetype: attachment.contentType,
		});

		harness.fakeClient.ev.emit("discordMessage", {
			jid: "120363123456789@s.whatsapp.net",
			forwardContext: null,
			message: {
				id: "dc-static-avif",
				content: "",
				cleanContent: "",
				webhookId: null,
				author: { username: "BridgeUser" },
				member: { displayName: "BridgeUser" },
				channel: { send: async () => {} },
				attachments: new Map([
					[
						"attachment-1",
						{
							id: "attachment-1",
							url: attachmentUrl,
							name: "paste.avif",
							contentType: "image/avif",
						},
					],
				]),
				stickers: new Map(),
				embeds: [],
				mentions: { users: new Map(), members: new Map(), roles: new Map() },
			},
		});

		const sent = await waitFor(
			() => harness.fakeClient.sendCalls.length === 1,
			{
				timeoutMs: 1500,
			},
		);

		assert.equal(sent, true);
		const sentContent = harness.fakeClient.sendCalls[0]?.content || {};
		assert.ok(Buffer.isBuffer(sentContent.image));
		assert.equal(sentContent.mimetype, "image/png");
		assert.equal(sentContent.document, undefined);
		assert.equal(sentContent.width, 2);
		assert.equal(sentContent.height, 2);
	} finally {
		harness.cleanup();
	}
});

test("Unsupported Discord TIFF attachments fall back to document sends when sharp is unavailable", async () => {
	const harness = await setupWhatsAppHarness({ oneWay: 0b11 });
	try {
		const sharpMod = await import("sharp");
		const sharp = sharpMod?.default || sharpMod;
		const tiffBytes = await sharp({
			create: {
				width: 3,
				height: 2,
				channels: 4,
				background: { r: 0, g: 255, b: 0, alpha: 1 },
			},
		})
			.tiff()
			.toBuffer();
		const attachmentUrl = `data:image/tiff;base64,${tiffBytes.toString("base64")}`;

		setImageLibTestOverrides({
			getImageSharp: async () => null,
		});
		utils.whatsapp.createDocumentContent = (attachment) => ({
			image: { url: attachment.url },
			mimetype: attachment.contentType,
		});

		harness.fakeClient.ev.emit("discordMessage", {
			jid: "120363123456789@s.whatsapp.net",
			forwardContext: null,
			message: {
				id: "dc-static-tiff-document-fallback",
				content: "",
				cleanContent: "",
				webhookId: null,
				author: { username: "BridgeUser" },
				member: { displayName: "BridgeUser" },
				channel: { send: async () => {} },
				attachments: new Map([
					[
						"attachment-1",
						{
							id: "attachment-1",
							url: attachmentUrl,
							name: "paste.tiff",
							contentType: "image/tiff",
						},
					],
				]),
				stickers: new Map(),
				embeds: [],
				mentions: { users: new Map(), members: new Map(), roles: new Map() },
			},
		});

		const sent = await waitFor(
			() => harness.fakeClient.sendCalls.length === 1,
			{
				timeoutMs: 1500,
			},
		);

		assert.equal(sent, true);
		const sentContent = harness.fakeClient.sendCalls[0]?.content || {};
		assert.ok(sentContent.document);
		assert.equal(sentContent.mimetype, "image/tiff");
		assert.equal(sentContent.image, undefined);
		assert.equal(sentContent.width, undefined);
		assert.equal(sentContent.height, undefined);
	} finally {
		resetImageLibTestOverrides();
		harness.cleanup();
	}
});

test("Unsupported Discord image attachments fall back to document sends when normalization loading fails", async () => {
	const harness = await setupWhatsAppHarness({ oneWay: 0b11 });
	const originalFetchPublicBuffer = utils.requests.fetchPublicBuffer;
	try {
		utils.requests.fetchPublicBuffer = async () => {
			throw new Error("HTTP 503");
		};
		utils.whatsapp.createDocumentContent = (attachment) => ({
			image: { url: attachment.url },
			mimetype: attachment.contentType,
		});

		const unsupportedImageUrl =
			"https://cdn.discordapp.com/attachments/123/456/upload.webp";

		harness.fakeClient.ev.emit("discordMessage", {
			jid: "120363123456789@s.whatsapp.net",
			forwardContext: null,
			message: {
				id: "dc-unsupported-image-fetch-fail",
				content: "",
				cleanContent: "",
				webhookId: null,
				author: { username: "BridgeUser" },
				member: { displayName: "BridgeUser" },
				channel: { send: async () => {} },
				attachments: new Map([
					[
						"attachment-1",
						{
							id: "attachment-1",
							url: unsupportedImageUrl,
							name: "upload.webp",
							contentType: "image/webp",
						},
					],
				]),
				stickers: new Map(),
				embeds: [],
				mentions: { users: new Map(), members: new Map(), roles: new Map() },
			},
		});

		const sent = await waitFor(
			() => harness.fakeClient.sendCalls.length === 1,
			{
				timeoutMs: 1500,
			},
		);

		assert.equal(sent, true);
		const sentContent = harness.fakeClient.sendCalls[0]?.content || {};
		assert.deepEqual(sentContent.document, { url: unsupportedImageUrl });
		assert.equal(sentContent.mimetype, "image/webp");
		assert.equal(sentContent.fileName, "upload.webp");
		assert.equal(sentContent.image, undefined);
	} finally {
		utils.requests.fetchPublicBuffer = originalFetchPublicBuffer;
		harness.cleanup();
	}
});

test("Discord replies warn with interpolated message storage size when quoted message is missing", async () => {
	const harness = await setupWhatsAppHarness({ oneWay: 0b11 });
	const originalLimit = state.settings.lastMessageStorage;
	try {
		state.settings.lastMessageStorage = 321;
		const channelWarnings = [];
		let quoteAttempts = 0;
		utils.whatsapp.createQuoteMessage = async (...args) => {
			quoteAttempts += 1;
			assert.equal(args[1], "jid@s.whatsapp.net");
			return null;
		};

		harness.fakeClient.ev.emit("discordMessage", {
			jid: "jid@s.whatsapp.net",
			message: {
				id: "dc-reply-msg",
				content: "reply text",
				cleanContent: "reply text",
				reference: { channelId: "chan-1", messageId: "msg-1" },
				webhookId: null,
				author: { username: "BridgeUser" },
				member: { displayName: "BridgeUser" },
				channel: {
					send: async (value) => {
						channelWarnings.push(value);
					},
				},
				attachments: new Map(),
				stickers: new Map(),
				embeds: [],
				mentions: { users: new Map(), members: new Map(), roles: new Map() },
			},
		});

		await delay(0);

		assert.equal(quoteAttempts, 1);
		assert.equal(channelWarnings.length, 1);
		assert.ok(channelWarnings[0].includes("321"));
		const limitPlaceholder = "$" + "{state.settings.lastMessageStorage}";
		assert.equal(channelWarnings[0].includes(limitPlaceholder), false);
	} finally {
		state.settings.lastMessageStorage = originalLimit;
		harness.cleanup();
	}
});

test("Discord non-reply references skip quote lookup and do not warn", async () => {
	const harness = await setupWhatsAppHarness({ oneWay: 0b11 });
	try {
		const channelWarnings = [];
		let quoteAttempts = 0;
		utils.whatsapp.createQuoteMessage = async () => {
			quoteAttempts += 1;
			return null;
		};

		harness.fakeClient.ev.emit("discordMessage", {
			jid: "jid@s.whatsapp.net",
			message: {
				id: "dc-followed-announcement",
				type: "DEFAULT",
				content: "announcement update",
				cleanContent: "announcement update",
				reference: {
					channelId: "source-channel",
					messageId: "source-message",
					guildId: "source-guild",
				},
				webhookId: "external-news-webhook",
				author: { username: "BridgeUser" },
				member: { displayName: "BridgeUser" },
				channel: {
					send: async (value) => {
						channelWarnings.push(value);
					},
				},
				attachments: new Map(),
				stickers: new Map(),
				embeds: [],
				mentions: { users: new Map(), members: new Map(), roles: new Map() },
			},
		});

		await delay(0);

		assert.equal(quoteAttempts, 0);
		assert.equal(channelWarnings.length, 0);
		assert.equal(harness.fakeClient.sendCalls.length, 1);
		assert.equal(
			harness.fakeClient.sendCalls[0]?.content?.text,
			"announcement update",
		);
	} finally {
		harness.cleanup();
	}
});

test("Discord forwarded messages skip quote lookup and send plain forwarded text to WhatsApp", async () => {
	const harness = await setupWhatsAppHarness({ oneWay: 0b11 });
	try {
		const channelWarnings = [];
		let quoteAttempts = 0;
		utils.whatsapp.createQuoteMessage = async () => {
			quoteAttempts += 1;
			return null;
		};

		harness.fakeClient.ev.emit("discordMessage", {
			jid: "jid@s.whatsapp.net",
			forwardContext: {
				isForwarded: true,
				sourceChannelId: "chan-a",
				sourceMessageId: "m-1",
				sourceGuildId: "guild-a",
			},
			message: {
				id: "dc-forward-msg",
				content: "",
				cleanContent: "",
				reference: { channelId: "chan-a", messageId: "m-1" },
				webhookId: null,
				author: { username: "BridgeUser" },
				member: { displayName: "BridgeUser" },
				channel: {
					send: async (value) => {
						channelWarnings.push(value);
					},
				},
				attachments: new Map(),
				stickers: new Map(),
				embeds: [],
				mentions: { users: new Map(), members: new Map(), roles: new Map() },
			},
		});

		await delay(0);

		assert.equal(quoteAttempts, 0);
		assert.equal(channelWarnings.length, 0);
		assert.equal(harness.fakeClient.sendCalls[0]?.content?.text, "Forwarded");
	} finally {
		harness.cleanup();
	}
});

test("Discord forwarded snapshots mirror content and attachments to WhatsApp", async () => {
	const harness = await setupWhatsAppHarness({ oneWay: 0b11 });
	try {
		utils.whatsapp.createDocumentContent = (attachment) => ({
			document: { url: attachment.url },
			fileName: attachment.name,
			mimetype: attachment.contentType,
		});

		harness.fakeClient.ev.emit("discordMessage", {
			jid: "jid@s.whatsapp.net",
			forwardContext: {
				isForwarded: true,
				sourceChannelId: "chan-a",
				sourceMessageId: "m-1",
				sourceGuildId: "guild-a",
			},
			message: {
				id: "dc-forward-snapshot",
				content: "",
				cleanContent: "",
				webhookId: null,
				author: { username: "BridgeUser" },
				member: { displayName: "BridgeUser" },
				channel: { send: async () => {} },
				attachments: new Map(),
				stickers: new Map(),
				embeds: [],
				wa2dcForwardSnapshot: {
					content: "snapshot text",
					attachments: [
						{
							url: "https://cdn.discordapp.com/attachments/file.png",
							name: "file.png",
							contentType: "image/png",
						},
					],
				},
				mentions: { users: new Map(), members: new Map(), roles: new Map() },
			},
		});

		await delay(0);

		assert.equal(harness.fakeClient.sendCalls.length, 1);
		assert.equal(
			harness.fakeClient.sendCalls[0]?.content?.document?.url,
			"https://cdn.discordapp.com/attachments/file.png",
		);
		assert.equal(
			harness.fakeClient.sendCalls[0]?.content?.caption,
			"Forwarded\nsnapshot text",
		);
	} finally {
		harness.cleanup();
	}
});

test("Discord forwarded snapshot embeds can be mirrored to WhatsApp", async () => {
	const harness = await setupWhatsAppHarness({ oneWay: 0b11 });
	const originalEmbedSetting = state.settings.DiscordEmbedsToWhatsApp;
	try {
		state.settings.DiscordEmbedsToWhatsApp = true;
		utils.whatsapp.createDocumentContent = (attachment) => ({
			document: { url: attachment.url },
			fileName: attachment.name,
			mimetype: attachment.contentType,
		});

		harness.fakeClient.ev.emit("discordMessage", {
			jid: "jid@s.whatsapp.net",
			forwardContext: {
				isForwarded: true,
				sourceChannelId: "chan-a",
				sourceMessageId: "m-1",
				sourceGuildId: "guild-a",
			},
			message: {
				id: "dc-forward-snapshot-embed",
				content: "",
				cleanContent: "",
				webhookId: null,
				author: { username: "BridgeUser" },
				member: { displayName: "BridgeUser" },
				channel: { send: async () => {} },
				attachments: new Map(),
				stickers: new Map(),
				embeds: [],
				wa2dcForwardSnapshot: {
					content: "",
					attachments: [],
					embeds: [
						{
							title: "Snapshot Embed",
							description: "embed body",
							url: "https://example.com/embed",
							image: {
								url: "https://cdn.discordapp.com/attachments/snapshot-embed.png",
							},
						},
					],
				},
				mentions: { users: new Map(), members: new Map(), roles: new Map() },
			},
		});

		await delay(0);

		assert.equal(harness.fakeClient.sendCalls.length, 1);
		const sent = harness.fakeClient.sendCalls[0]?.content || {};
		assert.equal(
			sent.document?.url,
			"https://cdn.discordapp.com/attachments/snapshot-embed.png",
		);
		assert.equal(
			sent.caption,
			"Forwarded\nSnapshot Embed\nembed body\nhttps://example.com/embed",
		);
	} finally {
		state.settings.DiscordEmbedsToWhatsApp = originalEmbedSetting;
		harness.cleanup();
	}
});

test("Discord forwarded snapshot embeds do not duplicate attachment media", async () => {
	const harness = await setupWhatsAppHarness({ oneWay: 0b11 });
	const originalEmbedSetting = state.settings.DiscordEmbedsToWhatsApp;
	try {
		state.settings.DiscordEmbedsToWhatsApp = true;
		utils.whatsapp.createDocumentContent = (attachment) => ({
			document: { url: attachment.url },
			fileName: attachment.name,
			mimetype: attachment.contentType,
		});

		harness.fakeClient.ev.emit("discordMessage", {
			jid: "jid@s.whatsapp.net",
			forwardContext: {
				isForwarded: true,
				sourceChannelId: "chan-a",
				sourceMessageId: "m-1",
				sourceGuildId: "guild-a",
			},
			message: {
				id: "dc-forward-snapshot-embed-dedupe",
				content: "",
				cleanContent: "",
				webhookId: null,
				author: { username: "BridgeUser" },
				member: { displayName: "BridgeUser" },
				channel: { send: async () => {} },
				attachments: new Map(),
				stickers: new Map(),
				embeds: [],
				wa2dcForwardSnapshot: {
					content: "",
					attachments: [
						{
							url: "https://cdn.discordapp.com/attachments/123/456/snapshot-embed.png?ex=abc&is=def&hm=123",
							name: "snapshot-embed.png",
							contentType: "image/png",
						},
					],
					embeds: [
						{
							title: "Snapshot Embed",
							image: {
								proxyURL:
									"https://media.discordapp.net/attachments/123/456/snapshot-embed.png?width=1024&height=1024",
							},
						},
					],
				},
				mentions: { users: new Map(), members: new Map(), roles: new Map() },
			},
		});

		await delay(0);

		assert.equal(harness.fakeClient.sendCalls.length, 1);
		assert.ok(harness.fakeClient.sendCalls[0]?.content?.document?.url);
	} finally {
		state.settings.DiscordEmbedsToWhatsApp = originalEmbedSetting;
		harness.cleanup();
	}
});

test("Discord forwarded snapshots resolve user and role mentions from raw tokens", async () => {
	const harness = await setupWhatsAppHarness({ oneWay: 0b11 });
	const originalMentionLinks = {
		...(state.settings.WhatsAppDiscordMentionLinks || {}),
	};
	const originalContacts = snapshotObject(state.contacts);
	try {
		const linkedJid = "14155550123@s.whatsapp.net";
		state.contacts[linkedJid] = "Panos";
		state.settings.WhatsAppDiscordMentionLinks = {
			[linkedJid]: "123456789012345678",
		};

		harness.fakeClient.ev.emit("discordMessage", {
			jid: "jid@s.whatsapp.net",
			forwardContext: {
				isForwarded: true,
				sourceChannelId: "chan-a",
				sourceMessageId: "m-1",
				sourceGuildId: "guild-a",
			},
			message: {
				id: "dc-forward-mention-snapshot",
				content: "",
				cleanContent: "",
				webhookId: null,
				author: { username: "BridgeUser" },
				member: { displayName: "BridgeUser" },
				channel: { send: async () => {} },
				attachments: new Map(),
				stickers: new Map(),
				embeds: [],
				mentions: { users: new Map(), members: new Map(), roles: new Map() },
				wa2dcForwardSnapshot: {
					content: "Hi <@123456789012345678> and <@&987654321098765432>",
					attachments: [],
				},
				client: {
					users: {
						fetch: async (id) =>
							id === "123456789012345678"
								? { id, username: "panos-discord", globalName: "Panos" }
								: null,
					},
				},
				guild: {
					members: {
						cache: new Map(),
						fetch: async (id) =>
							id === "123456789012345678" ? { id, displayName: "Panos" } : null,
					},
					roles: {
						cache: new Map(),
						fetch: async (id) =>
							id === "987654321098765432" ? { id, name: "Moderators" } : null,
					},
				},
			},
		});

		await delay(0);

		assert.equal(harness.fakeClient.sendCalls.length, 1);
		assert.equal(
			harness.fakeClient.sendCalls[0]?.content?.text,
			"Forwarded\nHi @14155550123 and @Moderators",
		);
		assert.deepEqual(harness.fakeClient.sendCalls[0]?.content?.mentions, [
			linkedJid,
		]);
	} finally {
		state.settings.WhatsAppDiscordMentionLinks = originalMentionLinks;
		restoreObject(state.contacts, originalContacts);
		harness.cleanup();
	}
});

test("Discord replies to newsletter chats attempt WhatsApp quote lookup", async () => {
	const harness = await setupWhatsAppHarness({ oneWay: 0b11 });
	try {
		let quoteAttempts = 0;
		utils.whatsapp.createQuoteMessage = async () => {
			quoteAttempts += 1;
			return { key: { id: "wa-quote-1" } };
		};

		harness.fakeClient.ev.emit("discordMessage", {
			jid: "120363123456789@newsletter",
			message: {
				id: "dc-newsletter-reply",
				content: "newsletter post",
				cleanContent: "newsletter post",
				reference: { channelId: "chan-1", messageId: "msg-1" },
				webhookId: null,
				author: { username: "BridgeUser" },
				member: { displayName: "BridgeUser" },
				channel: { send: async () => {} },
				attachments: new Map(),
				stickers: new Map(),
				embeds: [],
				mentions: { users: new Map(), members: new Map(), roles: new Map() },
			},
		});

		await delay(0);

		assert.equal(quoteAttempts, 1);
		assert.equal(harness.fakeClient.sendCalls.length, 1);
		assert.equal(
			harness.fakeClient.sendCalls[0]?.content?.text,
			"newsletter post",
		);
		assert.ok(harness.fakeClient.sendCalls[0]?.options?.quoted);
	} finally {
		harness.cleanup();
	}
});

test("Newsletter quoted sends do not perform ack retry fallback by default", async () => {
	const harness = await setupWhatsAppHarness({ oneWay: 0b11 });
	try {
		utils.whatsapp.createQuoteMessage = async () => ({
			key: { id: "wa-quote-ack-retry" },
		});

		harness.fakeClient.sendMessage = async (jid, content, options) => {
			harness.fakeClient.sendCalls.push({ jid, content, options });
			harness.fakeClient._sendCounter += 1;
			const outboundId = `ack-quote-retry-${harness.fakeClient._sendCounter}`;
			return {
				key: {
					id: outboundId,
					remoteJid: jid,
					server_id: `server-${harness.fakeClient._sendCounter}`,
				},
			};
		};

		harness.fakeClient.ev.emit("discordMessage", {
			jid: "120363123456789@newsletter",
			message: {
				id: "dc-newsletter-ack-quote-retry",
				content: "newsletter post",
				cleanContent: "newsletter post",
				reference: { channelId: "chan-1", messageId: "msg-1" },
				webhookId: null,
				author: { username: "BridgeUser" },
				member: { displayName: "BridgeUser" },
				channel: { send: async () => {} },
				attachments: new Map(),
				stickers: new Map(),
				embeds: [],
				mentions: { users: new Map(), members: new Map(), roles: new Map() },
			},
		});

		await delay(0);

		assert.equal(harness.fakeClient.sendCalls.length, 1);
		assert.ok(harness.fakeClient.sendCalls[0]?.options?.quoted);
	} finally {
		harness.cleanup();
	}
});

test("Newsletter replies without quote mapping send without fallback reply-context text by default", async () => {
	const harness = await setupWhatsAppHarness({ oneWay: 0b11 });
	try {
		const notices = [];
		utils.whatsapp.createQuoteMessage = async () => null;

		harness.fakeClient.ev.emit("discordMessage", {
			jid: "120363123456789@newsletter",
			message: {
				id: "dc-newsletter-reply-fallback",
				content: "newsletter post",
				cleanContent: "newsletter post",
				reference: { channelId: "chan-1", messageId: "msg-1" },
				webhookId: null,
				author: { username: "BridgeUser" },
				member: { displayName: "BridgeUser" },
				channel: {
					send: async (value) => {
						notices.push(value);
					},
				},
				attachments: new Map(),
				stickers: new Map(),
				embeds: [],
				mentions: { users: new Map(), members: new Map(), roles: new Map() },
				client: {
					channels: {
						fetch: async () => ({
							messages: {
								fetch: async () => ({
									content: "Original replied message body",
									cleanContent: "Original replied message body",
									author: { username: "ReplyUser" },
									member: { displayName: "ReplyUser" },
									attachments: new Map(),
								}),
							},
						}),
					},
				},
			},
		});

		await delay(0);

		assert.equal(harness.fakeClient.sendCalls.length, 1);
		const sentText = harness.fakeClient.sendCalls[0]?.content?.text || "";
		assert.equal(sentText, "newsletter post");
		assert.equal(notices.length, 1);
		assert.ok(notices[0].includes("Couldn't find the message quoted."));
	} finally {
		harness.cleanup();
	}
});

test("Newsletter image attachments with fallback disabled are not sent to WhatsApp media", async () => {
	const harness = await setupWhatsAppHarness({ oneWay: 0b11 });
	try {
		const pngBase64 =
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==";
		const attachmentUrl = `data:image/png;base64,${pngBase64}`;

		const notices = [];
		harness.fakeClient.ev.emit("discordMessage", {
			jid: "120363123456789@newsletter",
			forwardContext: null,
			message: {
				id: "dc-newsletter-infer-image",
				content: "",
				cleanContent: "",
				webhookId: null,
				author: { username: "BridgeUser" },
				member: { displayName: "BridgeUser" },
				channel: {
					send: async (value) => {
						notices.push(value);
					},
				},
				attachments: new Map([
					[
						"attachment-1",
						{
							id: "attachment-1",
							url: attachmentUrl,
							name: "photo.png",
							contentType: "image/png",
						},
					],
				]),
				stickers: new Map(),
				embeds: [],
				mentions: { users: new Map(), members: new Map(), roles: new Map() },
			},
		});

		await delay(200);

		assert.equal(harness.fakeClient.sendCalls.length, 0);
		assert.equal(notices.length, 1);
		assert.ok(String(notices[0]).includes("fallback is disabled"));
	} finally {
		harness.cleanup();
	}
});

test("Newsletter unsupported attachments are skipped with FAQ notice", async () => {
	const harness = await setupWhatsAppHarness({ oneWay: 0b11 });
	try {
		const notices = [];
		harness.fakeClient.ev.emit("discordMessage", {
			jid: "120363123456789@newsletter",
			forwardContext: null,
			message: {
				id: "dc-newsletter-infer-voice",
				content: "",
				cleanContent: "",
				webhookId: null,
				author: { username: "BridgeUser" },
				member: { displayName: "BridgeUser" },
				channel: {
					send: async (value) => {
						notices.push(value);
					},
				},
				attachments: new Map([
					[
						"attachment-1",
						{
							id: "attachment-1",
							url: "https://cdn.discordapp.com/attachments/123/456/voice-message.ogg",
							name: "document.pdf",
							contentType: "application/pdf",
						},
					],
				]),
				stickers: new Map(),
				embeds: [],
				mentions: { users: new Map(), members: new Map(), roles: new Map() },
			},
		});

		const notified = await waitFor(() => notices.length === 1, {
			timeoutMs: 1500,
		});

		assert.equal(notified, true);
		assert.equal(harness.fakeClient.sendCalls.length, 0);
		assert.equal(notices.length, 1);
		assert.ok(String(notices[0]).includes("allow only image/video"));
		assert.ok(
			extractUrls(notices[0]).some(
				(url) => url === "https://faq.whatsapp.com/549900560675125",
			),
		);
	} finally {
		harness.cleanup();
	}
});

test("Newsletter URL fallback enabled sends image attachments as plain links", async () => {
	const harness = await setupWhatsAppHarness({ oneWay: 0b11 });
	try {
		state.settings.NewsletterMediaUrlFallback = true;
		utils.whatsapp.createDocumentContent = (attachment) => ({
			document: { url: attachment.url },
			fileName: attachment.name,
			mimetype: attachment.contentType,
		});

		harness.fakeClient.sendMessage = async (jid, content, options) => {
			harness.fakeClient.sendCalls.push({ jid, content, options });
			harness.fakeClient._sendCounter += 1;
			return {
				key: { id: `sent-${harness.fakeClient._sendCounter}`, remoteJid: jid },
			};
		};

		const notices = [];
		harness.fakeClient.ev.emit("discordMessage", {
			jid: "120363123456789@newsletter",
			forwardContext: {
				isForwarded: true,
				sourceChannelId: "chan-a",
				sourceMessageId: "m-1",
				sourceGuildId: "guild-a",
			},
			message: {
				id: "dc-newsletter-attachment-fallback",
				content: "",
				cleanContent: "",
				webhookId: null,
				author: { username: "BridgeUser" },
				member: { displayName: "BridgeUser" },
				channel: {
					send: async (value) => {
						notices.push(value);
					},
				},
				attachments: new Map(),
				stickers: new Map(),
				embeds: [],
				wa2dcForwardSnapshot: {
					content: "snapshot text",
					attachments: [
						{
							url: "https://example.com/file.png",
							name: "file.png",
							contentType: "image/png",
						},
					],
				},
				mentions: { users: new Map(), members: new Map(), roles: new Map() },
			},
		});

		await delay(50);

		assert.equal(harness.fakeClient.sendCalls.length, 1);
		assert.equal(
			harness.fakeClient.sendCalls[0]?.content?.text,
			"Forwarded\nsnapshot text https://example.com/file.png",
		);
		assert.equal(notices.length, 1);
		assert.ok(String(notices[0]).includes("fallback is enabled"));
	} finally {
		harness.cleanup();
	}
});

test("Newsletter URL fallback disabled drops image attachments and posts a notice", async () => {
	const harness = await setupWhatsAppHarness({ oneWay: 0b11 });
	try {
		const pngBase64 =
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==";
		const attachmentUrl = `data:image/png;base64,${pngBase64}`;

		const notices = [];
		harness.fakeClient.ev.emit("discordMessage", {
			jid: "120363123456789@newsletter",
			forwardContext: null,
			message: {
				id: "dc-newsletter-attachment-ack-fallback",
				content: "",
				cleanContent: "",
				webhookId: null,
				author: { username: "BridgeUser" },
				member: { displayName: "BridgeUser" },
				channel: {
					send: async (value) => {
						notices.push(value);
					},
				},
				attachments: new Map([
					[
						"attachment-1",
						{
							id: "attachment-1",
							url: attachmentUrl,
							name: "newsletter-photo.png",
							contentType: "image/png",
						},
					],
				]),
				stickers: new Map(),
				embeds: [],
				mentions: { users: new Map(), members: new Map(), roles: new Map() },
			},
		});

		await delay(200);

		assert.equal(harness.fakeClient.sendCalls.length, 0);
		assert.equal(notices.length, 1);
		assert.ok(String(notices[0]).includes("fallback is disabled"));
	} finally {
		harness.cleanup();
	}
});

test("Newsletter URL fallback enabled never sends WhatsApp media payloads", async () => {
	const harness = await setupWhatsAppHarness({ oneWay: 0b11 });
	try {
		state.settings.NewsletterMediaUrlFallback = true;
		const notices = [];

		harness.fakeClient.ev.emit("discordMessage", {
			jid: "120363123456789@newsletter",
			forwardContext: null,
			message: {
				id: "dc-newsletter-url-fallback-no-media",
				content: "caption text",
				cleanContent: "caption text",
				webhookId: null,
				author: { username: "BridgeUser" },
				member: { displayName: "BridgeUser" },
				channel: {
					send: async (value) => {
						notices.push(value);
					},
				},
				attachments: new Map([
					[
						"attachment-1",
						{
							id: "attachment-1",
							url: "https://example.com/newsletter-photo.png",
							name: "newsletter-photo.png",
							contentType: "image/png",
						},
					],
				]),
				stickers: new Map(),
				embeds: [],
				mentions: { users: new Map(), members: new Map(), roles: new Map() },
			},
		});

		await delay(200);

		assert.equal(harness.fakeClient.sendCalls.length, 1);
		assert.equal(
			harness.fakeClient.sendCalls[0]?.content?.text,
			"caption text https://example.com/newsletter-photo.png",
		);
		assert.equal(
			Boolean(harness.fakeClient.sendCalls[0]?.content?.image),
			false,
		);
		assert.equal(
			Boolean(harness.fakeClient.sendCalls[0]?.content?.video),
			false,
		);
		assert.equal(
			Boolean(harness.fakeClient.sendCalls[0]?.content?.document),
			false,
		);
		assert.equal(notices.length, 1);
		assert.ok(String(notices[0]).includes("fallback is enabled"));
	} finally {
		harness.cleanup();
	}
});

test("Newsletter URL fallback enabled keeps only image/video links and notifies for unsupported files", async () => {
	const harness = await setupWhatsAppHarness({ oneWay: 0b11 });
	try {
		state.settings.NewsletterMediaUrlFallback = true;
		const notices = [];

		harness.fakeClient.ev.emit("discordMessage", {
			jid: "120363123456789@newsletter",
			forwardContext: null,
			message: {
				id: "dc-newsletter-url-fallback-mixed",
				content: "",
				cleanContent: "",
				webhookId: null,
				author: { username: "BridgeUser" },
				member: { displayName: "BridgeUser" },
				channel: {
					send: async (value) => {
						notices.push(value);
					},
				},
				attachments: new Map([
					[
						"attachment-1",
						{
							id: "attachment-1",
							url: "https://example.com/newsletter-photo.jpg",
							name: "newsletter-photo.jpg",
							contentType: "image/jpeg",
						},
					],
					[
						"attachment-2",
						{
							id: "attachment-2",
							url: "https://example.com/newsletter-doc.pdf",
							name: "newsletter-doc.pdf",
							contentType: "application/pdf",
						},
					],
				]),
				stickers: new Map(),
				embeds: [],
				mentions: { users: new Map(), members: new Map(), roles: new Map() },
			},
		});

		await delay(200);

		assert.equal(harness.fakeClient.sendCalls.length, 1);
		assert.equal(
			harness.fakeClient.sendCalls[0]?.content?.text,
			"https://example.com/newsletter-photo.jpg",
		);
		assert.equal(
			Boolean(harness.fakeClient.sendCalls[0]?.content?.image),
			false,
		);
		assert.equal(
			Boolean(harness.fakeClient.sendCalls[0]?.content?.video),
			false,
		);
		assert.equal(
			Boolean(harness.fakeClient.sendCalls[0]?.content?.document),
			false,
		);
		assert.equal(notices.length, 2);
		assert.ok(
			notices.some((value) => String(value).includes("allow only image/video")),
		);
		assert.ok(
			notices.some((value) =>
				extractUrls(value).some(
					(url) => url === "https://faq.whatsapp.com/549900560675125",
				),
			),
		);
		assert.ok(
			notices.some((value) => String(value).includes("fallback is enabled")),
		);
	} finally {
		harness.cleanup();
	}
});

test("Newsletter URL fallback disabled keeps text and drops attachment links", async () => {
	const harness = await setupWhatsAppHarness({ oneWay: 0b11 });
	try {
		const notices = [];

		harness.fakeClient.ev.emit("discordMessage", {
			jid: "120363123456789@newsletter",
			forwardContext: null,
			message: {
				id: "dc-newsletter-disabled-text-only",
				content: "message body",
				cleanContent: "message body",
				webhookId: null,
				author: { username: "BridgeUser" },
				member: { displayName: "BridgeUser" },
				channel: {
					send: async (value) => {
						notices.push(value);
					},
				},
				attachments: new Map([
					[
						"attachment-1",
						{
							id: "attachment-1",
							url: "https://example.com/newsletter-photo.png",
							name: "newsletter-photo.png",
							contentType: "image/png",
						},
					],
				]),
				stickers: new Map(),
				embeds: [],
				mentions: { users: new Map(), members: new Map(), roles: new Map() },
			},
		});

		const settled = await waitFor(
			() => harness.fakeClient.sendCalls.length === 1 && notices.length === 1,
			{ timeoutMs: 1500 },
		);

		assert.equal(settled, true);
		assert.equal(harness.fakeClient.sendCalls.length, 1);
		assert.equal(
			harness.fakeClient.sendCalls[0]?.content?.text,
			"message body",
		);
		assert.equal(notices.length, 1);
		assert.ok(String(notices[0]).includes("fallback is disabled"));
	} finally {
		harness.cleanup();
	}
});

test("Newsletter send wrapper rewrites image upload paths from /o1/ to /m1/", async () => {
	const harness = await setupWhatsAppHarness();
	try {
		harness.fakeClient.waUploadToServer = async () => ({
			mediaUrl: "https://mmg.whatsapp.net/o1/v/t24/f2/m123/example",
			directPath: "/o1/v/t24/f2/m123/example",
		});

		await harness.fakeClient.sendMessage("120363123456789@newsletter", {
			text: "hello",
		});

		const lastSend =
			harness.fakeClient.sendCalls[harness.fakeClient.sendCalls.length - 1];
		assert.equal(typeof lastSend?.options?.upload, "function");

		const rewritten = await lastSend.options.upload("/tmp/mock-file", {
			mediaType: "image",
		});
		assert.equal(rewritten?.directPath, "/m1/v/t24/f2/m123/example");
		assert.equal(
			rewritten?.mediaUrl,
			"https://mmg.whatsapp.net/m1/v/t24/f2/m123/example",
		);
	} finally {
		harness.cleanup();
	}
});

test("Ack-rejected newsletter fromMe upserts are not mirrored back to Discord", async () => {
	const harness = await setupWhatsAppHarness();
	try {
		harness.fakeClient.ev.emit("messages.update", [
			{
				key: {
					id: "newsletter-ack-rejected-1",
					remoteJid: "120363123456789@newsletter",
					fromMe: true,
				},
				update: {
					status: WAMessageStatus.ERROR,
					messageStubParameters: ["479"],
				},
			},
		]);
		await delay(0);

		harness.fakeClient.ev.emit("messages.upsert", {
			type: "notify",
			messages: [
				{
					key: {
						id: "newsletter-ack-rejected-1",
						remoteJid: "120363123456789@newsletter",
						fromMe: true,
					},
					message: "ghost copy should be skipped",
				},
			],
		});
		await delay(0);

		assert.equal(harness.forwarded.messages.length, 0);
	} finally {
		harness.cleanup();
	}
});

test("oneWay gating blocks Discord -> WhatsApp sends", async () => {
	const harness = await setupWhatsAppHarness({ oneWay: 0b01 });
	try {
		harness.fakeClient.ev.emit("discordDelete", {
			jid: "jid@s.whatsapp.net",
			id: "wa-msg",
		});
		harness.fakeClient.ev.emit("discordEdit", {
			jid: "jid@s.whatsapp.net",
			message: {
				id: "dc-msg",
				cleanContent: "edited",
				content: "edited",
				webhookId: null,
				author: { username: "You" },
				channel: { send: async () => {} },
			},
		});
		harness.fakeClient.ev.emit("discordReaction", {
			jid: "jid@s.whatsapp.net",
			removed: false,
			reaction: {
				emoji: { name: "🔥" },
				message: {
					id: "dc-react",
					webhookId: null,
					author: { username: "You" },
				},
			},
		});
		await delay(0);
		assert.equal(harness.fakeClient.sendCalls.length, 0);
	} finally {
		harness.cleanup();
	}
});

test("WhatsApp delete events emit whatsappDelete to Discord", async () => {
	const harness = await setupWhatsAppHarness();
	try {
		harness.fakeClient.ev.emit("messages.delete", {
			keys: [{ id: "wa-del", remoteJid: "jid@s.whatsapp.net" }],
		});
		await delay(0);
		assert.deepEqual(harness.forwarded.deletes, [
			{ id: "wa-del", jid: "jid@s.whatsapp.net" },
		]);
	} finally {
		harness.cleanup();
	}
});

test("WhatsApp edited messages are flagged as edits", async () => {
	const harness = await setupWhatsAppHarness({
		getMessageType: () => "editedMessage",
	});
	try {
		harness.fakeClient.ev.emit("messages.upsert", {
			type: "notify",
			messages: [
				{
					key: { id: "edit-id", remoteJid: "jid@s.whatsapp.net" },
					message: "edited hello",
				},
			],
		});
		await delay(0);
		assert.equal(harness.forwarded.messages[0]?.isEdit, true);
	} finally {
		harness.cleanup();
	}
});
