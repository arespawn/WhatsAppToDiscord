import assert from "node:assert/strict";
import test from "node:test";

import state from "../src/state.js";
import utils from "../src/utils.js";

const makeRelease = ({
	tag,
	prerelease = false,
	draft = false,
	publishedAt = "2026-01-01T00:00:00Z",
}) => ({
	tag_name: tag,
	prerelease,
	draft,
	published_at: publishedAt,
	created_at: publishedAt,
	html_url: `https://example.com/releases/${tag}`,
	body: `${tag} changelog`,
});

test("fetchLatestVersion finds the newest beta beyond the first 20 releases", async () => {
	const originalFetch = global.fetch;
	const betas = Array.from({ length: 25 }, (_, index) =>
		makeRelease({
			tag: `v2.5.0-beta.${index + 1}`,
			prerelease: true,
			publishedAt: `2026-02-${String(index + 1).padStart(2, "0")}T05:07:23Z`,
		}),
	).reverse();
	global.fetch = async () =>
		new Response(
			JSON.stringify([
				...betas,
				makeRelease({
					tag: "v3.0.0-rc.1",
					prerelease: true,
					publishedAt: "2026-02-28T04:40:11Z",
				}),
				makeRelease({
					tag: "v2.1.5",
					prerelease: false,
					publishedAt: "2026-02-06T10:05:27Z",
				}),
			]),
			{
				status: 200,
				headers: { "content-type": "application/json" },
			},
		);

	try {
		const result = await utils.updater.fetchLatestVersion("unstable");
		assert.equal(result?.version, "v2.5.0-beta.25");
		assert.equal(result?.channel, "unstable");
	} finally {
		global.fetch = originalFetch;
	}
});

test("fetchLatestVersion picks newest stable release for stable channel", async () => {
	const originalFetch = global.fetch;
	let requestedUrl = "";
	global.fetch = async (url) => {
		requestedUrl = String(url);
		return new Response(
			JSON.stringify(
				makeRelease({
					tag: "v2.1.10",
					prerelease: false,
					publishedAt: "2026-02-11T10:00:00Z",
				}),
			),
			{
				status: 200,
				headers: { "content-type": "application/json" },
			},
		);
	};

	try {
		const result = await utils.updater.fetchLatestVersion("stable");
		assert.equal(result?.version, "v2.1.10");
		assert.equal(result?.channel, "stable");
		assert.match(requestedUrl, /\/releases\/latest$/u);
	} finally {
		global.fetch = originalFetch;
	}
});

test("stable channel never falls back to a prerelease response", async () => {
	const originalFetch = global.fetch;
	global.fetch = async () =>
		new Response(
			JSON.stringify(
				makeRelease({
					tag: "v3.0.0-beta.99",
					prerelease: true,
				}),
			),
			{ status: 200, headers: { "content-type": "application/json" } },
		);

	try {
		assert.equal(await utils.updater.fetchLatestVersion("stable"), null);
	} finally {
		global.fetch = originalFetch;
	}
});

test("unstable channel labels a stable fallback with the asset's stable channel", async () => {
	const originalFetch = global.fetch;
	global.fetch = async () =>
		new Response(
			JSON.stringify([
				makeRelease({ tag: "v2.5.0", prerelease: false }),
				makeRelease({ tag: "v2.5.0-rc.1", prerelease: true }),
			]),
			{ status: 200, headers: { "content-type": "application/json" } },
		);

	try {
		const result = await utils.updater.fetchLatestVersion("unstable");
		assert.equal(result?.version, "v2.5.0");
		assert.equal(result?.channel, "stable");
	} finally {
		global.fetch = originalFetch;
	}
});

test("update checks ignore older releases instead of offering a downgrade", async () => {
	const originalFetchLatestVersion = utils.updater.fetchLatestVersion;
	const originalUpdateInfo = state.updateInfo;
	try {
		utils.updater.fetchLatestVersion = async () => ({
			version: "v2.4.0",
			changes: "older",
			url: "https://example.com/v2.4.0",
			prerelease: false,
			channel: "stable",
		});
		state.updateInfo = { stale: true };
		await utils.updater.run("v2.5.0", { prompt: false });
		assert.equal(state.updateInfo, null);
	} finally {
		utils.updater.fetchLatestVersion = originalFetchLatestVersion;
		state.updateInfo = originalUpdateInfo;
	}
});

test("release HTTP helpers reject non-success responses", async () => {
	const originalFetch = global.fetch;
	global.fetch = async () => new Response("not found", { status: 404 });
	try {
		const result = await utils.requests.fetchBuffer(
			"https://example.com/missing.sig",
		);
		assert.equal(result.error?.status, 404);
	} finally {
		global.fetch = originalFetch;
	}
});
