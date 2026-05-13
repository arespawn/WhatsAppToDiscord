import fs from "node:fs/promises";
import path from "node:path";

const packageRoot = path.resolve("node_modules", "@whiskeysockets", "baileys");

const boundedTcTokenPruneBefore = `    async function pruneExpiredTcTokens() {
        try {
            await tcTokenIndexLoaded;
            // Union with the persisted index picks up JIDs added by other layers
            // (history sync) without needing inter-module wiring.
            const persisted = await readTcTokenIndex(authState.keys);
            const allJids = new Set(tcTokenKnownJids);
            for (const jid of persisted)
                allJids.add(jid);
            if (!allJids.size)
                return;
            const jids = [...allJids];
            const allTokens = await authState.keys.get('tctoken', jids);
            const writes = {};
            const survivors = new Set();
            let mutated = 0;
            for (const jid of jids) {
                const entry = allTokens[jid];
                if (!entry) {
                    // Tracked but nothing in store — drop from index.
                    mutated++;
                    continue;
                }
                const hasPeerToken = !!entry.token?.length;
                const peerTokenExpired = hasPeerToken && isTcTokenExpired(entry.timestamp);
                const hasSenderTs = entry.senderTimestamp !== undefined;
                const senderTsExpired = hasSenderTs && isTcTokenExpired(entry.senderTimestamp);
                const keepPeerToken = hasPeerToken && !peerTokenExpired;
                const keepSenderTs = hasSenderTs && !senderTsExpired;
                if (!keepPeerToken && !keepSenderTs) {
                    writes[jid] = null;
                    mutated++;
                }
                else if (peerTokenExpired && keepSenderTs) {
                    writes[jid] = { token: Buffer.alloc(0), senderTimestamp: entry.senderTimestamp };
                    survivors.add(jid);
                    mutated++;
                }
                else {
                    survivors.add(jid);
                }
            }
            if (mutated === 0)
                return;
            await authState.keys.set({
                tctoken: {
                    ...writes,
                    [TC_TOKEN_INDEX_KEY]: {
                        token: Buffer.from(JSON.stringify([...survivors]))
                    }
                }
            });
            tcTokenKnownJids.clear();
            for (const jid of survivors)
                tcTokenKnownJids.add(jid);
            logger.debug({ mutated, remaining: survivors.size }, 'pruned expired tctokens');
        }
        catch (err) {
            logger.warn({ err: err?.message }, 'failed to prune expired tctokens');
        }
    }`;

const boundedTcTokenPruneAfter = `    const TC_TOKEN_PRUNE_BATCH_SIZE = 250;
    const TC_TOKEN_PRUNE_STARTUP_DEFER_MS = 60_000;
    const TC_TOKEN_PRUNE_STARTUP_DEFER_THRESHOLD = 2_000;
    let tcTokenPruneDeferred = false;
    async function pruneExpiredTcTokens() {
        try {
            await tcTokenIndexLoaded;
            // Union with the persisted index picks up JIDs added by other layers
            // (history sync) without needing inter-module wiring.
            const persisted = await readTcTokenIndex(authState.keys);
            const allJids = new Set(tcTokenKnownJids);
            for (const jid of persisted)
                allJids.add(jid);
            if (!allJids.size)
                return;
            const jids = [...allJids];
            logger.info({ count: jids.length, batchSize: TC_TOKEN_PRUNE_BATCH_SIZE }, 'starting bounded tctoken prune');
            const uptimeMs = typeof process?.uptime === 'function' ? process.uptime() * 1000 : TC_TOKEN_PRUNE_STARTUP_DEFER_MS;
            if (jids.length > TC_TOKEN_PRUNE_STARTUP_DEFER_THRESHOLD && uptimeMs < TC_TOKEN_PRUNE_STARTUP_DEFER_MS) {
                if (!tcTokenPruneDeferred) {
                    tcTokenPruneDeferred = true;
                    const delayMs = Math.max(1_000, TC_TOKEN_PRUNE_STARTUP_DEFER_MS - uptimeMs);
                    logger.warn({ count: jids.length, delayMs }, 'tctoken prune deferred during startup');
                    setTimeout(() => {
                        tcTokenPruneDeferred = false;
                        void pruneExpiredTcTokens();
                    }, delayMs).unref?.();
                }
                return;
            }
            const writes = {};
            const survivors = new Set();
            let mutated = 0;
            for (let offset = 0; offset < jids.length; offset += TC_TOKEN_PRUNE_BATCH_SIZE) {
                const batch = jids.slice(offset, offset + TC_TOKEN_PRUNE_BATCH_SIZE);
                const batchTokens = await authState.keys.get('tctoken', batch);
                for (const jid of batch) {
                    const entry = batchTokens[jid];
                    if (!entry) {
                        // Tracked but nothing in store — drop from index.
                        mutated++;
                        continue;
                    }
                    const hasPeerToken = !!entry.token?.length;
                    const peerTokenExpired = hasPeerToken && isTcTokenExpired(entry.timestamp);
                    const hasSenderTs = entry.senderTimestamp !== undefined;
                    const senderTsExpired = hasSenderTs && isTcTokenExpired(entry.senderTimestamp);
                    const keepPeerToken = hasPeerToken && !peerTokenExpired;
                    const keepSenderTs = hasSenderTs && !senderTsExpired;
                    if (!keepPeerToken && !keepSenderTs) {
                        writes[jid] = null;
                        mutated++;
                    }
                    else if (peerTokenExpired && keepSenderTs) {
                        writes[jid] = { token: Buffer.alloc(0), senderTimestamp: entry.senderTimestamp };
                        survivors.add(jid);
                        mutated++;
                    }
                    else {
                        survivors.add(jid);
                    }
                }
            }
            if (mutated === 0)
                return;
            await authState.keys.set({
                tctoken: {
                    ...writes,
                    [TC_TOKEN_INDEX_KEY]: {
                        token: Buffer.from(JSON.stringify([...survivors]))
                    }
                }
            });
            tcTokenKnownJids.clear();
            for (const jid of survivors)
                tcTokenKnownJids.add(jid);
            logger.debug({ mutated, remaining: survivors.size }, 'pruned expired tctokens');
        }
        catch (err) {
            logger.warn({ err: err?.message }, 'failed to prune expired tctokens');
        }
    }`;

const replacements = [
	{
		file: "lib/Utils/browser-utils.js",
		before:
			"    windows: browser => ['Windows', browser, '10.0.22631'],\n" +
			"    /** The appropriate browser based on your OS & release */",
		after:
			"    windows: browser => ['Windows', browser, '10.0.22631'],\n" +
			"    android: browser => [browser, 'Android', ''],\n" +
			"    /** The appropriate browser based on your OS & release */",
	},
	{
		file: "lib/Types/index.d.ts",
		before:
			"    windows(browser: string): [string, string, string];\n" +
			"    appropriate(browser: string): [string, string, string];",
		after:
			"    windows(browser: string): [string, string, string];\n" +
			"    android(browser: string): [string, string, string];\n" +
			"    appropriate(browser: string): [string, string, string];",
	},
	{
		file: "lib/Utils/validate-connection.js",
		before: "        platform: proto.ClientPayload.UserAgent.Platform.WEB,",
		after:
			"        platform: config.browser[1].toLocaleLowerCase().includes('android')\n" +
			"            ? proto.ClientPayload.UserAgent.Platform.ANDROID\n" +
			"            : proto.ClientPayload.UserAgent.Platform.WEB,",
	},
	{
		file: "lib/Utils/validate-connection.js",
		before: "    payload.webInfo = getWebInfo(config);",
		after:
			"    if (!config.browser[1].toLocaleLowerCase().includes('android')) {\n" +
			"        payload.webInfo = getWebInfo(config);\n" +
			"    }",
	},
	{
		file: "lib/Utils/validate-connection.js",
		before:
			"const getPlatformType = (platform) => {\n" +
			"    const platformType = platform.toUpperCase();\n" +
			"    return (proto.DeviceProps.PlatformType[platformType] ||",
		after:
			"const getPlatformType = (platform) => {\n" +
			"    const platformType = platform.toUpperCase();\n" +
			"    if (platformType === 'ANDROID') {\n" +
			"        return proto.DeviceProps.PlatformType.ANDROID_PHONE;\n" +
			"    }\n" +
			"    return (proto.DeviceProps.PlatformType[platformType] ||",
	},
	{
		file: "lib/Socket/socket.js",
		marker: "Using the Android browser is experimental",
		before: "    const syncDisabled =",
		after:
			"    if (browser[1].toLocaleLowerCase().includes('android')) {\n" +
			"        logger.warn('\\u26a0\\ufe0f Using the Android browser is experimental and may lead to unexpected behavior. Use at your own risk.');\n" +
			"    }\n" +
			"    const syncDisabled =",
	},
	{
		file: "lib/Socket/chats.js",
		marker:
			"History sync is enabled, awaiting notification with a 20s timeout.",
		before:
			"        // On reconnection (accountSyncCounter > 0), the server does not push\n" +
			"        // history sync notifications — the device already has its data.\n" +
			"        // Skip the 20s wait and go online immediately.\n" +
			"        if (authState.creds.accountSyncCounter > 0) {\n" +
			"            logger.info('Reconnection with existing sync data, skipping history sync wait. Transitioning to Online.');\n" +
			"            syncState = SyncState.Online;\n" +
			"            setTimeout(() => ev.flush(), 0);\n" +
			"            return;\n" +
			"        }\n" +
			"        logger.info('First connection, awaiting history sync notification with a 20s timeout.');",
		after:
			"        logger.info('History sync is enabled, awaiting notification with a 20s timeout.');",
	},
	{
		file: "lib/Socket/messages-recv.js",
		marker: "tctoken prune deferred during startup",
		before: boundedTcTokenPruneBefore,
		after: boundedTcTokenPruneAfter,
	},
];

const replaceOnce = async ({ file, marker, before, after }) => {
	const target = path.join(packageRoot, file);
	const content = await fs.readFile(target, "utf8");
	if (content.includes(marker || after)) {
		return false;
	}
	if (!content.includes(before)) {
		throw new Error(`Could not apply Baileys Android browser patch to ${file}`);
	}
	await fs.writeFile(target, content.replace(before, after));
	return true;
};

const main = async () => {
	const packageJson = JSON.parse(
		await fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
	);
	if (packageJson.version !== "7.0.0-rc11") {
		throw new Error(
			`Baileys Android browser patch expects 7.0.0-rc11, found ${packageJson.version}`,
		);
	}

	const changed = [];
	for (const replacement of replacements) {
		if (await replaceOnce(replacement)) {
			changed.push(replacement.file);
		}
	}

	if (changed.length > 0) {
		console.log(
			`Applied Baileys PR 2201 Android browser patch to ${[
				...new Set(changed),
			].join(", ")}`,
		);
	}
};

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
