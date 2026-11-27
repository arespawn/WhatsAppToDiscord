import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { compareVersionTags } from "../src/updateManifest.js";

const execFileAsync = promisify(execFile);
const STABLE_TAG = /^v\d+\.\d+\.\d+$/u;
const CREDIT_START = "<!-- wa2dc-contributors:start -->";
const CREDIT_END = "<!-- wa2dc-contributors:end -->";
const MAINTAINER_LOGINS = new Set(["arespawn"]);

const githubApi = async (endpoint, { method, fields = {}, paginate } = {}) => {
	const args = ["api", endpoint];
	if (method) args.push("--method", method);
	if (paginate) args.push("--paginate", "--slurp");
	for (const [key, value] of Object.entries(fields)) {
		args.push("-f", `${key}=${value}`);
	}
	const { stdout } = await execFileAsync("gh", args, {
		maxBuffer: 16 * 1024 * 1024,
	});
	return JSON.parse(stdout);
};

export const findPreviousStableRelease = (releases, tag) =>
	releases
		.filter(
			(release) =>
				!release.draft &&
				!release.prerelease &&
				STABLE_TAG.test(release.tag_name) &&
				compareVersionTags(release.tag_name, tag) < 0,
		)
		.sort((left, right) => compareVersionTags(right.tag_name, left.tag_name))[0]
		?.tag_name;

export const appendContributorThanks = (body, generatedNotes) => {
	const contributors = new Map();
	const newcomers = new Map();
	const add = (target, login) => {
		const normalized = login.toLowerCase();
		if (!normalized.endsWith("[bot]") && !MAINTAINER_LOGINS.has(normalized)) {
			target.set(normalized, login);
		}
	};
	for (const line of generatedNotes.split(/\r?\n/u)) {
		const author = line.match(
			/^\* .* by @([a-z\d-]+(?:\[bot\])?) in https:\/\/\S+$/iu,
		)?.[1];
		if (author) add(contributors, author);
		const newcomer = line.match(
			/^\* @([a-z\d-]+(?:\[bot\])?) made their first contribution in https:\/\/\S+$/iu,
		)?.[1];
		if (newcomer) {
			add(contributors, newcomer);
			add(newcomers, newcomer);
		}
	}
	for (const login of newcomers.keys()) {
		contributors.delete(login);
	}
	const mentions = (people) =>
		[...people.values()]
			.sort((left, right) => left.localeCompare(right))
			.map((login) => `@${login}`)
			.join(", ");
	const sections = [];
	if (contributors.size > 0) {
		sections.push(
			`## Contributors\n\nThank you to ${mentions(contributors)} for contributing to this release!`,
		);
	}
	if (newcomers.size > 0) {
		const contribution =
			newcomers.size === 1 ? "contribution" : "contributions";
		sections.push(
			`## New Contributors\n\nA special thank you to ${mentions(newcomers)} for your first ${contribution}. Welcome to WA2DC!`,
		);
	}
	const existingCredits =
		/<!-- wa2dc-contributors:start -->[\s\S]*?<!-- wa2dc-contributors:end -->/gu;
	const original = body.replace(existingCredits, "").trimEnd();
	return sections.length > 0
		? `${original}\n\n${CREDIT_START}\n${sections.join("\n\n")}\n${CREDIT_END}\n`
		: body.includes(CREDIT_START)
			? `${original}\n`
			: body;
};

export const addReleaseContributors = async ({
	repository,
	tag,
	api = githubApi,
}) => {
	if (!/^[\w.-]+\/[\w.-]+$/u.test(repository || "")) {
		throw new Error("GITHUB_REPOSITORY must identify the release repository.");
	}
	if (!STABLE_TAG.test(tag || "")) {
		throw new Error(
			"Contributor acknowledgments require a stable release tag.",
		);
	}
	const base = `repos/${repository}/releases`;
	const release = await api(`${base}/tags/${tag}`);
	if (!release.draft || release.prerelease) {
		throw new Error(
			"Contributor acknowledgments require a draft stable release.",
		);
	}
	const pages = await api(`${base}?per_page=100`, { paginate: true });
	const previousTag = findPreviousStableRelease(pages.flat(), tag);
	if (!previousTag) {
		throw new Error("No previous published stable release found for credits.");
	}
	const notes = await api(`${base}/generate-notes`, {
		method: "POST",
		fields: { tag_name: tag, previous_tag_name: previousTag },
	});
	const body = appendContributorThanks(release.body || "", notes.body);
	if (body !== (release.body || "")) {
		await api(`${base}/${release.id}`, { method: "PATCH", fields: { body } });
	}
	return body;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	addReleaseContributors({
		repository: process.env.GITHUB_REPOSITORY,
		tag: process.env.RELEASE_TAG,
	}).catch((error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
}
