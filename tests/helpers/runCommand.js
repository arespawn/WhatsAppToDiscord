import { spawn } from "node:child_process";

const runCommand = async (
	command,
	args,
	{ cwd, env, timeoutMs = 120_000 } = {},
) =>
	new Promise((resolve) => {
		const child = spawn(command, args, {
			cwd,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";

		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});

		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
		}, timeoutMs);
		if (typeof timeout.unref === "function") {
			timeout.unref();
		}

		child.on("close", (code, signal) => {
			clearTimeout(timeout);
			resolve({ code, signal, stdout, stderr });
		});
	});

export default runCommand;
