import childProcess from "node:child_process";

export const transcodeBufferWithFfmpeg = (
	inputBuffer,
	args,
	timeoutMs,
	maxOutputBytes = Infinity,
) => {
	if (!inputBuffer?.length) return Promise.resolve(null);
	return new Promise((resolve, reject) => {
		const ffmpeg = childProcess.spawn("ffmpeg", args, {
			stdio: ["pipe", "pipe", "pipe"],
		});
		const stdoutChunks = [];
		const stderrChunks = [];
		let outputBytes = 0;
		let stderrBytes = 0;
		let completed = false;
		const finish = (err, output = null) => {
			if (completed) return;
			completed = true;
			clearTimeout(timeout);
			if (err) {
				ffmpeg.kill("SIGKILL");
				reject(err);
			} else {
				resolve(output);
			}
			stdoutChunks.length = 0;
			stderrChunks.length = 0;
		};
		const timeout = setTimeout(
			() => finish(new Error("ffmpeg_timeout")),
			timeoutMs,
		);
		ffmpeg.stdout.on("data", (chunk) => {
			if (completed) return;
			outputBytes += chunk.length;
			if (outputBytes > maxOutputBytes) {
				finish(new Error("ffmpeg_output_limit_exceeded"));
				return;
			}
			stdoutChunks.push(chunk);
		});
		ffmpeg.stderr.on("data", (chunk) => {
			if (completed) return;
			const remaining = 64 * 1024 - stderrBytes;
			if (remaining <= 0) return;
			const retained =
				chunk.length > remaining
					? Buffer.from(chunk.subarray(0, remaining))
					: chunk;
			stderrBytes += retained.length;
			stderrChunks.push(retained);
		});
		ffmpeg.stdout.on("error", (err) => finish(err));
		ffmpeg.stderr.on("error", (err) => finish(err));
		ffmpeg.on("error", (err) => finish(err));
		ffmpeg.on("close", (code) => {
			if (completed) return;
			if (code !== 0) {
				const stderrText = Buffer.concat(stderrChunks).toString("utf8").trim();
				finish(
					new Error(`ffmpeg_exit_${code}${stderrText ? `:${stderrText}` : ""}`),
				);
				return;
			}
			const output = Buffer.concat(stdoutChunks, outputBytes);
			if (!output.length) {
				finish(new Error("ffmpeg_empty_output"));
				return;
			}
			finish(null, output);
		});
		ffmpeg.stdin.on("error", () => {});
		ffmpeg.stdin.end(inputBuffer);
	});
};
