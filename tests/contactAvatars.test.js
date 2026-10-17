import assert from "node:assert/strict";
import test from "node:test";
import {
	normalizeContactAvatarUrl,
	normalizeSettings,
} from "../src/contracts.js";
import state from "../src/state.js";
import storage from "../src/storage.js";
import utils from "../src/utils.js";
import initIsolatedStorage from "./helpers/initIsolatedStorage.js";

await initIsolatedStorage(import.meta.url);
const pn = "15550001111@s.whatsapp.net";
const lid = "123456789@lid";
const avatar = "https://images.example/avatar.png";

test("avatar settings accept only individual contacts and HTTPS URLs", () => {
	assert.equal(normalizeContactAvatarUrl(` ${avatar} `), avatar);
	for (const value of [
		null,
		{},
		"",
		"javascript:alert(1)",
		"http://example.com/a",
		"https://user:pass@example.com/a",
		"data:image/png;base64,abc",
		`https://example.com/${"x".repeat(2048)}`,
	]) {
		assert.equal(normalizeContactAvatarUrl(value), null);
	}
	assert.deepEqual(
		normalizeSettings({
			CustomContactAvatars: {
				[pn]: avatar,
				[lid]: avatar,
				"123@g.us": avatar,
				invalid: avatar,
				"123@s.whatsapp.net": "ftp://example.com",
			},
		}).CustomContactAvatars,
		{ [pn]: avatar, [lid]: avatar },
	);
	for (const value of [null, [], "bad"])
		assert.deepEqual(
			normalizeSettings({ CustomContactAvatars: value }).CustomContactAvatars,
			{},
		);
});

test("avatars follow the sender in direct/group chats and migrate from LID to PN", async (t) => {
	const previous = {
		client: state.waClient,
		avatars: state.settings.CustomContactAvatars,
		contacts: state.contacts,
		chats: state.chats,
		cache: utils.whatsapp._profilePicsCache,
	};
	t.after(() => {
		state.waClient = previous.client;
		state.settings.CustomContactAvatars = previous.avatars;
		state.contacts = previous.contacts;
		state.chats = previous.chats;
		utils.whatsapp._profilePicsCache = previous.cache;
	});
	state.contacts = {};
	state.chats = {};
	state.settings.CustomContactAvatars = { [lid]: avatar };
	utils.whatsapp._profilePicsCache = {};
	let lookups = 0;
	state.waClient = {
		user: { id: "0@s.whatsapp.net" },
		signalRepository: { lidMapping: { getPNForLID: async () => pn } },
		profilePictureUrl: async () => {
			lookups++;
			return "https://whatsapp.example/picture";
		},
	};
	const group = {
		key: { remoteJid: "123@g.us", participant: lid, participantAlt: pn },
	};
	assert.equal(await utils.whatsapp.getProfilePic(group), avatar);
	assert.equal(state.settings.CustomContactAvatars[lid], undefined);
	assert.equal(state.settings.CustomContactAvatars[pn], avatar);
	assert.equal(
		await utils.whatsapp.getProfilePic({ key: { remoteJid: pn } }),
		avatar,
	);
	assert.equal(lookups, 0);
	delete state.settings.CustomContactAvatars[pn];
	assert.equal(
		await utils.whatsapp.getProfilePic(group),
		"https://whatsapp.example/picture",
	);
	assert.equal(lookups, 1);
	assert.equal(
		await utils.whatsapp.getProfilePic({ key: { remoteJid: pn } }),
		"https://whatsapp.example/picture",
	);
	assert.equal(lookups, 1);
});

test("avatar overrides survive a SQLite close/reopen and reset", async (t) => {
	const previous = { ...state.settings };
	t.after(() => Object.assign(state.settings, previous));
	state.settings.Token = "SYNTHETIC";
	state.settings.CustomContactAvatars = { [pn]: avatar };
	await storage.saveSettings();
	await storage.close();
	state.settings.CustomContactAvatars = {};
	assert.deepEqual((await storage.parseSettings()).CustomContactAvatars, {
		[pn]: avatar,
	});
	delete state.settings.CustomContactAvatars[pn];
	await storage.saveSettings();
	await storage.close();
	assert.deepEqual((await storage.parseSettings()).CustomContactAvatars, {});
});
