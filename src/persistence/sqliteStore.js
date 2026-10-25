import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const STORAGE_DIR_MODE = 0o700;
const STORAGE_FILE_MODE = 0o600;
const ENCRYPTION_CHECK_VALUE = "WA2DC-ENCRYPTION-CHECK-v1";

const deriveKey = (passphrase, saltBase64url) => {
	const salt = Buffer.from(saltBase64url, "base64url");
	return crypto.scryptSync(passphrase, salt, 32);
};

const encryptPayload = (value, key) => {
	const iv = crypto.randomBytes(12);
	const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
	const encrypted = Buffer.concat([
		cipher.update(value, "utf8"),
		cipher.final(),
	]);
	const tag = cipher.getAuthTag();
	return JSON.stringify({
		v: 1,
		alg: "aes-256-gcm",
		iv: iv.toString("base64url"),
		tag: tag.toString("base64url"),
		data: encrypted.toString("base64url"),
	});
};

const decryptPayload = (encoded, key) => {
	let payload;
	try {
		payload = JSON.parse(encoded);
	} catch {
		throw new Error("Failed to parse encrypted payload");
	}

	if (payload?.v !== 1 || payload?.alg !== "aes-256-gcm") {
		throw new Error("Unsupported encrypted payload envelope");
	}

	const iv = Buffer.from(payload.iv, "base64url");
	const tag = Buffer.from(payload.tag, "base64url");
	const data = Buffer.from(payload.data, "base64url");
	const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
	decipher.setAuthTag(tag);
	const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
	return decrypted.toString("utf8");
};

const sqliteStore = {
	_storageDir: "./storage",
	_dbFileName: "wa2dc.sqlite",
	_db: null,
	_statements: new Map(),
	_encryption: { enabled: false, key: null },
	_logger: null,

	setStorageDir(storageDir) {
		this._storageDir = storageDir;
	},

	getStorageDir() {
		return this._storageDir;
	},

	getDbPath() {
		return path.join(this._storageDir, this._dbFileName);
	},

	async ensureStorageDir() {
		await fs.mkdir(this._storageDir, {
			recursive: true,
			mode: STORAGE_DIR_MODE,
		});
		if (process.platform !== "win32") {
			await fs.chmod(this._storageDir, STORAGE_DIR_MODE).catch(() => {});
		}
	},

	_ensureDbReady() {
		if (!this._db) {
			throw new Error("SQLite store is not initialized");
		}
	},

	isReady() {
		return !!this._db;
	},

	_prepare(sql) {
		this._ensureDbReady();
		let statement = this._statements.get(sql);
		if (!statement) {
			statement = this._db.prepare(sql);
			this._statements.set(sql, statement);
		}
		return statement;
	},

	_decodeStoredValue(value) {
		if (!this._encryption.enabled) {
			return value;
		}
		return decryptPayload(value, this._encryption.key);
	},

	_encodeStoredValue(value) {
		if (!this._encryption.enabled) {
			return value;
		}
		return encryptPayload(value, this._encryption.key);
	},

	_getMetaValue(key) {
		const row = this._prepare("SELECT value FROM meta WHERE key = ?").get(key);
		return row?.value ?? null;
	},

	_setMetaValue(key, value) {
		this._prepare(`
      INSERT INTO meta (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
	},

	_configureEncryption(passphraseRaw) {
		const passphrase = typeof passphraseRaw === "string" ? passphraseRaw : "";
		const encryptionMetaRaw = this._getMetaValue("encryption");

		if (!encryptionMetaRaw) {
			if (!passphrase) {
				this._setMetaValue(
					"encryption",
					JSON.stringify({ v: 1, enabled: false }),
				);
				this._encryption = { enabled: false, key: null };
				return;
			}

			const salt = crypto.randomBytes(16).toString("base64url");
			const key = deriveKey(passphrase, salt);
			const check = encryptPayload(ENCRYPTION_CHECK_VALUE, key);
			this._setMetaValue(
				"encryption",
				JSON.stringify({
					v: 1,
					enabled: true,
					kdf: "scrypt",
					salt,
					check,
				}),
			);
			this._encryption = { enabled: true, key };
			this._logger?.info?.("WA2DC SQLite payload encryption is enabled.");
			return;
		}

		let encryptionMeta;
		try {
			encryptionMeta = JSON.parse(encryptionMetaRaw);
		} catch {
			throw new Error("Invalid SQLite encryption metadata");
		}

		if (!encryptionMeta?.enabled) {
			this._encryption = { enabled: false, key: null };
			if (passphrase) {
				this._logger?.warn?.(
					"WA2DC_DB_PASSPHRASE is set, but existing SQLite DB is not encrypted. Ignoring passphrase.",
				);
			}
			return;
		}

		if (!passphrase) {
			throw new Error(
				"SQLite DB is encrypted but WA2DC_DB_PASSPHRASE is not set.",
			);
		}

		if (!encryptionMeta.salt || !encryptionMeta.check) {
			throw new Error("SQLite encryption metadata is incomplete.");
		}

		const key = deriveKey(passphrase, encryptionMeta.salt);
		let checkValue;
		try {
			checkValue = decryptPayload(encryptionMeta.check, key);
		} catch {
			throw new Error("Invalid WA2DC_DB_PASSPHRASE for encrypted SQLite DB.");
		}

		if (checkValue !== ENCRYPTION_CHECK_VALUE) {
			throw new Error("Invalid WA2DC_DB_PASSPHRASE for encrypted SQLite DB.");
		}

		this._encryption = { enabled: true, key };
	},

	async init({ logger } = {}) {
		if (this._db) {
			if (logger) {
				this._logger = logger;
			}
			return;
		}

		this._logger = logger || this._logger;
		await this.ensureStorageDir();

		const dbPath = this.getDbPath();
		this._db = new DatabaseSync(dbPath);

		if (process.platform !== "win32") {
			await fs.chmod(dbPath, STORAGE_FILE_MODE).catch(() => {});
		}

		// If setup or the passphrase check fails, close the handle so a later
		// init() cannot treat the DB as ready with encryption disabled.
		try {
			this._db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS app_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS auth_creds (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS auth_keys (
        file_key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS message_store (
        cache_key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_message_store_expires_at ON message_store(expires_at);
      CREATE INDEX IF NOT EXISTS idx_message_store_updated_at ON message_store(updated_at);
    `);

			this._configureEncryption(process.env.WA2DC_DB_PASSPHRASE || "");
		} catch (err) {
			this.close();
			throw err;
		}
	},

	close() {
		if (this._db) {
			this._db.close();
			this._db = null;
		}
		this._statements.clear();
		this._encryption = { enabled: false, key: null };
	},

	transaction(work) {
		this._ensureDbReady();
		this._db.exec("BEGIN IMMEDIATE");
		try {
			const result = work();
			this._db.exec("COMMIT");
			return result;
		} catch (err) {
			this._db.exec("ROLLBACK");
			throw err;
		}
	},

	getMeta(key) {
		return this._getMetaValue(key);
	},

	setMeta(key, value) {
		this._setMetaValue(key, value);
	},

	getAppState(key) {
		const row = this._prepare("SELECT value FROM app_state WHERE key = ?").get(
			key,
		);
		if (!row) {
			return null;
		}
		return this._decodeStoredValue(row.value);
	},

	setAppState(key, value) {
		const now = Date.now();
		this._prepare(`
      INSERT INTO app_state (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, this._encodeStoredValue(value), now);
	},

	getAuthCreds() {
		const row = this._prepare(
			"SELECT value FROM auth_creds WHERE id = 1",
		).get();
		if (!row) {
			return null;
		}
		return this._decodeStoredValue(row.value);
	},

	setAuthCreds(value) {
		const now = Date.now();
		this._prepare(`
      INSERT INTO auth_creds (id, value, updated_at)
      VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(this._encodeStoredValue(value), now);
	},

	getAuthKeys(fileKeys = []) {
		const result = {};
		const stmt = this._prepare(
			"SELECT value FROM auth_keys WHERE file_key = ?",
		);
		for (const fileKey of fileKeys) {
			const row = stmt.get(fileKey);
			if (row) {
				result[fileKey] = this._decodeStoredValue(row.value);
			}
		}
		return result;
	},

	setAuthKeys(entries = {}) {
		const now = Date.now();
		const stmt = this._prepare(`
      INSERT INTO auth_keys (file_key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(file_key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);

		for (const [fileKey, value] of Object.entries(entries)) {
			stmt.run(fileKey, this._encodeStoredValue(value), now);
		}
	},

	deleteAuthKeys(fileKeys = []) {
		const stmt = this._prepare("DELETE FROM auth_keys WHERE file_key = ?");
		for (const fileKey of fileKeys) {
			stmt.run(fileKey);
		}
	},

	clearAuthState() {
		this._ensureDbReady();
		this._db.exec("DELETE FROM auth_keys; DELETE FROM auth_creds;");
	},

	getMessageStore(cacheKey) {
		const row = this._prepare(
			"SELECT value, expires_at AS expiresAt FROM message_store WHERE cache_key = ?",
		).get(cacheKey);
		if (!row) {
			return null;
		}
		if (row.expiresAt <= Date.now()) {
			this._prepare("DELETE FROM message_store WHERE cache_key = ?").run(
				cacheKey,
			);
			return null;
		}
		return {
			value: this._decodeStoredValue(row.value),
			expiresAt: row.expiresAt,
		};
	},

	setMessageStore(cacheKey, value, expiresAt) {
		const now = Date.now();
		this._prepare(`
      INSERT INTO message_store (cache_key, value, expires_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(cache_key)
      DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at, updated_at = excluded.updated_at
    `).run(cacheKey, this._encodeStoredValue(value), expiresAt, now);
	},

	pruneMessageStore(maxEntries) {
		const now = Date.now();
		this._prepare("DELETE FROM message_store WHERE expires_at <= ?").run(now);
		if (!Number.isFinite(maxEntries) || maxEntries <= 0) {
			return;
		}
		this._prepare(`
      DELETE FROM message_store
      WHERE cache_key IN (
        SELECT cache_key FROM message_store
        ORDER BY updated_at ASC
        LIMIT MAX(0, (SELECT COUNT(*) FROM message_store) - ?)
      )
    `).run(maxEntries);
	},

	clearMessageStore() {
		this._prepare("DELETE FROM message_store").run();
	},
};

export default sqliteStore;
