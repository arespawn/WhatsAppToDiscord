import esbuild from "esbuild";

const BUNDLE_EXTERNALS = ["sharp"];

await esbuild.build({
	entryPoints: ["src/runner.js"],
	bundle: true,
	platform: "node",
	format: "cjs",
	external: BUNDLE_EXTERNALS,
	target: "node24",
	outfile: "out.cjs",
});
