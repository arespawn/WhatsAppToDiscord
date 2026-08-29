import fs from "node:fs/promises";
import path from "node:path";

const pendingPrefixFor = (filePath) =>
	`${path.basename(filePath, path.extname(filePath))}.pending-`;
const pendingSuffixFor = (filePath) => path.extname(filePath) || ".txt";

const createPendingPath = (filePath) => {
	const resolvedPath = path.resolve(filePath);
	return path.join(
		path.dirname(resolvedPath),
		`${pendingPrefixFor(resolvedPath)}${Date.now()}-${process.pid}-${Math.random()
			.toString(16)
			.slice(2)}${pendingSuffixFor(resolvedPath)}`,
	);
};

export async function readTextFileTail(
	filePath,
	{ maxBytes = 64 * 1024, fsPromises = fs } = {},
) {
	const handle = await fsPromises.open(filePath, "r");
	try {
		const stat = await handle.stat();
		const length = Math.min(Math.max(0, maxBytes), stat.size);
		const buffer = Buffer.alloc(length);
		const { bytesRead } = await handle.read(
			buffer,
			0,
			length,
			stat.size - length,
		);
		return buffer.subarray(0, bytesRead).toString("utf8");
	} finally {
		await handle.close();
	}
}

export async function writeCrashReportAtomic(
	filePath,
	content,
	{ fsPromises = fs, mode = 0o600 } = {},
) {
	const resolvedPath = path.resolve(filePath);
	const tempPath = path.join(
		path.dirname(resolvedPath),
		`.${path.basename(resolvedPath)}.${process.pid}.${Date.now()}.${Math.random()
			.toString(16)
			.slice(2)}.tmp`,
	);
	let handle;
	try {
		handle = await fsPromises.open(tempPath, "wx", mode);
		await handle.writeFile(content, "utf8");
		await handle.sync();
		await handle.close();
		handle = null;
		await fsPromises.rename(tempPath, resolvedPath);
		await fsPromises.chmod(resolvedPath, mode);
	} catch (error) {
		await handle?.close().catch(() => {});
		await fsPromises.unlink(tempPath).catch(() => {});
		throw error;
	}
}

export async function writePendingCrashReportAtomic(
	filePath,
	content,
	{ fsPromises = fs, mode = 0o600 } = {},
) {
	const pendingPath = createPendingPath(filePath);
	await writeCrashReportAtomic(pendingPath, content, { fsPromises, mode });
	return pendingPath;
}

export async function claimCrashReport(
	filePath,
	{ fsPromises = fs, mode = 0o600 } = {},
) {
	const pendingPath = createPendingPath(filePath);
	try {
		await fsPromises.rename(path.resolve(filePath), pendingPath);
		await fsPromises.chmod(pendingPath, mode);
		return pendingPath;
	} catch (error) {
		if (error?.code === "ENOENT") return null;
		throw error;
	}
}

export async function listPendingCrashReports(
	filePath,
	{ fsPromises = fs } = {},
) {
	const resolvedPath = path.resolve(filePath);
	const prefix = pendingPrefixFor(resolvedPath);
	const suffix = pendingSuffixFor(resolvedPath);
	let entries;
	try {
		entries = await fsPromises.readdir(path.dirname(resolvedPath), {
			withFileTypes: true,
		});
	} catch (error) {
		if (error?.code === "ENOENT") return [];
		throw error;
	}
	return entries
		.filter(
			(entry) =>
				entry.isFile() &&
				entry.name.startsWith(prefix) &&
				entry.name.endsWith(suffix),
		)
		.map((entry) => path.join(path.dirname(resolvedPath), entry.name))
		.sort();
}

export async function replayQueuedCrashReport({
	filePath,
	send,
	fsPromises = fs,
}) {
	const pendingPaths = await listPendingCrashReports(filePath, { fsPromises });
	const claimedPath = await claimCrashReport(filePath, { fsPromises });
	if (claimedPath) pendingPaths.push(claimedPath);
	if (pendingPaths.length === 0) return { status: "missing", sent: 0 };

	let sent = 0;
	for (const pendingPath of pendingPaths) {
		const content = await fsPromises.readFile(pendingPath, "utf8");
		await send(content);
		await fsPromises.unlink(pendingPath);
		sent += 1;
	}
	return { status: "sent-and-removed", sent };
}
