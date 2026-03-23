import { delimiter } from "node:path";
import { getBinDir } from "../config.js";

export interface ShellEnvOptions {
	env?: NodeJS.ProcessEnv;
	interactive?: boolean;
}

export function buildShellEnv(options: ShellEnvOptions = {}): NodeJS.ProcessEnv {
	const env = options.env ?? process.env;
	const interactive = options.interactive ?? false;
	const binDir = getBinDir();
	const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
	const currentPath = env[pathKey] ?? "";
	const pathEntries = currentPath.split(delimiter).filter(Boolean);
	const hasBinDir = pathEntries.includes(binDir);
	const updatedPath = hasBinDir ? currentPath : [binDir, currentPath].filter(Boolean).join(delimiter);

	const result: NodeJS.ProcessEnv = {
		...env,
		[pathKey]: updatedPath,
		PAGER: env.PAGER ?? "cat",
		GIT_PAGER: env.GIT_PAGER ?? env.PAGER ?? "cat",
	};

	if (interactive) {
		return result;
	}

	return {
		...result,
		GIT_TERMINAL_PROMPT: "0",
		GIT_ASKPASS: "",
		SSH_ASKPASS: "",
		GH_PROMPT_DISABLED: "1",
		GCM_INTERACTIVE: "never",
	};
}
