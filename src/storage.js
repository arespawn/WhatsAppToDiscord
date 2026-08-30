import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import discordJs from "discord.js";
import { normalizeChatLinks } from "./chatLinks.js";
import { createDiscordClient } from "./clientFactories.js";
import { normalizeSettings } from "./contracts.js";
import {
	createRecentMessageMap,
	getRecentMessageMapStats,
} from "./internal/recentMessageMap.js";
import sqliteStore from "./persistence/sqliteStore.js";
import state from "./state.js";

const isSmokeTest = process.env.WA2DC_SMOKE_TEST === "1";
const STORAGE_DIR_MODE = 0o700;
const CATASTROPHIC_MAPPING_DROP_MIN_ENTRIES = 100;
const CATASTROPHIC_MAPPING_DROP_RATIO = 0.5;

const { ChannelType, GatewayIntentBits } = discordJs;

const sanitizeStorageKey = (name = "") => {
	const raw = String(name)
		.replace(/[\\/]+/g, "-")
		.replace(/\0/g, "")
		.trim();
	const base = path.basename(raw);
	if (!base || base === "." || base === "..") {
		throw new Error(`Invalid storage key: ${name}`);
	}
	return base;
};

const storage = {
	_storageDir: "./storage/",
	_initialized: false,
	_lastMessagesSnapshot: null,
	_saveQueue: Promise.resolve(),
	_settingsName: "settings",
	_chatsName: "chats",
	_contactsName: "contacts",
	_lastMessagesName: "lastMessages",
	_startTimeName: "lastTimestamp",

	async ensureStorageDir() {
		await fs.mkdir(this._storageDir, {
			recursive: true,
			mode: STORAGE_DIR_MODE,
		});
		if (process.platform !== "win32") {
			await fs.chmod(this._storageDir, STORAGE_DIR_MODE).catch(() => {});
		}
	},

	async init() {
		if (this._initialized) {
			return;
		}

		await this.ensureStorageDir();
		sqliteStore.setStorageDir(this._storageDir);
		await sqliteStore.init({ logger: state.logger });
		this._initialized = true;
	},

	async ensureInitialized() {
		await this.init();
	},

	async close() {
		await this._saveQueue.catch(() => {});
		sqliteStore.close();
		this._initialized = false;
		this._lastMessagesSnapshot = null;
		this._saveQueue = Promise.resolve();
	},

	async upsert(name, data) {
		await this.ensureInitialized();
		const key = sanitizeStorageKey(name);
		sqliteStore.setAppState(key, String(data));
	},

	async get(name) {
		await this.ensureInitialized();
		const key = sanitizeStorageKey(name);
		const value = sqliteStore.getAppState(key);
		return value == null ? null : Buffer.from(value, "utf8");
	},

	async saveSettings() {
		await this.ensureInitialized();
		sqliteStore.setAppState(this._settingsName, JSON.stringify(state.settings));
	},

	async parseSettings() {
		if (isSmokeTest) {
			const smokeDefaults = {
				Token: "SMOKE_TOKEN",
				GuildID: "SMOKE_GUILD",
				Categories: [],
				ControlChannelID: "SMOKE_CONTROL",
				Publish: false,
				LocalDownloadServer: false,
			};
			return Object.assign(state.settings, normalizeSettings(smokeDefaults));
		}

		await this.ensureInitialized();
		const result = sqliteStore.getAppState(this._settingsName);
		if (result == null) {
			return setup.firstRun();
		}

		try {
			const settings = Object.assign(
				state.settings,
				normalizeSettings(JSON.parse(result), { logger: state.logger }),
			);
			if (settings.Token === "") return setup.firstRun();
			return settings;
		} catch {
			return setup.firstRun();
		}
	},

	async parseChats() {
		await this.ensureInitialized();
		const result = sqliteStore.getAppState(this._chatsName);
		return result ? normalizeChatLinks(JSON.parse(result)) : {};
	},

	async parseContacts() {
		await this.ensureInitialized();
		const result = sqliteStore.getAppState(this._contactsName);
		return result ? JSON.parse(result) : {};
	},

	async parseLastMessages() {
		await this.ensureInitialized();
		const result = sqliteStore.getAppState(this._lastMessagesName);
		const capacity = state.settings.lastMessageStorage * 2;
		if (!result) {
			const map = createRecentMessageMap(capacity);
			this._lastMessagesSnapshot = {
				entryCount: 0,
				serialized: "{}",
			};
			return map;
		}

		try {
			const parsed = JSON.parse(result);
			const map = createRecentMessageMap(capacity, parsed);
			const serialized = JSON.stringify(map);
			const stats = getRecentMessageMapStats(map);
			this._lastMessagesSnapshot = {
				entryCount: stats.entryCount,
				serialized,
			};
			if (stats.initiallyPrunedEntries > 0) {
				state.logger?.info?.(
					{
						capacity: stats.capacity,
						entryCount: stats.entryCount,
						prunedEntryCount: stats.initiallyPrunedEntries,
					},
					"Pruned recent-message mappings to the configured capacity.",
				);
			}
			return map;
		} catch (err) {
			state.logger?.warn?.(
				{ err },
				"Failed to parse lastMessages; resetting to empty.",
			);
			const map = createRecentMessageMap(capacity);
			this._lastMessagesSnapshot = {
				entryCount: 0,
				serialized: "{}",
			};
			return map;
		}
	},

	async parseStartTime() {
		await this.ensureInitialized();
		const result = sqliteStore.getAppState(this._startTimeName);
		return result ? parseInt(result, 10) : Math.round(Date.now() / 1000);
	},

	async _saveNow() {
		await this.ensureInitialized();
		let lastMessages = state.lastMessages ?? {};
		let serializedLastMessages = JSON.stringify(lastMessages);
		let mappingStats = getRecentMessageMapStats(lastMessages);
		const previousSnapshot = this._lastMessagesSnapshot;
		const catastrophicDrop =
			previousSnapshot?.entryCount >= CATASTROPHIC_MAPPING_DROP_MIN_ENTRIES &&
			mappingStats.entryCount <
				previousSnapshot.entryCount * CATASTROPHIC_MAPPING_DROP_RATIO;

		if (catastrophicDrop) {
			const previousMappings = JSON.parse(previousSnapshot.serialized);
			const currentMappings = JSON.parse(serializedLastMessages);
			const mergedMappings = Object.assign(
				Object.create(null),
				previousMappings,
				currentMappings,
			);
			lastMessages = createRecentMessageMap(
				state.settings.lastMessageStorage * 2,
				mergedMappings,
			);
			state.lastMessages = lastMessages;
			serializedLastMessages = JSON.stringify(lastMessages);
			mappingStats = getRecentMessageMapStats(lastMessages);
			state.logger?.error?.(
				{
					observedEntryCount: Object.keys(currentMappings).length,
					previousEntryCount: previousSnapshot.entryCount,
					recoveredEntryCount: mappingStats.entryCount,
				},
				"Recovered recent-message mappings after an unexpected cardinality drop.",
			);
		}

		sqliteStore.transaction(() => {
			sqliteStore.setAppState(
				this._settingsName,
				JSON.stringify(state.settings),
			);
			sqliteStore.setAppState(this._chatsName, JSON.stringify(state.chats));
			sqliteStore.setAppState(
				this._contactsName,
				JSON.stringify(state.contacts),
			);
			sqliteStore.setAppState(this._lastMessagesName, serializedLastMessages);
			sqliteStore.setAppState(this._startTimeName, state.startTime.toString());
		});

		this._lastMessagesSnapshot = {
			entryCount: mappingStats.entryCount,
			serialized: serializedLastMessages,
		};
		state.logger?.debug?.(
			{
				capacity: mappingStats.capacity,
				deleteOperations: mappingStats.deleteOperations,
				entryCount: mappingStats.entryCount,
				evictedEntryCount: mappingStats.evictedEntries,
				managed: mappingStats.managed,
				previousEntryCount: previousSnapshot?.entryCount ?? null,
				setOperations: mappingStats.setOperations,
			},
			"Persisted recent-message mappings.",
		);
	},

	save() {
		const operation = this._saveQueue.then(
			() => this._saveNow(),
			() => this._saveNow(),
		);
		this._saveQueue = operation.catch(() => {});
		return operation;
	},

	async getAuthCredsRaw() {
		await this.ensureInitialized();
		return sqliteStore.getAuthCreds();
	},

	async setAuthCredsRaw(raw) {
		await this.ensureInitialized();
		sqliteStore.setAuthCreds(raw);
	},

	async getAuthKeysRaw(fileKeys) {
		await this.ensureInitialized();
		return sqliteStore.getAuthKeys(fileKeys);
	},

	async setAuthKeysRaw(entries) {
		await this.ensureInitialized();
		if (!entries || Object.keys(entries).length === 0) {
			return;
		}
		sqliteStore.setAuthKeys(entries);
	},

	async deleteAuthKeysRaw(fileKeys = []) {
		await this.ensureInitialized();
		if (!fileKeys.length) {
			return;
		}
		sqliteStore.deleteAuthKeys(fileKeys);
	},

	async clearAuthState() {
		await this.ensureInitialized();
		sqliteStore.clearAuthState();
	},
};

const setup = {
	async setupDiscordChannels(token) {
		return new Promise((resolve) => {
			const client = createDiscordClient({
				intents: [GatewayIntentBits.Guilds],
			});
			client.once("ready", () => {
				state.logger?.info(
					`Invite the bot using the following link: https://discord.com/oauth2/authorize?client_id=${client.user.id}&scope=bot%20applications.commands&permissions=536879120`,
				);
			});
			client.once("guildCreate", async (guild) => {
				const category = await guild.channels.create({
					name: "whatsapp",
					type: ChannelType.GuildCategory,
				});
				const controlChannel = await guild.channels.create({
					name: "control-room",
					type: ChannelType.GuildText,
					parent: category,
				});
				client.destroy();
				resolve({
					GuildID: guild.id,
					Categories: [category.id],
					ControlChannelID: controlChannel.id,
				});
			});
			client.login(token);
		});
	},

	async firstRun() {
		const settings = state.settings;
		const flushLogger = async () =>
			new Promise((resolve) => {
				if (typeof state.logger?.flush === "function") {
					state.logger.flush(resolve);
					return;
				}
				resolve();
			});
		state.logger?.info("It seems like this is your first run.");
		await flushLogger();
		if (process.env.WA2DC_TOKEN === "CHANGE_THIS_TOKEN") {
			state.logger?.info("Please set WA2DC_TOKEN environment variable.");
			await flushLogger();
			process.exit();
		}
		const input = async (query) =>
			new Promise((resolve) => {
				const rl = readline.createInterface({
					input: process.stdin,
					output: process.stdout,
				});
				rl.question(query, (answer) => {
					resolve(answer);
					rl.close();
				});
			});
		settings.Token =
			process.env.WA2DC_TOKEN || (await input("Please enter your bot token: "));
		Object.assign(settings, await this.setupDiscordChannels(settings.Token));
		return settings;
	},
};

export default storage;
