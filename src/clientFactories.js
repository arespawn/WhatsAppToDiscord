import makeWASocket, {
	fetchLatestBaileysVersion,
	fetchLatestWaWebVersion,
} from "@whiskeysockets/baileys";
import discordJs from "discord.js";
import { Agent as DiscordRestAgent } from "undici6";
import { DISCORD_REST_REQUEST_TIMEOUT_MS } from "./contracts.js";

const overrides = {};
let discordRestAgent = null;

export const getDiscordRestAgent = () => {
	discordRestAgent ??= new DiscordRestAgent();
	return discordRestAgent;
};

export const closeDiscordRestAgent = async () => {
	const activeAgent = discordRestAgent;
	discordRestAgent = null;
	await activeAgent?.close();
};

export const createDiscordRestOptions = () => ({
	agent: getDiscordRestAgent(),
	timeout: DISCORD_REST_REQUEST_TIMEOUT_MS,
	// Keep @discordjs/rest on its native request/response strategy while preventing
	// a newer Undici major from replacing the shared global dispatcher underneath it.
});

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
