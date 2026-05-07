import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { proto } from "@whiskeysockets/baileys";

import {
	resetClientFactoryOverrides,
	setClientFactoryOverrides,
} from "../src/clientFactories.js";
import state from "../src/state.js";
import utils from "../src/utils.js";

const snapshotObject = (value) => ({ ...value });
const restoreObject = (target, snapshot) => {
	Object.keys(target).forEach((key) => {
		delete target[key];
	});
	Object.assign(target, snapshot);
};

const stubWhatsappUtils = () => ({
	_profilePicsCache: {},
	sendQR() {},
	updateContacts() {},
	formatJid: (jid) => jid,
	hydrateJidPair: async (jid) => [jid, null],
	migrateLegacyJid() {},
	isPhoneJid: () => true,
	generateLinkPreview: async () => null,
	deleteSession: async () => {},
});

class FakeWhatsAppClient {
	constructor() {
		this.ev = new EventEmitter();
		this.contacts = {};
		this.signalRepository = {};
		this.ws = { on() {} };
		this.groupFetchCalls = 0;
	}

	async sendMessage() {
		return { key: { id: "sent-1", remoteJid: "jid@s.whatsapp.net" } };
	}

	async groupMetadata() {
		return null;
	}

	async groupFetchAllParticipating() {
		this.groupFetchCalls += 1;
		return {};
	}
}

const waitFor = async (predicate, { timeoutMs = 750, intervalMs = 5 } = {}) => {
	const deadline = Date.now() + timeoutMs;

	while (true) {
		if (predicate()) {
			return true;
		}
		if (Date.now() >= deadline) {
			return false;
		}

		await delay(intervalMs);
	}
};

test("connection.update ignores Discord send failures and still reconnects", async () => {
	const originalLogger = state.logger;
	const originalShutdownRequested = state.shutdownRequested;
	const originalContacts = snapshotObject(state.contacts);
	const originalGetControlChannel = utils.discord.getControlChannel;
	const originalWhatsappUtils = utils.whatsapp;

	try {
		state.logger = { info() {}, error() {}, warn() {}, debug() {} };
		state.shutdownRequested = false;
		restoreObject(state.contacts, {});

		let sendCalls = 0;
		const controlChannel = {
			send: async () => {
				sendCalls += 1;
				throw new Error("token unavailable");
			},
		};
		utils.discord.getControlChannel = async () => controlChannel;
		utils.whatsapp = stubWhatsappUtils();

		const createdClients = [];
		setClientFactoryOverrides({
			createWhatsAppClient: () => {
				const client = new FakeWhatsAppClient();
				createdClients.push(client);
				return client;
			},
			getBaileysVersion: async () => ({ version: [1, 0, 0] }),
		});

		const { connectToWhatsApp } = await import("../src/whatsappHandler.js");
		const client = await connectToWhatsApp(1);
		assert.equal(createdClients.length, 1);

		let unhandled;
		const onUnhandled = (reason) => {
			unhandled = reason;
		};
		process.once("unhandledRejection", onUnhandled);

		client.ev.emit("connection.update", {
			connection: "close",
			lastDisconnect: { error: { output: { statusCode: 500 } } },
		});

		const reconnected = await waitFor(() => createdClients.length >= 2, {
			timeoutMs: 1500,
		});
		process.removeListener("unhandledRejection", onUnhandled);

		assert.equal(unhandled, undefined);
		assert.ok(
			reconnected,
			`Expected reconnect attempt, but only saw ${createdClients.length} client(s).`,
		);
		assert.ok(sendCalls >= 1);
	} finally {
		state.logger = originalLogger;
		state.shutdownRequested = originalShutdownRequested;
		restoreObject(state.contacts, originalContacts);
		utils.discord.getControlChannel = originalGetControlChannel;
		utils.whatsapp = originalWhatsappUtils;
		resetClientFactoryOverrides();
	}
});

test("WhatsApp client config avoids full/recent history sync buffering", async () => {
	const originalLogger = state.logger;
	const originalShutdownRequested = state.shutdownRequested;
	const originalContacts = snapshotObject(state.contacts);
	const originalGetControlChannel = utils.discord.getControlChannel;
	const originalWhatsappUtils = utils.whatsapp;

	try {
		state.logger = { info() {}, error() {}, warn() {}, debug() {} };
		state.shutdownRequested = false;
		restoreObject(state.contacts, {});
		utils.discord.getControlChannel = async () => null;
		utils.whatsapp = stubWhatsappUtils();

		let createdConfig = null;
		setClientFactoryOverrides({
			createWhatsAppClient: (config) => {
				createdConfig = config;
				return new FakeWhatsAppClient();
			},
			getBaileysVersion: async () => ({ version: [1, 0, 0] }),
		});

		const { connectToWhatsApp } = await import("../src/whatsappHandler.js");
		await connectToWhatsApp(1);

		assert.equal(createdConfig.syncFullHistory, false);
		assert.equal(
			createdConfig.shouldSyncHistoryMessage({
				syncType: proto.HistorySync.HistorySyncType.RECENT,
			}),
			false,
		);
		assert.equal(
			createdConfig.shouldSyncHistoryMessage({
				syncType: proto.HistorySync.HistorySyncType.FULL,
			}),
			false,
		);
		assert.equal(
			createdConfig.shouldSyncHistoryMessage({
				syncType: proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP,
			}),
			false,
		);
		assert.equal(
			createdConfig.shouldSyncHistoryMessage({
				syncType: proto.HistorySync.HistorySyncType.NON_BLOCKING_DATA,
			}),
			false,
		);
		assert.equal(
			createdConfig.shouldSyncHistoryMessage({
				syncType: proto.HistorySync.HistorySyncType.INITIAL_STATUS_V3,
			}),
			false,
		);
		assert.equal(
			createdConfig.shouldSyncHistoryMessage({
				syncType: proto.HistorySync.HistorySyncType.PUSH_NAME,
			}),
			true,
		);
	} finally {
		state.logger = originalLogger;
		state.shutdownRequested = originalShutdownRequested;
		restoreObject(state.contacts, originalContacts);
		utils.discord.getControlChannel = originalGetControlChannel;
		utils.whatsapp = originalWhatsappUtils;
		resetClientFactoryOverrides();
	}
});

test("Baileys logger bounds bundled traces and binary payloads", async () => {
	const originalLogger = state.logger;
	const originalShutdownRequested = state.shutdownRequested;
	const originalContacts = snapshotObject(state.contacts);
	const originalGetControlChannel = utils.discord.getControlChannel;
	const originalWhatsappUtils = utils.whatsapp;

	try {
		const calls = [];
		state.logger = {
			info: (...args) => calls.push(args),
			error: (...args) => calls.push(args),
			warn: (...args) => calls.push(args),
			debug: (...args) => calls.push(args),
		};
		state.shutdownRequested = false;
		restoreObject(state.contacts, {});
		utils.discord.getControlChannel = async () => null;
		utils.whatsapp = stubWhatsappUtils();

		let createdConfig = null;
		setClientFactoryOverrides({
			createWhatsAppClient: (config) => {
				createdConfig = config;
				return new FakeWhatsAppClient();
			},
			getBaileysVersion: async () => ({ version: [1, 0, 0] }),
		});

		const { connectToWhatsApp } = await import("../src/whatsappHandler.js");
		await connectToWhatsApp(1);

		const err = new Error("restart required");
		err.stack = `Error: restart required\n    at data:text/javascript;base64,${"x".repeat(100_000)}`;
		createdConfig.logger.info(
			{
				trace: `data:text/javascript;base64,${"y".repeat(100_000)}`,
				err,
				buffer: Buffer.alloc(4096),
			},
			"connection errored",
		);

		assert.equal(calls.length, 1);
		assert.ok(
			JSON.stringify(calls[0]).length < 4000,
			"Baileys log payload should be bounded",
		);
		assert.equal(calls[0][0].buffer.byteLength, 4096);
		assert.match(calls[0][0].trace, /omitted .* bundled stack trace/u);
	} finally {
		state.logger = originalLogger;
		state.shutdownRequested = originalShutdownRequested;
		restoreObject(state.contacts, originalContacts);
		utils.discord.getControlChannel = originalGetControlChannel;
		utils.whatsapp = originalWhatsappUtils;
		resetClientFactoryOverrides();
	}
});

test("connection open does not eagerly fetch all participating groups", async () => {
	const originalLogger = state.logger;
	const originalShutdownRequested = state.shutdownRequested;
	const originalContacts = snapshotObject(state.contacts);
	const originalGetControlChannel = utils.discord.getControlChannel;
	const originalWhatsappUtils = utils.whatsapp;

	try {
		state.logger = { info() {}, error() {}, warn() {}, debug() {} };
		state.shutdownRequested = false;
		restoreObject(state.contacts, {});
		utils.discord.getControlChannel = async () => null;
		utils.whatsapp = stubWhatsappUtils();

		const client = new FakeWhatsAppClient();
		setClientFactoryOverrides({
			createWhatsAppClient: () => client,
			getBaileysVersion: async () => ({ version: [1, 0, 0] }),
		});

		const { connectToWhatsApp } = await import("../src/whatsappHandler.js");
		await connectToWhatsApp(1);

		client.ev.emit("connection.update", { connection: "open" });
		await delay(20);

		assert.equal(client.groupFetchCalls, 0);
	} finally {
		state.logger = originalLogger;
		state.shutdownRequested = originalShutdownRequested;
		restoreObject(state.contacts, originalContacts);
		utils.discord.getControlChannel = originalGetControlChannel;
		utils.whatsapp = originalWhatsappUtils;
		resetClientFactoryOverrides();
	}
});

test("restartRequired reconnects without logging raw Baileys payloads", async () => {
	const originalLogger = state.logger;
	const originalShutdownRequested = state.shutdownRequested;
	const originalContacts = snapshotObject(state.contacts);
	const originalGetControlChannel = utils.discord.getControlChannel;
	const originalWhatsappUtils = utils.whatsapp;

	try {
		const warnings = [];
		state.logger = {
			info() {},
			error() {
				throw new Error("raw disconnect should not be logged as error");
			},
			warn(payload, message) {
				warnings.push({ payload, message });
			},
			debug() {},
		};
		state.shutdownRequested = false;
		restoreObject(state.contacts, {});

		const controlMessages = [];
		const controlChannel = {
			send: async (message) => {
				controlMessages.push(message);
			},
		};
		utils.discord.getControlChannel = async () => controlChannel;
		utils.whatsapp = stubWhatsappUtils();

		const createdClients = [];
		setClientFactoryOverrides({
			createWhatsAppClient: () => {
				const client = new FakeWhatsAppClient();
				createdClients.push(client);
				return client;
			},
			getBaileysVersion: async () => ({ version: [1, 0, 0] }),
		});

		const { connectToWhatsApp } = await import("../src/whatsappHandler.js");
		const client = await connectToWhatsApp(1);
		const hugeError = new Error("restart required");
		hugeError.output = {
			statusCode: 515,
			payload: "x".repeat(2_000_000),
		};

		client.ev.emit("connection.update", {
			connection: "close",
			lastDisconnect: { error: hugeError },
		});

		const reconnected = await waitFor(() => createdClients.length >= 2, {
			timeoutMs: 1500,
		});

		assert.equal(reconnected, true);
		assert.deepEqual(controlMessages, [
			"WhatsApp pairing restart requested. Reconnecting with the saved session...",
		]);
		assert.ok(warnings.length >= 1);
		assert.ok(
			JSON.stringify(warnings[0]).length < 2000,
			"disconnect warning should be bounded",
		);
	} finally {
		state.logger = originalLogger;
		state.shutdownRequested = originalShutdownRequested;
		restoreObject(state.contacts, originalContacts);
		utils.discord.getControlChannel = originalGetControlChannel;
		utils.whatsapp = originalWhatsappUtils;
		resetClientFactoryOverrides();
	}
});

test("connection.update no-ops during shutdown", async () => {
	const originalLogger = state.logger;
	const originalShutdownRequested = state.shutdownRequested;
	const originalContacts = snapshotObject(state.contacts);
	const originalGetControlChannel = utils.discord.getControlChannel;
	const originalWhatsappUtils = utils.whatsapp;

	try {
		state.logger = { info() {}, error() {}, warn() {}, debug() {} };
		state.shutdownRequested = false;
		restoreObject(state.contacts, {});

		let sendCalls = 0;
		const controlChannel = {
			send: async () => {
				sendCalls += 1;
			},
		};
		utils.discord.getControlChannel = async () => controlChannel;
		utils.whatsapp = stubWhatsappUtils();

		const createdClients = [];
		setClientFactoryOverrides({
			createWhatsAppClient: () => {
				const client = new FakeWhatsAppClient();
				createdClients.push(client);
				return client;
			},
			getBaileysVersion: async () => ({ version: [1, 0, 0] }),
		});

		const { connectToWhatsApp } = await import("../src/whatsappHandler.js");
		const client = await connectToWhatsApp(1);
		assert.equal(createdClients.length, 1);

		state.shutdownRequested = true;

		let unhandled;
		const onUnhandled = (reason) => {
			unhandled = reason;
		};
		process.once("unhandledRejection", onUnhandled);

		client.ev.emit("connection.update", {
			connection: "close",
			lastDisconnect: { error: { output: { statusCode: 500 } } },
		});

		await delay(50);
		process.removeListener("unhandledRejection", onUnhandled);

		assert.equal(unhandled, undefined);
		assert.equal(createdClients.length, 1);
		assert.equal(sendCalls, 0);
	} finally {
		state.logger = originalLogger;
		state.shutdownRequested = originalShutdownRequested;
		restoreObject(state.contacts, originalContacts);
		utils.discord.getControlChannel = originalGetControlChannel;
		utils.whatsapp = originalWhatsappUtils;
		resetClientFactoryOverrides();
	}
});
