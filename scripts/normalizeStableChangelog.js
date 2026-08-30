import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const USER_FACING_SECTIONS = [
	"Features",
	"Bug Fixes",
	"Performance",
	"Reverts",
	"Dependencies",
	"Documentation",
	"Refactoring",
];

const STABLE_HEADING = /^## \[(\d+\.\d+\.\d+)\]\(/u;
const BETA_HEADING = /^## \[(\d+\.\d+\.\d+)-beta\.\d+\]\(/u;
const getHeadingVersion = (section, headingPattern) =>
	section.match(headingPattern)?.[1] || null;

const parseSections = (section) => {
	const lines = section.trim().split("\n");
	const entries = new Map();
	let currentSection = null;

	for (const line of lines.slice(1)) {
		const heading = line.match(/^### (.+)$/u);
		if (heading) {
			currentSection = heading[1];
			continue;
		}
		if (currentSection && line.startsWith("* ")) {
			const sectionEntries = entries.get(currentSection) || [];
			sectionEntries.push(line);
			entries.set(currentSection, sectionEntries);
		}
	}

	return entries;
};

const addEntries = (target, source) => {
	for (const sectionName of USER_FACING_SECTIONS) {
		const existing = target.get(sectionName) || [];
		for (const entry of source.get(sectionName) || []) {
			if (!existing.includes(entry)) {
				existing.push(entry);
			}
		}
		target.set(sectionName, existing);
	}
};

const renderStableSection = (heading, entries) => {
	const sections = [];
	for (const sectionName of USER_FACING_SECTIONS) {
		const sectionEntries = entries.get(sectionName) || [];
		if (sectionEntries.length === 0) {
			continue;
		}
		sections.push(`### ${sectionName}\n\n${sectionEntries.join("\n")}`);
	}

	return `${heading}\n\n${sections.join("\n\n")}\n\n`;
};

const getPreviousStableTag = (sections, stableIndex, version) => {
	for (const section of sections.slice(stableIndex + 1)) {
		const stableVersion = getHeadingVersion(section, STABLE_HEADING);
		if (stableVersion) {
			return `v${stableVersion}`;
		}
	}

	const betaSections = sections.filter(
		(section) => getHeadingVersion(section, BETA_HEADING) === version,
	);
	for (const section of [
		...betaSections.filter((entry) => /^## \[[^\]]+-beta\.1\]\(/u.test(entry)),
		...betaSections.filter((entry) => !/^## \[[^\]]+-beta\.1\]\(/u.test(entry)),
	]) {
		const link = section.match(/^## \[[^\]]+\]\(([^)]+)\)/u)?.[1];
		const previousTag = link?.match(
			/\/compare\/([^.)]+(?:\.[^.)]+)*)\.\.\./u,
		)?.[1];
		if (previousTag) {
			return previousTag;
		}
	}

	return null;
};

const updateStableCompareLink = (heading, version, previousStableTag) => {
	if (!previousStableTag) {
		return heading;
	}

	const compareMarker = "/compare/";
	const compareStart = heading.indexOf(compareMarker);
	if (compareStart === -1) {
		return heading;
	}

	const compareValueStart = compareStart + compareMarker.length;
	const compareValueEnd = heading.indexOf(")", compareValueStart);
	if (compareValueEnd === -1) {
		return heading;
	}

	const compareValue = heading.slice(compareValueStart, compareValueEnd);
	const separator = compareValue.lastIndexOf("...");
	if (separator === -1 || compareValue.slice(separator + 3) !== `v${version}`) {
		return heading;
	}

	return `${heading.slice(0, compareValueStart)}${previousStableTag}...v${version}${heading.slice(compareValueEnd)}`;
};

const getStableSection = (markdown, version) => {
	const section = markdown.split(/(?=^## )/mu).find((entry) => {
		const match = entry.match(STABLE_HEADING);
		return match?.[1] === version;
	});
	if (!section) {
		throw new Error(`Stable release notes not found for ${version}.`);
	}
	return section.trimEnd();
};

export const updateStableReleasePullRequestBody = (
	body,
	stableChangelog,
	version,
) => {
	const stableSection = getStableSection(stableChangelog, version);
	const match = Array.from(body.matchAll(/^## \[(\d+\.\d+\.\d+)\]\(/gmu)).find(
		(entry) => entry[1] === version,
	);
	if (!match || match.index === undefined) {
		throw new Error(`Stable release PR notes not found for ${version}.`);
	}

	const sectionStart = match.index;
	const bodyFromSection = body.slice(sectionStart);
	const contentStart = bodyFromSection.indexOf("\n") + 1;
	const content = bodyFromSection.slice(contentStart);
	const boundaries = [content.match(/^## /mu), content.match(/^---\r?$/mu)]
		.filter(Boolean)
		.map((boundary) => boundary.index);
	const sectionEnd =
		boundaries.length > 0
			? sectionStart + contentStart + Math.min(...boundaries)
			: body.length;
	const suffix = body.slice(sectionEnd).replace(/^\r?\n*/u, "");

	return `${body.slice(0, sectionStart)}${stableSection}\n\n${suffix}`;
};

export const normalizeStableChangelog = (changelog, version) => {
	const sections = changelog.split(/(?=^## )/mu);
	const stableIndex = sections.findIndex((section) => {
		const match = section.match(STABLE_HEADING);
		return match?.[1] === version;
	});
	if (stableIndex === -1) {
		throw new Error(`Stable changelog section not found for ${version}.`);
	}

	const entries = new Map();
	addEntries(entries, parseSections(sections[stableIndex]));
	for (const section of sections) {
		const match = section.match(BETA_HEADING);
		if (match?.[1] === version) {
			addEntries(entries, parseSections(section));
		}
	}

	const heading = updateStableCompareLink(
		sections[stableIndex].split("\n", 1)[0],
		version,
		getPreviousStableTag(sections, stableIndex, version),
	);
	sections[stableIndex] = renderStableSection(heading, entries);
	return sections.join("");
};

const parseArgs = (args) => {
	const options = {
		file: "CHANGELOG.md",
		pullRequestBody: null,
		version: null,
	};
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (
			arg === "--file" ||
			arg === "--pull-request-body" ||
			arg === "--version"
		) {
			const value = args[index + 1];
			if (!value) {
				throw new Error(`${arg} requires a value.`);
			}
			const optionName =
				arg === "--pull-request-body" ? "pullRequestBody" : arg.slice(2);
			options[optionName] = value;
			index += 1;
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}
	return options;
};

const main = async () => {
	const options = parseArgs(process.argv.slice(2));
	const file = path.resolve(options.file);
	const version =
		options.version ||
		JSON.parse(await fs.readFile("package.json", "utf8")).version;
	const changelog = await fs.readFile(file, "utf8");
	const normalized = normalizeStableChangelog(changelog, version);
	if (normalized !== changelog) {
		await fs.writeFile(file, normalized);
		console.log(`Normalized stable changelog notes for ${version}.`);
	}
	if (options.pullRequestBody) {
		const bodyFile = path.resolve(options.pullRequestBody);
		const body = await fs.readFile(bodyFile, "utf8");
		const normalizedBody = updateStableReleasePullRequestBody(
			body,
			normalized,
			version,
		);
		if (normalizedBody !== body) {
			await fs.writeFile(bodyFile, normalizedBody);
			console.log(`Normalized stable release PR notes for ${version}.`);
		}
	}
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
}
