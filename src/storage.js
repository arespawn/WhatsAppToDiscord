import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";
import { BufferJSON } from "@whiskeysockets/baileys";
import discordJs from "discord.js";
import { normalizeChatLinks } from "./chatLinks.js";
import { createDiscordClient } from "./clientFactories.js";
import sqliteStore from "./persistence/sqliteStore.js";
import state from "./state.js";

const isSmokeTest = process.env.WA2DC_SMOKE_TEST === "1";
const STORAGE_DIR_MODE = 0o700;

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

const bidirectionalMap = (capacity, data) => {
	const backing =
		data && typeof data === "object" && !Array.isArray(data) ? data : {};
	const keys = Object.keys(backing);
	return new Proxy(backing, {
		set(target, prop, newVal) {
			keys.push(prop, newVal);
			if (keys.length > capacity) {
				delete target[keys.shift()];
				delete target[keys.shift()];
			}
			target[prop] = newVal;
			target[newVal] = prop;
			return true;
		},
	});
};

const normalizeAuthJson = (raw) =>
	JSON.stringify(JSON.parse(raw, BufferJSON.reviver), BufferJSON.replacer);

const existsAs = async (targetPath, type) => {
	try {
		const stat = await fs.stat(targetPath);
		return type === "dir" ? stat.isDirectory() : stat.isFile();
	} catch {
		return false;
	}
};

const normalizeDiscordIdArray = (value) => {
	if (!Array.isArray(value)) return [];
	return [...new Set(value.map(sanitizeDiscordId).filter(Boolean))];
};

const sanitizeDiscordId = (value) => {
	if (value == null) return null;
	const trimmed = String(value).trim();
	return /^\d+$/.test(trimmed) ? trimmed : null;
};

const movePath = async (from, to) => {
	try {
		await fs.rename(from, to);
		return;
	} catch (err) {
		if (err?.code !== "EXDEV") {
			throw err;
		}
	}

	await fs.cp(from, to, { recursive: true });
	await fs.rm(from, { recursive: true, force: true });
};

const storage = {
	_storageDir: "./storage/",
	_initialized: false,
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

	async _readLegacyFile(filePath) {
		try {
			return await fs.readFile(filePath, "utf8");
		} catch {
			return null;
		}
	},

	async _collectLegacyMigrationPayload() {
		const base = this._storageDir;
		const appFiles = [
			this._settingsName,
			this._chatsName,
			this._contactsName,
			this._lastMessagesName,
			this._startTimeName,
		];

		const appState = {};
		const backupSources = [];

		for (const name of appFiles) {
			const filePath = path.join(base, name);
			if (!(await existsAs(filePath, "file"))) continue;
			const raw = await this._readLegacyFile(filePath);
			if (raw == null) continue;
			appState[name] = raw;
			backupSources.push({ name, sourcePath: filePath, type: "file" });
		}

		const authDirPath = path.join(base, "baileys");
		const authCreds = null;
		const authKeys = {};
		let creds = authCreds;

		if (await existsAs(authDirPath, "dir")) {
			const entries = await fs.readdir(authDirPath, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isFile()) continue;
				const fileName = path.basename(entry.name);
				const raw = await this._readLegacyFile(
					path.join(authDirPath, fileName),
				);
				if (raw == null) continue;
				if (fileName === "creds.json") {
					creds = normalizeAuthJson(raw);
				} else {
					authKeys[fileName] = normalizeAuthJson(raw);
				}
			}

			backupSources.push({
				name: "baileys",
				sourcePath: authDirPath,
				type: "dir",
			});
		}

		const hasLegacyData =
			Object.keys(appState).length > 0 ||
			creds != null ||
			Object.keys(authKeys).length > 0;

		return {
			hasLegacyData,
			appState,
			authCreds: creds,
			authKeys,
			backupSources,
		};
	},

	async _backupLegacySources(backupSources = []) {
		if (!backupSources.length) {
			return;
		}

		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
		const backupDir = path.join(this._storageDir, `legacy-backup-${timestamp}`);
		await fs.mkdir(backupDir, { recursive: true, mode: STORAGE_DIR_MODE });
		if (process.platform !== "win32") {
			await fs.chmod(backupDir, STORAGE_DIR_MODE).catch(() => {});
		}

		for (const source of backupSources) {
			try {
				const exists = await existsAs(source.sourcePath, source.type);
				if (!exists) continue;
				await movePath(source.sourcePath, path.join(backupDir, source.name));
			} catch (err) {
				state.logger?.warn?.(
					{ err, source: source.sourcePath },
					"Failed to move migrated legacy source into backup directory",
				);
			}
		}
	},

	async _migrateLegacyToSqliteIfNeeded() {
		const done = sqliteStore.getMeta("legacy_migration_done");
		if (done === "1") {
			return;
		}

		const payload = await this._collectLegacyMigrationPayload();
		const migratedAt = String(Date.now());

		if (!payload.hasLegacyData) {
			sqliteStore.transaction(() => {
				sqliteStore.setMeta("legacy_migration_done", "1");
				sqliteStore.setMeta("migrated_at", migratedAt);
			});
			return;
		}

		sqliteStore.transaction(() => {
			for (const [key, value] of Object.entries(payload.appState)) {
				sqliteStore.setAppState(key, value);
			}
			if (payload.authCreds != null) {
				sqliteStore.setAuthCreds(payload.authCreds);
			}
			if (Object.keys(payload.authKeys).length > 0) {
				sqliteStore.setAuthKeys(payload.authKeys);
			}
			sqliteStore.setMeta("legacy_migration_done", "1");
			sqliteStore.setMeta("migrated_at", migratedAt);
		});

		await this._backupLegacySources(payload.backupSources);
		state.logger?.info?.("Legacy storage was migrated to SQLite.");
	},

	async init() {
		if (this._initialized) {
			return;
		}

		await this.ensureStorageDir();
		sqliteStore.setStorageDir(this._storageDir);
		await sqliteStore.init({ logger: state.logger });
		await this._migrateLegacyToSqliteIfNeeded();
		this._initialized = true;
	},

	async ensureInitialized() {
		await this.init();
	},

	async close() {
		sqliteStore.close();
		this._initialized = false;
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
			return Object.assign(state.settings, smokeDefaults);
		}

		await this.ensureInitialized();
		const result = sqliteStore.getAppState(this._settingsName);
		if (result == null) {
			return setup.firstRun();
		}

		try {
			const parsed = JSON.parse(result);

			delete parsed.LocalDownloadServerBasicAuthEnabled;
			delete parsed.LocalDownloadServerBasicAuthUsername;
			delete parsed.LocalDownloadServerBasicAuthPassword;

			if (!Object.hasOwn(parsed, "LocalDownloadServerBindHost")) {
				const hostRaw = parsed.LocalDownloadServerHost;
				const host = typeof hostRaw === "string" ? hostRaw.trim() : "";
				if (host) {
					const lower = host.toLowerCase();
					if (host === "0.0.0.0" || host === "::") {
						parsed.LocalDownloadServerBindHost = host;
						parsed.LocalDownloadServerHost = "localhost";
					} else if (
						lower === "localhost" ||
						lower === "127.0.0.1" ||
						lower === "::1"
					) {
						parsed.LocalDownloadServerBindHost = host;
					} else if (net.isIP(host)) {
						parsed.LocalDownloadServerBindHost = host;
					} else {
						parsed.LocalDownloadServerBindHost = "0.0.0.0";
					}
				}
			}

			if (parsed.DefaultChatType !== "thread") {
				parsed.DefaultChatType = "channel";
			}
			parsed.DefaultThreadHostName =
				typeof parsed.DefaultThreadHostName === "string"
					? parsed.DefaultThreadHostName.trim()
					: "";
			if (Object.hasOwn(parsed, "ThreadNotificationsEnabled")) {
				parsed.ThreadNotificationsEnabled = Boolean(
					parsed.ThreadNotificationsEnabled,
				);
			}
			parsed.ThreadNotificationRoles = normalizeDiscordIdArray(
				parsed.ThreadNotificationRoles,
			);
			parsed.ThreadNotificationUsers = normalizeDiscordIdArray(
				parsed.ThreadNotificationUsers,
			);

			const settings = Object.assign(state.settings, parsed);
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
			return bidirectionalMap(capacity);
		}

		try {
			const parsed = JSON.parse(result);
			return bidirectionalMap(capacity, parsed);
		} catch (err) {
			state.logger?.warn?.(
				{ err },
				"Failed to parse lastMessages; resetting to empty.",
			);
			return bidirectionalMap(capacity);
		}
	},

	async parseStartTime() {
		await this.ensureInitialized();
		const result = sqliteStore.getAppState(this._startTimeName);
		return result ? parseInt(result, 10) : Math.round(Date.now() / 1000);
	},

	async save() {
		await this.ensureInitialized();
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
			sqliteStore.setAppState(
				this._lastMessagesName,
				JSON.stringify(state.lastMessages ?? {}),
			);
			sqliteStore.setAppState(this._startTimeName, state.startTime.toString());
		});
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
