import makeWASocket, {
	fetchLatestBaileysVersion,
	fetchLatestWaWebVersion,
} from "@whiskeysockets/baileys";
import discordJs from "discord.js";

const overrides = {};

export const setClientFactoryOverrides = (next = {}) => {
	Object.assign(overrides, next);
};

export const resetClientFactoryOverrides = (...keys) => {
	if (keys.length === 0) {
		Object.keys(overrides).forEach((key) => {
			delete overrides[key];
		});
		return;
	}
	keys.forEach((key) => {
		delete overrides[key];
	});
};

export const createDiscordClient = (options = {}) => {
	if (typeof overrides.createDiscordClient === "function") {
		return overrides.createDiscordClient(options);
	}
	const { Client } = discordJs;
	return new Client(options);
};

export const createDiscordWebhookClient = (data, options = {}) => {
	if (typeof overrides.createDiscordWebhookClient === "function") {
		return overrides.createDiscordWebhookClient(data, options);
	}
	const { WebhookClient } = discordJs;
	return new WebhookClient(data, options);
};

export const createWhatsAppClient = (config) => {
	if (typeof overrides.createWhatsAppClient === "function") {
		return overrides.createWhatsAppClient(config);
	}
	return makeWASocket(config);
};

export const getBaileysVersion = async () => {
	if (typeof overrides.getBaileysVersion === "function") {
		return overrides.getBaileysVersion();
	}
	const waWebVersion = await fetchLatestWaWebVersion();
	if (waWebVersion.isLatest) {
		return waWebVersion;
	}
	return fetchLatestBaileysVersion();
};
