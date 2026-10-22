import https from "node:https";
import { Agent, request } from "undici";
import {
	closeDiscordRestAgent,
	getDiscordRestAgent,
} from "./clientFactories.js";

const CERTIFICATE_ERRORS = new Set([
	"CERT_REVOKED",
	"UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
	"UNABLE_TO_VERIFY_LEAF_SIGNATURE",
	"SELF_SIGNED_CERT_IN_CHAIN",
	"CERT_REJECTED",
]);
const TARGETS = [
	["https://dv-g3b-emudhra.we-have-a-problem.com/", false],
	["https://dv-g3b-aaa-emudhra.we-have-a-problem.com/", false],
	["https://discord.com/api/v10/gateway", true],
	["https://web.whatsapp.com/", true],
];
const TIMEOUT_MS = 8_000;

const requestHttps = (url) =>
	new Promise((resolve, reject) => {
		const req = https.get(
			url,
			{ agent: false, signal: AbortSignal.timeout(TIMEOUT_MS) },
			(response) => {
				response.on("error", () => {});
				response.destroy();
				resolve(response.statusCode);
			},
		);
		req.on("error", reject);
	});

const discardResponse = (response) => {
	response.body.on("error", () => {});
	response.body.destroy();
	return response.statusCode;
};

const runTlsTrustCheck = async () => {
	console.log(
		JSON.stringify({ node: process.version, packaged: Boolean(process.pkg) }),
	);
	const agent = new Agent({ connect: { timeout: TIMEOUT_MS } });
	const clients = [
		["https", requestHttps],
		[
			"fetch",
			async (url) => {
				const response = await fetch(url, {
					signal: AbortSignal.timeout(TIMEOUT_MS),
				});
				await response.body?.cancel();
				return response.status;
			},
		],
		[
			"undici",
			async (url) =>
				discardResponse(
					await request(url, {
						dispatcher: agent,
						signal: AbortSignal.timeout(TIMEOUT_MS),
					}),
				),
		],
		[
			"discord-rest-agent",
			async (url) =>
				discardResponse(
					await getDiscordRestAgent().request({
						origin: new URL(url).origin,
						path: new URL(url).pathname,
						method: "GET",
						signal: AbortSignal.timeout(TIMEOUT_MS),
					}),
				),
		],
	];
	let failed = false;
	try {
		for (const [client, check] of clients) {
			await Promise.all(
				TARGETS.map(async ([url, shouldSucceed]) => {
					let pass;
					let result;
					try {
						result = await check(url);
						pass = shouldSucceed && result === 200;
					} catch (error) {
						result = error.cause?.code || error.code || "TLS_CHECK_FAILED";
						pass = !shouldSucceed && CERTIFICATE_ERRORS.has(result);
					}
					if (!pass) failed = true;
					console.log(
						JSON.stringify({
							client,
							host: new URL(url).hostname,
							result,
							pass,
						}),
					);
				}),
			);
		}
	} finally {
		await Promise.allSettled([agent.close(), closeDiscordRestAgent()]);
	}
	if (failed)
		throw new Error(
			"TLS trust check failed; inspect the anonymous results above.",
		);
};

export { runTlsTrustCheck };
