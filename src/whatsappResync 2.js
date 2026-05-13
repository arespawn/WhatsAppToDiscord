import {
	getBinaryNodeChild,
	getBinaryNodeChildren,
	jidEncode,
} from "@whiskeysockets/baileys";
import state from "./state.js";
import storage from "./storage.js";
import utils from "./utils.js";

const toGroupJid = (id) => {
	if (typeof id !== "string" || !id.trim()) return null;
	const raw = id.trim();
	const candidate = raw.includes("@") ? raw : jidEncode(raw, "g.us");
	const normalized = utils.whatsapp.formatJid(candidate);
	return normalized?.endsWith("@g.us") ? normalized : null;
};

const groupMetadataFromNode = (groupNode) => {
	const attrs = groupNode?.attrs || {};
	const id = toGroupJid(attrs.id);
	if (!id) return null;
	return {
		id,
		notify: attrs.notify,
		subject: attrs.subject || attrs.notify || id,
		subjectOwner: attrs.s_o,
		subjectOwnerPn: attrs.s_o_pn,
		subjectTime: attrs.s_t ? Number(attrs.s_t) : undefined,
		size: attrs.size ? Number(attrs.size) : undefined,
		creation: attrs.creation ? Number(attrs.creation) : undefined,
	};
};

export const fetchParticipatingGroupsLight = async (client) => {
	if (typeof client?.query !== "function") {
		return {};
	}

	const result = await client.query({
		tag: "iq",
		attrs: {
			to: "@g.us",
			xmlns: "w:g2",
			type: "get",
		},
		content: [{ tag: "participating", attrs: {} }],
	});
	const groupsChild = getBinaryNodeChild(result, "groups");
	const groups = getBinaryNodeChildren(groupsChild, "group");
	const participatingGroups = {};
	for (const groupNode of groups) {
		const metadata = groupMetadataFromNode(groupNode);
		if (!metadata) continue;
		participatingGroups[metadata.id] = metadata;
	}
	return participatingGroups;
};

const applyParticipatingGroups = (client, groups = {}) => {
	let count = 0;
	for (const [jid, metadata] of Object.entries(groups)) {
		const normalized = toGroupJid(jid || metadata?.id);
		if (!normalized || !metadata?.subject) continue;
		state.contacts[normalized] = metadata.subject;
		if (client?.contacts) {
			client.contacts[normalized] = metadata.subject;
		}
		count += 1;
	}
	return count;
};

export const resyncWhatsAppContactsAndGroups = async (client) => {
	if (!client) {
		throw new Error("WhatsApp client is not connected.");
	}

	if (
		client.authState?.keys?.set &&
		typeof client.resyncAppState === "function"
	) {
		await client.authState.keys.set({
			"app-state-sync-version": { critical_unblock_low: null },
		});
		await client.resyncAppState(["critical_unblock_low"]);
	}

	let groups = {};
	try {
		groups = await fetchParticipatingGroupsLight(client);
	} catch (err) {
		state.logger?.warn(
			{ err },
			"Lightweight participating group resync failed.",
		);
	}
	const groupCount = applyParticipatingGroups(client, groups);

	await storage.save().catch((err) => {
		state.logger?.warn({ err }, "Failed to persist WhatsApp resync results.");
	});

	return {
		contactCount: Object.keys(state.contacts || {}).length,
		groupCount,
	};
};
