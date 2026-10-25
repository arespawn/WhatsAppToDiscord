import { BufferJSON, initAuthCreds, proto } from "@whiskeysockets/baileys";

import storage from "../storage.js";

const fixFileName = (file) => file?.replace(/\//g, "__")?.replace(/:/g, "-");
const toAuthFileKey = (type, id) => fixFileName(`${type}-${id}.json`);

const parseAuthJson = (raw) => JSON.parse(raw, BufferJSON.reviver);
const stringifyAuthJson = (value) => JSON.stringify(value, BufferJSON.replacer);

const useSQLiteAuthState = async () => {
	await storage.ensureInitialized();

	const credsRaw = await storage.getAuthCredsRaw();
	const creds = credsRaw ? parseAuthJson(credsRaw) : initAuthCreds();

	return {
		state: {
			creds,
			keys: {
				get: async (type, ids) => {
					const data = {};
					if (!Array.isArray(ids) || !ids.length) {
						return data;
					}

					const fileKeys = ids.map((id) => toAuthFileKey(type, id));
					const rows = await storage.getAuthKeysRaw(fileKeys);

					ids.forEach((id, idx) => {
						const fileKey = fileKeys[idx];
						const raw = rows[fileKey];
						let value = raw ? parseAuthJson(raw) : null;
						if (type === "app-state-sync-key" && value) {
							value = proto.Message.AppStateSyncKeyData.fromObject(value);
						}
						data[id] = value;
					});

					return data;
				},
				set: async (data) => {
					const toWrite = {};
					const toDelete = [];

					for (const category in data) {
						for (const id in data[category]) {
							const value = data[category][id];
							const fileKey = toAuthFileKey(category, id);
							if (value) {
								toWrite[fileKey] = stringifyAuthJson(value);
							} else {
								toDelete.push(fileKey);
							}
						}
					}

					await storage.updateAuthKeysRaw(toWrite, toDelete);
				},
			},
		},
		saveCreds: async () => {
			await storage.setAuthCredsRaw(stringifyAuthJson(creds));
		},
	};
};

export default useSQLiteAuthState;
