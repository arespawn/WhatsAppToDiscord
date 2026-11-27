import assert from "node:assert/strict";
import test from "node:test";
import {
	addReleaseContributors,
	appendContributorThanks,
	findPreviousStableRelease,
} from "../scripts/addReleaseContributors.js";

const GENERATED_NOTES = `## What's Changed
* Feature mentioning @someone by @alice in https://github.com/example/bridge/pull/12
* Fix by @bob in https://github.com/example/bridge/pull/13
* Another fix by @alice in https://github.com/example/bridge/pull/14
* Update dependencies by @dependabot[bot] in https://github.com/example/bridge/pull/15
* Release by @wa2dc-release-automation[bot] in https://github.com/example/bridge/pull/16

## New Contributors
* @bob made their first contribution in https://github.com/example/bridge/pull/13
* @dependabot[bot] made their first contribution in https://github.com/example/bridge/pull/15

**Full Changelog**: https://github.com/example/bridge/compare/v2.5.6...v2.6.0
`;

test("stable credits thank unique authors and welcome first-time contributors", () => {
	const body = "## Features\n\n* Keep the normalized beta changes.\n";
	const result = appendContributorThanks(body, GENERATED_NOTES);
	assert.ok(result.startsWith(body));
	assert.match(result, /Thank you to @alice for contributing/u);
	assert.match(result, /## New Contributors\n\nA special thank you to @bob/u);
	assert.equal(result.match(/@bob/gu)?.length, 1);
	assert.doesNotMatch(result, /@someone|dependabot|automation|What's Changed/u);
	assert.equal(appendContributorThanks(result, GENERATED_NOTES), result);

	const updated = appendContributorThanks(
		result,
		"* Fix by @carol in https://github.com/example/bridge/pull/17\n",
	);
	assert.match(updated, /Thank you to @carol/u);
	assert.doesNotMatch(updated, /@alice|@bob|New Contributors/u);
	assert.equal(updated.match(/## Contributors/gu)?.length, 1);
	const withFooter = appendContributorThanks(
		`${result}\n## Additional notes\n\nKeep these too.\n`,
		GENERATED_NOTES,
	);
	assert.ok(withFooter.startsWith(body));
	assert.match(withFooter, /## Additional notes\n\nKeep these too\./u);
	assert.equal(appendContributorThanks(result, ""), body);
});

test("newcomers appear once and the maintainer is excluded from both sections", () => {
	const body = "## Features\n\n* A new feature.\n";
	const notes = `* Feature by @arespawn in https://github.com/example/bridge/pull/1
* Fix by @wallscode in https://github.com/example/bridge/pull/2
* @ARESPAWN made their first contribution in https://github.com/example/bridge/pull/1
* @WALLSCODE made their first contribution in https://github.com/example/bridge/pull/2
`;
	const result = appendContributorThanks(body, notes);
	assert.doesNotMatch(result, /arespawn|## Contributors/iu);
	assert.equal(result.match(/@wallscode/giu)?.length, 1);
	assert.match(
		result,
		/A special thank you to @WALLSCODE for your first contribution\./u,
	);
	assert.equal(
		appendContributorThanks(
			body,
			"* Feature by @ARESPAWN in https://github.com/example/bridge/pull/1",
		),
		body,
	);
});

test("credits omit empty sections for releases with only automated changes", () => {
	const body = "## Bug Fixes\n\n* Dependency updates.\n";
	assert.equal(
		appendContributorThanks(
			body,
			"* Update by @dependabot[bot] in https://github.com/example/bridge/pull/15\n",
		),
		body,
	);
});

test("credit baseline skips beta, draft, current, and future stable releases", () => {
	const releases = [
		{ tag_name: "v2.5.9" },
		{ tag_name: "v2.6.0-beta.3", prerelease: true },
		{ tag_name: "v2.5.11", draft: true },
		{ tag_name: "v2.6.0" },
		{ tag_name: "v2.7.0" },
		{ tag_name: "v2.5.10" },
		{ tag_name: "v2.5.12", prerelease: true },
		{ tag_name: "unrelated-tag" },
	];
	assert.equal(findPreviousStableRelease(releases, "v2.6.0"), "v2.5.10");
	assert.equal(findPreviousStableRelease([], "v2.6.0"), undefined);
});

test("draft enrichment paginates releases and explicitly spans the stable cycle", async () => {
	let body = "## Features\n\n* Aggregated beta changes.\n";
	const requests = [];
	const api = async (endpoint, options = {}) => {
		requests.push({ endpoint, ...options });
		if (endpoint.endsWith("/tags/v2.6.0")) {
			return { id: 42, draft: true, prerelease: false, body };
		}
		if (endpoint.endsWith("?per_page=100")) {
			assert.equal(options.paginate, true);
			return [
				[{ tag_name: "v2.6.0-beta.3", prerelease: true }],
				[{ tag_name: "v2.5.6", draft: false, prerelease: false }],
			];
		}
		if (endpoint.endsWith("/generate-notes")) {
			assert.equal(options.method, "POST");
			assert.deepEqual(options.fields, {
				tag_name: "v2.6.0",
				previous_tag_name: "v2.5.6",
			});
			return { body: GENERATED_NOTES };
		}
		assert.equal(endpoint, "repos/example/bridge/releases/42");
		assert.equal(options.method, "PATCH");
		body = options.fields.body;
		return {};
	};
	const options = { repository: "example/bridge", tag: "v2.6.0", api };
	assert.equal(await addReleaseContributors(options), body);
	assert.match(body, /Thank you to @alice for contributing/u);
	assert.equal(body.match(/@bob/gu)?.length, 1);
	await addReleaseContributors(options);
	assert.equal(requests.filter(({ method }) => method === "PATCH").length, 1);
});

test("credits reject beta or published releases before modifying anything", async () => {
	for (const release of [
		{ draft: false, prerelease: false },
		{ draft: true, prerelease: true },
	]) {
		let requests = 0;
		await assert.rejects(
			addReleaseContributors({
				repository: "example/bridge",
				tag: "v2.6.0",
				api: async () => {
					requests += 1;
					return release;
				},
			}),
			/draft stable release/u,
		);
		assert.equal(requests, 1);
	}
	await assert.rejects(
		addReleaseContributors({
			repository: "example/bridge",
			tag: "v2.6.0-beta.3",
		}),
		/stable release tag/u,
	);
});

test("credit generation fails without changing the draft if GitHub fails", async () => {
	for (const failure of ["missing-baseline", "generation-error"]) {
		const methods = [];
		await assert.rejects(
			addReleaseContributors({
				repository: "example/bridge",
				tag: "v2.6.0",
				api: async (endpoint, options = {}) => {
					methods.push(options.method);
					if (endpoint.includes("/tags/")) {
						return { id: 42, draft: true, prerelease: false, body: "Notes" };
					}
					if (endpoint.includes("?per_page=")) {
						return failure === "missing-baseline"
							? [[]]
							: [[{ tag_name: "v2.5.6" }]];
					}
					throw new Error("GitHub request failed");
				},
			}),
			failure === "missing-baseline"
				? /No previous published stable/u
				: /GitHub request failed/u,
		);
		assert.ok(!methods.includes("PATCH"));
	}
});
