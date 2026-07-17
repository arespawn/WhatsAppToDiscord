import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

const RUNTIME_SIDECAR_DEPENDENCIES = Object.freeze([
	"sharp",
	"canvas",
	"jsdom",
	"lottie-web",
]);

const RUNTIME_SIDECAR_PACKAGE = Object.freeze({
	private: true,
	description: "WA2DC packaged runtime sidecar",
});

const getBin = (name) => (process.platform === "win32" ? `${name}.cmd` : name);

const run = (command, args, options = {}) => {
	const result = spawnSync(command, args, {
		stdio: "inherit",
		...(process.platform === "win32" ? { shell: true } : null),
		...options,
	});
	if (result.error) throw result.error;
	if (typeof result.status === "number" && result.status !== 0) {
		throw new Error(
			`Command failed (${result.status}): ${command} ${args.join(" ")}`,
		);
	}
};

const readInstalledPackageJson = (packageName) => {
	let currentDir = path.dirname(require.resolve(packageName));
	while (true) {
		const packageJsonPath = path.join(currentDir, "package.json");
		if (fs.existsSync(packageJsonPath)) {
			return JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
		}

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) {
			throw new Error(`Unable to locate package.json for ${packageName}`);
		}
		currentDir = parentDir;
	}
};

const getRuntimeSidecarPackageSpecs = () =>
	RUNTIME_SIDECAR_DEPENDENCIES.map((packageName) => {
		try {
			const packageJson = readInstalledPackageJson(packageName);
			return `${packageName}@${packageJson.version}`;
		} catch (err) {
			throw new Error(
				`Unable to resolve ${packageName} for packaged runtime sidecar: ${err?.message || err}`,
			);
		}
	});

const writeRuntimeSidecarPackage = (runtimeDir) => {
	fs.writeFileSync(
		path.join(runtimeDir, "package.json"),
		`${JSON.stringify(RUNTIME_SIDECAR_PACKAGE, null, 2)}\n`,
	);
};

const installRuntimeSidecarPackages = (
	runtimeDir,
	packageSpecs,
	{ targetOs = null, targetCpu = null, targetLibc = null } = {},
) => {
	const installArgs = [
		"install",
		"--omit=dev",
		"--no-package-lock",
		"--no-save",
		...packageSpecs,
	];
	if (targetOs) installArgs.push(`--os=${targetOs}`);
	if (targetCpu) installArgs.push(`--cpu=${targetCpu}`);
	if (targetLibc) installArgs.push(`--libc=${targetLibc}`);

	run(getBin("npm"), installArgs, { cwd: runtimeDir });
};

const prepareRuntimeSidecar = (
	runtimeDir,
	packageSpecs,
	installOptions = {},
) => {
	fs.rmSync(runtimeDir, { recursive: true, force: true });
	fs.mkdirSync(runtimeDir, { recursive: true });
	writeRuntimeSidecarPackage(runtimeDir);
	installRuntimeSidecarPackages(runtimeDir, packageSpecs, installOptions);
};

export { getBin, getRuntimeSidecarPackageSpecs, prepareRuntimeSidecar, run };
