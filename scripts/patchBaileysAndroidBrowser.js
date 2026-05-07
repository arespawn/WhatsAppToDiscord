import fs from "node:fs/promises";
import path from "node:path";

const packageRoot = path.resolve(
	"node_modules",
	"@whiskeysockets",
	"baileys",
);

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
	if (packageJson.version !== "7.0.0-rc10") {
		throw new Error(
			`Baileys Android browser patch expects 7.0.0-rc10, found ${packageJson.version}`,
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
