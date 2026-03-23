import { describe, expect, it } from "vitest";
import { getBinDir } from "../src/config.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { buildShellEnv } from "../src/utils/shell-env.js";
import { selectShellRuntime } from "../src/utils/shell-runtime.js";

describe("shell runtime", () => {
	it("defaults to PowerShell on Windows when available", () => {
		const runtime = selectShellRuntime({
			platform: "win32",
			env: {},
			deps: {
				resolveExecutable: (exe) =>
					exe === "powershell.exe" ? "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" : undefined,
				probe: (candidate) => ({ ok: candidate.kind === "powershell" }),
			},
		});

		expect(runtime.kind).toBe("powershell");
		expect(runtime.args).toEqual(["-NoProfile", "-Command"]);
		expect(runtime.shell).toContain("powershell.exe");
	});

	it("falls back to Git Bash on Windows when PowerShell is unavailable", () => {
		const runtime = selectShellRuntime({
			platform: "win32",
			env: {
				ProgramFiles: "C:\\Program Files",
			},
			deps: {
				resolveExecutable: (exe) => {
					if (exe.includes("Git\\bin\\bash.exe")) {
						return exe;
					}
					return undefined;
				},
				probe: (candidate) => ({ ok: candidate.kind === "bash" }),
			},
		});

		expect(runtime.kind).toBe("bash");
		expect(runtime.label).toBe("Git Bash");
		expect(runtime.args).toEqual(["-c"]);
	});

	it("uses the configured shell path before platform defaults", () => {
		const runtime = selectShellRuntime({
			platform: "win32",
			env: {},
			shellPath: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
			deps: {
				resolveExecutable: (exe) => exe,
				probe: () => ({ ok: true }),
			},
		});

		expect(runtime.kind).toBe("powershell");
		expect(runtime.shell).toBe("C:\\Program Files\\PowerShell\\7\\pwsh.exe");
	});
});

describe("shell env", () => {
	it("adds tool bin directory and disables interactive git prompts", () => {
		const env = buildShellEnv({
			env: {
				PATH: "C:\\Windows\\System32",
			},
		});

		expect(env.PATH?.startsWith(getBinDir())).toBe(true);
		expect(env.GIT_TERMINAL_PROMPT).toBe("0");
		expect(env.GH_PROMPT_DISABLED).toBe("1");
		expect(env.PAGER).toBe("cat");
	});
});

describe("settings manager shell kind", () => {
	it("stores and returns shell kind preferences", () => {
		const manager = SettingsManager.inMemory();
		manager.setShellKind("powershell");
		expect(manager.getShellKind()).toBe("powershell");

		manager.setShellKind(undefined);
		expect(manager.getShellKind()).toBeUndefined();
	});
});
