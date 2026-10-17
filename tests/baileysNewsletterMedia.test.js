import assert from "node:assert/strict";
import fs from "node:fs/promises";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import vm from "node:vm";
import { prepareWAMessageMedia, proto } from "@whiskeysockets/baileys";
import {
	getNewsletterMediaHandle,
	getWAUploadToServer,
	rememberNewsletterMediaHandle,
} from "@whiskeysockets/baileys/lib/Utils/messages-media.js";

const logger = { debug() {}, warn() {} };

test("newsletter uploads use dedicated endpoints and retain server metadata", async (t) => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wa2dc-newsletter-"));
	t.after(() => fs.rm(dir, { recursive: true, force: true }));
	const filePath = path.join(dir, "media");
	await fs.writeFile(filePath, "synthetic media");
	const requests = [];
	t.mock.method(https, "request", (options, callback) => {
		requests.push(options);
		const req = new Writable({
			write(_chunk, _encoding, done) {
				done();
			},
		});
		req.on("finish", () => {
			const res = Readable.from([
				JSON.stringify({
					direct_path: "/m1/synthetic",
					handle: "synthetic-handle",
					thumbnail_info: {
						thumbnail_direct_path: "/thumb",
						thumbnail_sha256: "YWJj",
					},
				}),
			]);
			res.statusCode = 200;
			callback(res);
		});
		return req;
	});
	syncBuiltinESMExports();
	t.after(() => {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	});
	const upload = getWAUploadToServer(
		{ customUploadHosts: [], logger },
		async () => ({
			auth: "synthetic",
			hosts: [{ hostname: "upload.example" }],
		}),
	);
	for (const mediaType of ["image", "video"]) {
		const result = await upload(filePath, {
			mediaType,
			fileEncSha256B64: "abc",
			newsletter: true,
		});
		assert.match(
			requests.at(-1).path,
			new RegExp(`^/newsletter/newsletter-${mediaType}/`),
		);
		assert.match(requests.at(-1).path, /server_thumb_gen=1/u);
		assert.equal(result.handle, "synthetic-handle");
		assert.equal(result.thumbnailDirectPath, "/thumb");
		assert.equal(result.thumbnailSha256, "YWJj");
	}
	await upload(filePath, { mediaType: "image", fileEncSha256B64: "abc" });
	assert.match(requests.at(-1).path, /^\/mms\/image\//u);
	assert.doesNotMatch(requests.at(-1).path, /server_thumb_gen/u);
});

test("newsletter preparation bypasses encrypted caches and cleans temporary files on failure", async (t) => {
	const dir = await fs.mkdtemp(
		path.join(os.tmpdir(), "wa2dc-newsletter-cache-"),
	);
	t.after(() => fs.rm(dir, { recursive: true, force: true }));
	const input = path.join(dir, "image");
	await fs.writeFile(input, "synthetic media");
	let stagedPath;
	for (const fail of [false, true]) {
		const prepare = prepareWAMessageMedia(
			{ image: { url: input }, caption: "caption" },
			{
				jid: "123@newsletter",
				mediaCache: {
					get: () => assert.fail("read encrypted cache"),
					set: () => assert.fail("cached unencrypted newsletter media"),
				},
				upload: async (filePath, options) => {
					stagedPath = filePath;
					assert.equal(options.newsletter, true);
					if (fail) throw new Error("synthetic upload failure");
					return {
						directPath: "/m1/prepared",
						handle: "prepared-handle",
						thumbnailDirectPath: "/thumb",
						thumbnailSha256: "YWJj",
					};
				},
			},
		);
		if (fail) await assert.rejects(prepare, /synthetic upload failure/u);
		else {
			const message = await prepare;
			assert.equal(message.imageMessage.caption, "caption");
			assert.equal(message.imageMessage.url, null);
			assert.equal(message.imageMessage.thumbnailDirectPath, "/thumb");
			assert.deepEqual(
				message.imageMessage.thumbnailSha256,
				Buffer.from("abc"),
			);
			assert.equal(
				getNewsletterMediaHandle(message.imageMessage.directPath),
				"prepared-handle",
			);
		}
		await assert.rejects(fs.stat(stagedPath), { code: "ENOENT" });
	}
});

test("newsletter stanzas retain the handle for retries and keep text sends unchanged", async () => {
	const source = await fs.readFile(
		"node_modules/@whiskeysockets/baileys/lib/Socket/messages-send.js",
		"utf8",
	);
	const branch = source.slice(
		source.indexOf("            if (isNewsletter) {"),
		source.indexOf(
			"            if (normalizeMessageContent(message)?.pinInChatMessage",
		),
	);
	const run = vm.runInNewContext(
		`(async function(message, extraAttrs, binaryNodeContent, patchMessageBeforeSending, isNewsletter, normalizeMessageContent, getNewsletterMediaHandle, encodeNewsletterMessage, jid, msgId, getMessageType, additionalAttributes, logger, sendNode) { const innerMessage = normalizeMessageContent(message); ${branch} })`,
	);
	rememberNewsletterMediaHandle("/m1/stanza", "stanza-handle");
	for (const message of [
		{ imageMessage: { directPath: "/m1/stanza" } },
		{ imageMessage: { directPath: "/m1/stanza" } },
		{ conversation: "hello" },
	]) {
		let stanza;
		await run(
			message,
			message.imageMessage ? { mediatype: "image" } : {},
			[],
			undefined,
			true,
			(m) => m,
			getNewsletterMediaHandle,
			(m) => proto.Message.encode(m).finish(),
			"123@newsletter",
			"synthetic",
			() => "text",
			undefined,
			logger,
			async (value) => {
				stanza = value;
			},
		);
		assert.equal(
			stanza.attrs.media_id,
			message.imageMessage ? "stanza-handle" : undefined,
		);
		assert.equal(
			stanza.content[0].attrs.mediatype,
			message.imageMessage ? "image" : undefined,
		);
	}
});

test("newsletter upload handles expire and stay bounded", (t) => {
	for (let i = 0; i < 257; i++)
		rememberNewsletterMediaHandle(`/bounded/${i}`, `handle-${i}`);
	assert.equal(getNewsletterMediaHandle("/bounded/0"), undefined);
	assert.equal(getNewsletterMediaHandle("/bounded/256"), "handle-256");
	t.mock.method(Date, "now", () => Number.MAX_SAFE_INTEGER);
	assert.equal(getNewsletterMediaHandle("/bounded/256"), undefined);
});
