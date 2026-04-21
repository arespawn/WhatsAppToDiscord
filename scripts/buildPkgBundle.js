import fs from "node:fs";
import esbuild from "esbuild";

const BUNDLE_EXTERNALS = ["sharp"];
const ESM_REQUIRE_BANNER =
	"import { createRequire as __esbuildCreateRequire } from 'module'; const require = globalThis.__wa2dcPkgRequire ?? __esbuildCreateRequire(import.meta.url);";

await esbuild.build({
	entryPoints: ["src/runner.js"],
	bundle: true,
	platform: "node",
	format: "esm",
	external: BUNDLE_EXTERNALS,
	target: "node24",
	banner: {
		js: ESM_REQUIRE_BANNER,
	},
	outfile: "out.js",
});

const bundleBase64 = fs.readFileSync("out.js", "base64");
const pkgBootstrap = `'use strict';

globalThis.__wa2dcPkgRequire = require;

const bundleUrl = "data:text/javascript;base64,${bundleBase64}";

(async () => {
	await import(bundleUrl);
})().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
`;

fs.writeFileSync("out.cjs", pkgBootstrap);
