import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { slashCommands } from "../src/discordHandler.js";

const rootDir = path.resolve(import.meta.dirname, "..");
const docsDir = path.join(rootDir, "docs");
const commandsPath = path.join(docsDir, "commands.md");

const readText = (filePath) => fs.readFileSync(filePath, "utf8");

const walkFiles = (directory) =>
	fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const entryPath = path.join(directory, entry.name);
		return entry.isDirectory() ? walkFiles(entryPath) : [entryPath];
	});

const parseCommandSections = (markdown) => {
	const headings = [...markdown.matchAll(/^### `\/([a-z0-9]+)`\s*$/gmu)];
	return headings.map((heading, index) => ({
		name: heading[1],
		body: markdown.slice(
			heading.index,
			headings[index + 1]?.index ?? markdown.length,
		),
	}));
};

const normalizeLinkTarget = (rawTarget) =>
	decodeURIComponent(rawTarget.replace(/^<|>$/gu, "").split(/[?#]/u)[0]);

const resolveDocsTarget = (sourcePath, rawTarget) => {
	const target = normalizeLinkTarget(rawTarget);
	if (!target) return null;
	if (target === "/") return path.join(docsDir, "README.md");
	if (target.startsWith("/")) return path.join(docsDir, target.slice(1));
	return path.resolve(path.dirname(sourcePath), target);
};

const isExternalTarget = (target) =>
	/^(?:[a-z]+:|#|\/\/)/iu.test(target) && target !== "/";

test("the slash-command reference matches runtime registration metadata", () => {
	const markdown = readText(commandsPath);
	const sections = parseCommandSections(markdown);
	const expectedNames = slashCommands.map(({ name }) => name).sort();
	const documentedNames = sections.map(({ name }) => name).sort();

	assert.equal(
		new Set(documentedNames).size,
		documentedNames.length,
		"each slash command must have exactly one H3 section",
	);
	assert.deepEqual(documentedNames, expectedNames);

	const commandByName = new Map(
		slashCommands.map((command) => [command.name, command]),
	);
	for (const section of sections) {
		const usageLines = [
			...section.body.matchAll(/^Usage: `\/([a-z0-9]+)([^`]*)`\s*$/gmu),
		];
		assert.equal(
			usageLines.length,
			1,
			`/${section.name} must have one normalized Usage line`,
		);
		const [usage] = usageLines;
		assert.equal(usage[1], section.name);

		const documentedOptions = [
			...usage[2].matchAll(/\b([a-z][a-z0-9_]*):/gu),
		].map((match) => match[1]);
		const registeredOptions = commandByName
			.get(section.name)
			.options.map(({ name }) => name);
		assert.deepEqual(
			documentedOptions,
			registeredOptions,
			`/${section.name} option names/order must match registration metadata`,
		);
	}
});

test("relative documentation links and images resolve", () => {
	const rootMarkdown = ["README.md", "SECURITY.md", "AGENTS.md"].map((name) =>
		path.join(rootDir, name),
	);
	const docsTextFiles = walkFiles(docsDir).filter((filePath) =>
		[".md", ".txt"].includes(path.extname(filePath)),
	);
	const missing = [];

	for (const filePath of [...rootMarkdown, ...docsTextFiles]) {
		const content = readText(filePath);
		const markdownTargets = [
			...content.matchAll(
				/!?\[[^\]]*\]\((<[^>]+>|[^\s)]+)(?:\s+["'][^"']*["'])?\)/gu,
			),
		].map((match) => match[1]);
		const htmlImageTargets = [
			...content.matchAll(/<img\s+[^>]*src=["']([^"']+)["'][^>]*>/giu),
		].map((match) => match[1]);

		for (const target of [...markdownTargets, ...htmlImageTargets]) {
			if (isExternalTarget(target)) continue;
			const resolved = resolveDocsTarget(filePath, target);
			if (resolved && !fs.existsSync(resolved)) {
				missing.push(
					`${path.relative(rootDir, filePath)}: ${target} -> ${path.relative(rootDir, resolved)}`,
				);
			}
		}
	}

	assert.deepEqual(missing, []);
});

test("all historical setup screenshots remain visible", () => {
	const setup = readText(path.join(docsDir, "setup.md"));
	const historicalScreenshots = fs
		.readdirSync(path.join(docsDir, "_media"))
		.filter((name) => name.endsWith(".jpg"))
		.sort();

	assert.equal(historicalScreenshots.length, 14);
	for (const screenshot of historicalScreenshots) {
		assert.match(
			setup,
			new RegExp(
				`src=["']_media/${screenshot.replaceAll(".", "\\.")}["']`,
				"u",
			),
			`${screenshot} must remain embedded in setup.md`,
		);
	}
});
