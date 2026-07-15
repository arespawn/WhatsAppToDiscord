import path from "node:path";

const ENV_FILE_NAME = ".env";

const resolveRuntimeEnvPath = ({
	cwd = process.cwd(),
	execPath = process.execPath,
	isPackaged = Boolean(process.pkg),
} = {}) => path.join(isPackaged ? path.dirname(execPath) : cwd, ENV_FILE_NAME);

const loadRuntimeEnvironment = ({
	cwd = process.cwd(),
	execPath = process.execPath,
	isPackaged = Boolean(process.pkg),
	loadEnvFile = process.loadEnvFile,
} = {}) => {
	const envFilePath = resolveRuntimeEnvPath({ cwd, execPath, isPackaged });
	try {
		loadEnvFile(envFilePath);
		return { loaded: true, path: envFilePath };
	} catch (err) {
		if (err?.code === "ENOENT") {
			return { loaded: false, path: envFilePath };
		}
		throw new Error(`Failed to load WA2DC environment file: ${envFilePath}`, {
			cause: err,
		});
	}
};

export { loadRuntimeEnvironment, resolveRuntimeEnvPath };
