import path from "node:path";
import { fileURLToPath } from "node:url";

const CONVENTIONAL_PR_TITLE =
	/^(?:feat|fix|perf|revert|docs|test|ci|build|chore|refactor|style)(?:\([a-z0-9][a-z0-9._/-]*\))?!?: .+$/u;

const isConventionalPrTitle = (title) =>
	typeof title === "string" && CONVENTIONAL_PR_TITLE.test(title.trim());

const getSemverBumpForPrTitle = (title) => {
	const normalized = typeof title === "string" ? title.trim() : "";
	if (!isConventionalPrTitle(normalized)) return null;
	if (/^[a-z]+(?:\([^)]*\))?!:/u.test(normalized)) return "major";
	const type = normalized.match(/^([a-z]+)/u)?.[1];
	if (type === "feat") return "minor";
	if (["fix", "perf", "revert"].includes(type)) return "patch";
	return null;
};

const isCli =
	process.argv[1] &&
	path.resolve(process.argv[1]) ===
		path.resolve(fileURLToPath(import.meta.url));
if (isCli) {
	const title = process.env.PR_TITLE || process.argv.slice(2).join(" ");
	if (!isConventionalPrTitle(title)) {
		console.error(
			"PR title must follow Conventional Commits, for example `feat: add thread mode`, `fix(deps): update sharp`, or `feat!: change storage format`.",
		);
		process.exitCode = 1;
	}
}

export {
	CONVENTIONAL_PR_TITLE,
	getSemverBumpForPrTitle,
	isConventionalPrTitle,
};
