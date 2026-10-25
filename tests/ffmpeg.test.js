import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { transcodeBufferWithFfmpeg } from "../src/internal/ffmpeg.js";
import { createWhatsAppAudioToDiscordFileNormalizer } from "../src/internal/whatsappAudioToDiscordNormalization.js";
import { createWhatsAppGifToDiscordFileNormalizer } from "../src/internal/whatsappGifToDiscordNormalization.js";

const mockFfmpeg = (t) => {
	const child = new EventEmitter();
	child.stdin = new PassThrough();
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	child.kill = t.mock.fn();
	const spawn = t.mock.method(childProcess, "spawn", () => child);
	return { child, spawn };
};

test("FFmpeg runner preserves arguments, input and combined output", async (t) => {
	const { child, spawn } = mockFfmpeg(t);
	const input = Buffer.from("input");
	const args = ["-i", "pipe:0", "-f", "mp3", "pipe:1"];
	const output = transcodeBufferWithFfmpeg(input, args, 20000);
	child.stdout.write(Buffer.from("one"));
	child.stdout.write(Buffer.from("two"));
	child.emit("close", 0);
	assert.equal((await output).toString(), "onetwo");
	assert.equal(child.stdin.read().toString(), "input");
	assert.deepEqual(spawn.mock.calls[0].arguments, [
		"ffmpeg",
		args,
		{ stdio: ["pipe", "pipe", "pipe"] },
	]);
	assert.equal(child.kill.mock.callCount(), 0);
});

test("FFmpeg runner preserves diagnostic and empty-output failures", async (t) => {
	const { child } = mockFfmpeg(t);
	const output = transcodeBufferWithFfmpeg(Buffer.from("input"), [], 20000);
	child.stderr.write(" unsupported codec \n");
	child.emit("close", 1);
	await assert.rejects(output, /ffmpeg_exit_1:unsupported codec/);
	const empty = transcodeBufferWithFfmpeg(Buffer.from("input"), [], 20000);
	child.emit("close", 0);
	await assert.rejects(empty, /ffmpeg_empty_output/);
});

test("FFmpeg runner kills timed-out work and ignores late output and close events", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { child } = mockFfmpeg(t);
	const output = transcodeBufferWithFfmpeg(Buffer.from("input"), [], 20);
	t.mock.timers.tick(20);
	await assert.rejects(output, /ffmpeg_timeout/);
	assert.deepEqual(child.kill.mock.calls[0].arguments, ["SIGKILL"]);
	child.stdout.write("late output");
	child.emit("close", 0);
	assert.equal(child.kill.mock.callCount(), 1);
});

test("FFmpeg runner handles spawn and output pipe failures without leaving work running", async (t) => {
	const { child } = mockFfmpeg(t);
	const output = transcodeBufferWithFfmpeg(Buffer.from("input"), [], 20000);
	const error = Object.assign(new Error("missing"), { code: "ENOENT" });
	child.emit("error", error);
	await assert.rejects(output, error);
	const brokenPipe = transcodeBufferWithFfmpeg(Buffer.from("input"), [], 20000);
	child.stdout.emit("error", new Error("pipe failed"));
	await assert.rejects(brokenPipe, /pipe failed/);
	assert.equal(child.kill.mock.callCount(), 2);
});

test("FFmpeg stops collecting oversized output and kills the converter", async (t) => {
	const { child } = mockFfmpeg(t);
	const output = transcodeBufferWithFfmpeg(Buffer.from("input"), [], 20000, 4);
	child.stdout.write(Buffer.from("abcd"));
	child.stdout.write(Buffer.from("e"));
	await assert.rejects(output, /ffmpeg_output_limit_exceeded/);
	assert.equal(child.kill.mock.callCount(), 1);
	child.emit("close", 0);
});

test("default MP3 and GIF converters fall back to the original media on output overflow", async (t) => {
	const { child } = mockFfmpeg(t);
	for (const [factory, mimetype, fileName] of [
		[createWhatsAppAudioToDiscordFileNormalizer, "audio/ogg", "audio.ogg"],
		[createWhatsAppGifToDiscordFileNormalizer, "video/mp4", "video.mp4"],
	]) {
		const input = Buffer.from("original");
		const result = factory()({
			attachmentBuffer: input,
			mimetype,
			fileName,
			targetFormat: "mp3",
			maxBytes: 4,
		});
		child.stdout.write(Buffer.from("oversized"));
		const normalized = await result;
		assert.equal(normalized.converted, false);
		assert.equal(normalized.attachmentBuffer, input);
		assert.equal(normalized.fileName, fileName);
	}
});

test("FFmpeg diagnostics remain bounded even when the subprocess emits excessive stderr", async (t) => {
	const { child } = mockFfmpeg(t);
	const output = transcodeBufferWithFfmpeg(Buffer.from("input"), [], 20000);
	child.stderr.write(Buffer.alloc(1024 * 1024, 65));
	child.stderr.write(Buffer.alloc(1024 * 1024, 66));
	child.emit("close", 1);
	await assert.rejects(output, (error) => {
		assert.equal(error.message, `ffmpeg_exit_1:${"A".repeat(64 * 1024)}`);
		return true;
	});
});
