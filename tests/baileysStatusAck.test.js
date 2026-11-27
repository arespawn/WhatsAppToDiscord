import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { registerHooks } from "node:module";
import test from "node:test";

test("Baileys acknowledges live, queued, and ignored top-level statuses", async (t) => {
	// Exercise rc14's receive socket and offline queue with an in-memory transport.
	const hook = registerHooks({
		resolve(specifier, context, nextResolve) {
			if (
				specifier === "./messages-send.js" &&
				context.parentURL?.endsWith("/Socket/messages-recv.js")
			) {
				return {
					url: "data:text/javascript,export const makeMessagesSocket = config => config.transport",
					shortCircuit: true,
				};
			}
			return nextResolve(specifier, context);
		},
	});
	t.after(() => hook.deregister());
	const { makeMessagesRecvSocket } = await import(
		"@whiskeysockets/baileys/lib/Socket/messages-recv.js"
	);
	const ws = Object.assign(new EventEmitter(), { isOpen: true });
	const sent = [];
	const errors = [];
	makeMessagesRecvSocket({
		logger: { debug() {}, warn() {} },
		shouldIgnoreJid: (jid) => jid === "ignored@g.us",
		transport: {
			ws,
			ev: Object.assign(new EventEmitter(), { buffer() {}, flush() {} }),
			authState: { creds: {}, keys: { get: async () => ({}) } },
			signalRepository: { lidMapping: { getLIDForPN() {} } },
			registerSocketEndHandler: (cleanup) => t.after(cleanup),
			onUnexpectedError: (error) => errors.push(error.message),
			sendNode: async (node) => {
				if (node.attrs.id === "failed") throw new Error("send failed");
				sent.push(node);
			},
		},
	});
	const attrs = { from: "group@g.us", participant: "test@lid", type: "media" };
	for (const extra of [
		{ id: "live" },
		{ id: "failed", offline: "1" },
		{ id: "queued", offline: "1" },
		{ id: "ignored", from: "ignored@g.us" },
	]) {
		ws.emit("CB:status", { tag: "status", attrs: { ...attrs, ...extra } });
	}
	await t.waitFor(() => assert.equal(sent.length, 3));
	assert.deepEqual(errors, ["send failed"]);
	assert.deepEqual(sent.map((node) => node.attrs.id).sort(), [
		"ignored",
		"live",
		"queued",
	]);
	for (const node of sent) {
		assert.deepEqual(node, {
			tag: "ack",
			attrs: {
				id: node.attrs.id,
				class: "status",
				to: node.attrs.id === "ignored" ? "ignored@g.us" : attrs.from,
				type: attrs.type,
				participant: attrs.participant,
			},
		});
	}
});
