import { spawn } from "child_process";
import { getSettingsPath } from "../config.js";
import { SettingsManager } from "../core/settings-manager.js";
import { buildShellEnv } from "./shell-env.js";
import { type ShellRuntime, selectShellRuntime } from "./shell-runtime.js";

let cachedShellRuntime: ShellRuntime | null = null;
let cachedShellRuntimeKey: string | null = null;

function getShellRuntimeCacheKey(settings: SettingsManager): string {
	return JSON.stringify({
		platform: process.platform,
		shellKind: settings.getShellKind(),
		shellPath: settings.getShellPath(),
		shellEnv: process.env.SHELL ?? null,
		comSpec: process.env.ComSpec ?? null,
		programFiles: process.env.ProgramFiles ?? null,
		programFilesX86: process.env["ProgramFiles(x86)"] ?? null,
		path: process.env.PATH ?? process.env.Path ?? process.env.path ?? null,
	});
}

export function clearShellRuntimeCache(): void {
	cachedShellRuntime = null;
	cachedShellRuntimeKey = null;
}

/**
 * Get shell configuration based on platform.
 * Borrowed from gemini-cli's shell abstraction with opencode's Git Bash fallback.
 */
export function getShellRuntime(): ShellRuntime {
	const settings = SettingsManager.create();
	const key = getShellRuntimeCacheKey(settings);
	if (cachedShellRuntime && cachedShellRuntimeKey === key) {
		return cachedShellRuntime;
	}

	const customShellPath = settings.getShellPath();
	if (customShellPath && !customShellPath.trim()) {
		throw new Error(`Custom shell path is empty. Please update shellPath in ${getSettingsPath()}`);
	}

	try {
		cachedShellRuntime = selectShellRuntime({
			shellKind: settings.getShellKind(),
			shellPath: customShellPath,
		});
		cachedShellRuntimeKey = key;
		return cachedShellRuntime;
	} catch (error) {
		cachedShellRuntime = null;
		cachedShellRuntimeKey = null;
		if (customShellPath) {
			throw new Error(
				`Custom shell path not usable: ${customShellPath}\nPlease update shellPath in ${getSettingsPath()}\n${error instanceof Error ? error.message : String(error)}`,
			);
		}
		throw error;
	}
}

export function getShellConfig(): { shell: string; args: string[] } {
	const runtime = getShellRuntime();
	return { shell: runtime.shell, args: runtime.args };
}

export function getShellEnv(): NodeJS.ProcessEnv {
	return buildShellEnv();
}

/**
 * Sanitize binary output for display/storage.
 * Removes characters that crash string-width or cause display issues:
 * - Control characters (except tab, newline, carriage return)
 * - Lone surrogates
 * - Unicode Format characters (crash string-width due to a bug)
 * - Characters with undefined code points
 */
export function sanitizeBinaryOutput(str: string): string {
	// Use Array.from to properly iterate over code points (not code units)
	// This handles surrogate pairs correctly and catches edge cases where
	// codePointAt() might return undefined
	return Array.from(str)
		.filter((char) => {
			// Filter out characters that cause string-width to crash
			// This includes:
			// - Unicode format characters
			// - Lone surrogates (already filtered by Array.from)
			// - Control chars except \t \n \r
			// - Characters with undefined code points

			const code = char.codePointAt(0);

			// Skip if code point is undefined (edge case with invalid strings)
			if (code === undefined) return false;

			// Allow tab, newline, carriage return
			if (code === 0x09 || code === 0x0a || code === 0x0d) return true;

			// Filter out control characters (0x00-0x1F, except 0x09, 0x0a, 0x0x0d)
			if (code <= 0x1f) return false;

			// Filter out Unicode format characters
			if (code >= 0xfff9 && code <= 0xfffb) return false;

			return true;
		})
		.join("");
}

/**
 * Kill a process and all its children (cross-platform)
 */
export function killProcessTree(pid: number): void {
	if (process.platform === "win32") {
		// Use taskkill on Windows to kill process tree
		try {
			spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
				stdio: "ignore",
				detached: true,
			});
		} catch {
			// Ignore errors if taskkill fails
		}
	} else {
		// Use SIGKILL on Unix/Linux/Mac
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			// Fallback to killing just the child if process group kill fails
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Process already dead
			}
		}
	}
}
