import assert from "node:assert/strict";
import test from "node:test";

import groupMetadataCache from "../src/groupMetadataCache.js";
import state from "../src/state.js";
import storage from "../src/storage.js";
import {
	fetchParticipatingGroupsLight,
	resyncWhatsAppContactsAndGroups,
} from "../src/whatsappResync.js";
import initIsolatedStorage from "./helpers/initIsolatedStorage.js";

await initIsolatedStorage(import.meta.url);

const restoreObject = (target, snapshot) => {
	Object.keys(target).forEach((key) => {
		delete target[key];
	});
	Object.assign(target, snapshot);
};

test("fetchParticipatingGroupsLight queries group list without participants", async () => {
	let capturedQuery = null;
	const client = {
		async query(query) {
			capturedQuery = query;
			return {
				tag: "iq",
				attrs: {},
				content: [
					{
						tag: "groups",
						attrs: {},
						content: [
							{
								tag: "group",
								attrs: {
									id: "123456789-987654321",
									subject: "Alpha Group",
									size: "42",
								},
							},
						],
					},
				],
			};
		},
		async groupFetchAllParticipating() {
			throw new Error("heavy group fetch should not be called");
		},
	};

	const groups = await fetchParticipatingGroupsLight(client);

	assert.deepEqual(capturedQuery, {
		tag: "iq",
		attrs: {
			to: "@g.us",
			xmlns: "w:g2",
			type: "get",
		},
		content: [{ tag: "participating", attrs: {} }],
	});
	assert.equal(groups["123456789-987654321@g.us"].subject, "Alpha Group");
	assert.equal(groups["123456789-987654321@g.us"].size, 42);
});

test("resyncWhatsAppContactsAndGroups refreshes app state and persists light group results", async () => {
	const originalContacts = { ...state.contacts };
	const originalLogger = state.logger;
	const originalStartTime = state.startTime;
	let appStatePayload = null;
	let resyncedCollections = null;

		try {
			groupMetadataCache.clear();
			restoreObject(state.contacts, {});
			state.logger = { warn() {}, error() {}, info() {}, debug() {} };
		state.startTime = 123;
		const client = {
			contacts: state.contacts,
			authState: {
				keys: {
					async set(payload) {
						appStatePayload = payload;
					},
				},
			},
			async resyncAppState(collections) {
				resyncedCollections = collections;
				state.contacts["15551234567@s.whatsapp.net"] = "Alice";
			},
			async query() {
				return {
					tag: "iq",
					attrs: {},
					content: [
						{
							tag: "groups",
							attrs: {},
							content: [
								{
									tag: "group",
									attrs: {
										id: "111222333-444555666",
										subject: "Project Group",
									},
								},
							],
						},
					],
				};
			},
			async groupFetchAllParticipating() {
				throw new Error("heavy group fetch should not be called");
			},
		};

		const result = await resyncWhatsAppContactsAndGroups(client);
		const persistedContacts = await storage.parseContacts();

		assert.deepEqual(appStatePayload, {
			"app-state-sync-version": { critical_unblock_low: null },
		});
		assert.deepEqual(resyncedCollections, ["critical_unblock_low"]);
		assert.equal(result.groupCount, 1);
		assert.equal(result.contactCount, 2);
		assert.equal(state.contacts["15551234567@s.whatsapp.net"], "Alice");
		assert.equal(state.contacts["111222333-444555666@g.us"], "Project Group");
		assert.equal(client.contacts["111222333-444555666@g.us"], "Project Group");
		assert.equal(groupMetadataCache.get("111222333-444555666@g.us"), undefined);
		assert.equal(
			persistedContacts["111222333-444555666@g.us"],
			"Project Group",
		);
	} finally {
		restoreObject(state.contacts, originalContacts);
		state.logger = originalLogger;
		state.startTime = originalStartTime;
	}
});
