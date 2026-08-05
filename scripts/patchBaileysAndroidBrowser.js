import fs from "node:fs/promises";
import path from "node:path";

const packageRoot = path.resolve("node_modules", "@whiskeysockets", "baileys");

const skipInitialBufferBefore = `    let didStartBuffer = false;
    process.nextTick(() => {
        if (creds.me?.id) {
            // start buffering important events
            // if we're logged in
            ev.buffer();
            didStartBuffer = true;
        }
        ev.emit('connection.update', { connection: 'connecting', receivedPendingNotifications: false, qr: undefined });
    });`;

const skipInitialBufferSyncDisabledAfter = `    let didStartBuffer = false;
    process.nextTick(() => {
        if (creds.me?.id && !syncDisabled) {
            // start buffering important events
            // if we're logged in
            ev.buffer();
            didStartBuffer = true;
        }
        else if (creds.me?.id) {
            logger.info('WA2DC skipped Baileys initial event buffer because history sync is disabled');
        }
        ev.emit('connection.update', { connection: 'connecting', receivedPendingNotifications: false, qr: undefined });
    });`;

const skipInitialBufferAfter = `    const wa2dcSkipInitialBuffer = !config.shouldSyncHistoryMessage({
        syncType: proto.HistorySync.HistorySyncType.RECENT
    });
    let didStartBuffer = false;
    process.nextTick(() => {
        if (creds.me?.id && !wa2dcSkipInitialBuffer) {
            // start buffering important events
            // if we're logged in
            ev.buffer();
            didStartBuffer = true;
        }
        else if (creds.me?.id) {
            logger.info('WA2DC skipped Baileys initial event buffer because recent history sync is disabled');
        }
        ev.emit('connection.update', { connection: 'connecting', receivedPendingNotifications: false, qr: undefined });
    });`;

const noDisabledHistoryBufferBefore = `        syncState = SyncState.AwaitingInitialSync;
        logger.info('Connection is now AwaitingInitialSync, buffering events');
        ev.buffer();
        const willSyncHistory = shouldSyncHistoryMessage(proto.Message.HistorySyncNotification.create({
            syncType: proto.HistorySync.HistorySyncType.RECENT
        }));
        if (!willSyncHistory) {
            logger.info('History sync is disabled by config, not waiting for notification. Transitioning to Online.');
            syncState = SyncState.Online;
            setTimeout(() => ev.flush(), 0);
            return;
        }
        logger.info('History sync is enabled, awaiting notification with a 20s timeout.');`;

const noDisabledHistoryBufferAfter = `        syncState = SyncState.AwaitingInitialSync;
        const willSyncHistory = shouldSyncHistoryMessage(proto.Message.HistorySyncNotification.create({
            syncType: proto.HistorySync.HistorySyncType.RECENT
        }));
        if (!willSyncHistory) {
            logger.info('History sync is disabled by config, not waiting for notification. Transitioning to Online.');
            logger.info('WA2DC history sync disabled before Baileys event buffer');
            syncState = SyncState.Online;
            return;
        }
        logger.info('Connection is now AwaitingInitialSync, buffering events');
        ev.buffer();
        logger.info('History sync is enabled, awaiting notification with a 20s timeout.');`;

const ownLidMigrationBefore = `                    const myPN = authState.creds.me.id;
                    // Store our own LID-PN mapping
                    await signalRepository.lidMapping.storeLIDPNMappings([{ lid: myLID, pn: myPN }]);
                    // Create device list for our own user (needed for bulk migration)
                    const { user, device } = jidDecode(myPN);
                    await authState.keys.set({
                        'device-list': {
                            [user]: [device?.toString() || '0']
                        }
                    });
                    // migrate our own session
                    await signalRepository.migrateSession(myPN, myLID);
                    logger.info({ myPN, myLID }, 'Own LID session created successfully');`;

const ownLidMigrationAfter = `                    const myPN = authState.creds.me.id;
                    const { user, device } = jidDecode(myPN);
                    const lidDevice = jidDecode(myLID)?.device;
                    const migrationLogContext = {
                        hasPN: Boolean(myPN),
                        hasLID: Boolean(myLID),
                        pnDevice: device ?? 0,
                        lidDevice: lidDevice ?? null
                    };
                    logger.info(migrationLogContext, 'WA2DC starting own LID mapping store');
                    // Store our own LID-PN mapping
                    await signalRepository.lidMapping.storeLIDPNMappings([{ lid: myLID, pn: myPN }]);
                    // Create device list for our own user (needed for bulk migration)
                    await authState.keys.set({
                        'device-list': {
                            [user]: [device?.toString() || '0']
                        }
                    });
                    logger.info(migrationLogContext, 'WA2DC starting own LID session migration');
                    // migrate our own session
                    const migrationResult = await signalRepository.migrateSession(myPN, myLID);
                    logger.info({
                        ...migrationLogContext,
                        migrated: migrationResult?.migrated ?? null,
                        skipped: migrationResult?.skipped ?? null,
                        total: migrationResult?.total ?? null
                    }, 'WA2DC own LID session migration complete');
                    logger.info(migrationLogContext, 'Own LID session created successfully');`;

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

const preserveDeliveredReceiptWhileUnavailableBefore = `                        else if (!sendActiveReceipts) {
                            type = 'inactive';
                        }`;

const preserveDeliveredReceiptWhileUnavailableAfter = `                        else if (!sendActiveReceipts) {
                            // WA2DC stays unavailable on connect so the phone keeps getting notifications,
                            // but inbound messages should still acknowledge delivery to the sender.
                        }`;

const toleratePreAuthNotificationAckBefore = `    const sendMessageAck = async (node, errorCode) => {
        const stanza = buildAckStanza(node, errorCode, authState.creds.me.id);
        logger.debug({ recv: { tag: node.tag, attrs: node.attrs }, sent: stanza.attrs }, 'sent ack');
        await sendNode(stanza);
    };`;

const toleratePreAuthNotificationAckAfter = `    const sendMessageAck = async (node, errorCode) => {
        const stanza = buildAckStanza(node, errorCode, authState.creds.me?.id);
        logger.debug({ recv: { tag: node.tag, attrs: node.attrs }, sent: stanza.attrs }, 'sent ack');
        await sendNode(stanza);
    };`;

const skipIncompleteLinkCodePairingBefore = `            case 'link_code_companion_reg':
                const linkCodeCompanionReg = getBinaryNodeChild(node, 'link_code_companion_reg');
                const ref = toRequiredBuffer(getBinaryNodeChildBuffer(linkCodeCompanionReg, 'link_code_pairing_ref'));
                const primaryIdentityPublicKey = toRequiredBuffer(getBinaryNodeChildBuffer(linkCodeCompanionReg, 'primary_identity_pub'));
                const primaryEphemeralPublicKeyWrapped = toRequiredBuffer(getBinaryNodeChildBuffer(linkCodeCompanionReg, 'link_code_pairing_wrapped_primary_ephemeral_pub'));`;

const skipIncompleteLinkCodePairingAfter = `            case 'link_code_companion_reg':
                const linkCodeCompanionReg = getBinaryNodeChild(node, 'link_code_companion_reg');
                const requiredPairingBuffers = {
                    link_code_pairing_ref: getBinaryNodeChildBuffer(linkCodeCompanionReg, 'link_code_pairing_ref'),
                    primary_identity_pub: getBinaryNodeChildBuffer(linkCodeCompanionReg, 'primary_identity_pub'),
                    link_code_pairing_wrapped_primary_ephemeral_pub: getBinaryNodeChildBuffer(linkCodeCompanionReg, 'link_code_pairing_wrapped_primary_ephemeral_pub')
                };
                const missingFields = Object.entries(requiredPairingBuffers)
                    .filter(([, value]) => value === undefined)
                    .map(([field]) => field);
                if (missingFields.length > 0) {
                    const childTags = Array.isArray(linkCodeCompanionReg?.content)
                        ? linkCodeCompanionReg.content.map(child => child.tag)
                        : [];
                    logger.warn({
                        missingFields,
                        stage: linkCodeCompanionReg?.attrs?.stage ?? null,
                        childTags
                    }, 'skipping incomplete link code companion registration notification');
                    break;
                }
                const ref = toRequiredBuffer(requiredPairingBuffers.link_code_pairing_ref);
                const primaryIdentityPublicKey = toRequiredBuffer(requiredPairingBuffers.primary_identity_pub);
                const primaryEphemeralPublicKeyWrapped = toRequiredBuffer(requiredPairingBuffers.link_code_pairing_wrapped_primary_ephemeral_pub);`;

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
		file: "lib/Socket/socket.js",
		marker: "WA2DC skipped Baileys initial event buffer",
		before: skipInitialBufferBefore,
		after: skipInitialBufferAfter,
	},
	{
		file: "lib/Socket/socket.js",
		marker: "const wa2dcSkipInitialBuffer",
		before: skipInitialBufferSyncDisabledAfter,
		after: skipInitialBufferAfter,
	},
	{
		file: "lib/Socket/chats.js",
		marker: "WA2DC history sync disabled before Baileys event buffer",
		before: noDisabledHistoryBufferBefore,
		after: noDisabledHistoryBufferAfter,
	},
	{
		file: "lib/Socket/socket.js",
		marker: "WA2DC own LID session migration complete",
		before: ownLidMigrationBefore,
		after: ownLidMigrationAfter,
	},
	{
		file: "lib/Socket/messages-recv.js",
		marker: "tctoken prune deferred during startup",
		before: boundedTcTokenPruneBefore,
		after: boundedTcTokenPruneAfter,
	},
	{
		file: "lib/Socket/messages-recv.js",
		marker:
			"WA2DC stays unavailable on connect so the phone keeps getting notifications",
		before: preserveDeliveredReceiptWhileUnavailableBefore,
		after: preserveDeliveredReceiptWhileUnavailableAfter,
	},
	{
		file: "lib/Socket/messages-recv.js",
		marker: "skipping incomplete link code companion registration notification",
		before: skipIncompleteLinkCodePairingBefore,
		after: skipIncompleteLinkCodePairingAfter,
	},
	{
		file: "lib/Socket/messages-recv.js",
		marker: "buildAckStanza(node, errorCode, authState.creds.me?.id)",
		before: toleratePreAuthNotificationAckBefore,
		after: toleratePreAuthNotificationAckAfter,
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
	if (packageJson.version !== "7.0.0-rc14") {
		throw new Error(
			`Baileys Android browser patch expects 7.0.0-rc14, found ${packageJson.version}`,
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
