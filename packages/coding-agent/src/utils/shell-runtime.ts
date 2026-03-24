import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path, { delimiter } from "node:path";

export type ShellKind = "cmd" | "powershell" | "bash";

export interface ShellRuntime {
	shell: string;
	args: string[];
	kind: ShellKind;
	label: string;
	source: string;
}

interface ShellCandidate extends ShellRuntime {
	probe: string;
}

export interface ShellRuntimeDeps {
	resolveExecutable: (exe: string, env: NodeJS.ProcessEnv) => string | undefined;
	probe: (candidate: ShellCandidate, env: NodeJS.ProcessEnv) => { ok: boolean; reason?: string };
}

export interface ShellRuntimeOptions {
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	shellKind?: ShellKind;
	shellPath?: string;
	deps?: Partial<ShellRuntimeDeps>;
}

const WINDOWS_PATH_EXTENSIONS = [".exe", ".cmd", ".bat", ""];
const POSIX_PATH_EXTENSIONS = [""];
const SHELL_BLACKLIST = new Set(["fish", "nu"]);
const PROBE_TOKEN = "hirocode-shell-ready";

function normalizeFileName(value: string, platform: NodeJS.Platform): string {
	return platform === "win32" ? path.win32.basename(value).toLowerCase() : path.basename(value).toLowerCase();
}

function detectShellKind(value: string): ShellKind {
	const file = value.split(/[\\/]/).pop()?.toLowerCase() ?? value.toLowerCase();
	if (file === "cmd" || file === "cmd.exe") {
		return "cmd";
	}
	if (file === "powershell" || file === "powershell.exe" || file === "pwsh" || file === "pwsh.exe") {
		return "powershell";
	}
	return "bash";
}

function getArgs(kind: ShellKind): string[] {
	if (kind === "powershell") {
		return ["-NoProfile", "-Command"];
	}
	if (kind === "cmd") {
		return ["/d", "/s", "/c"];
	}
	return ["-c"];
}

function getProbe(kind: ShellKind): string {
	if (kind === "powershell") {
		return `Write-Output '${PROBE_TOKEN}'`;
	}
	if (kind === "cmd") {
		return `echo ${PROBE_TOKEN}`;
	}
	return `printf '${PROBE_TOKEN}'`;
}

function getLabel(shell: string, kind: ShellKind, platform: NodeJS.Platform): string {
	if (kind === "powershell") {
		return "PowerShell";
	}
	if (kind === "cmd") {
		return "Command Prompt";
	}

	const file = normalizeFileName(shell, platform);
	if (file === "zsh") {
		return "zsh";
	}
	if (file === "sh") {
		return "sh";
	}
	if (platform === "win32" && shell.toLowerCase().includes(`${path.win32.sep}git${path.win32.sep}`)) {
		return "Git Bash";
	}
	return "bash";
}

function createCandidate(shell: string, kind: ShellKind, platform: NodeJS.Platform, source: string): ShellCandidate {
	return {
		shell,
		args: getArgs(kind),
		kind,
		label: getLabel(shell, kind, platform),
		source,
		probe: getProbe(kind),
	};
}

export function resolveExecutableSync(exe: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
	if (path.isAbsolute(exe)) {
		return existsSync(exe) ? exe : undefined;
	}

	const currentPath = env.PATH ?? env.Path ?? env.path ?? "";
	const paths = currentPath.split(delimiter).filter(Boolean);
	const extensions = process.platform === "win32" ? WINDOWS_PATH_EXTENSIONS : POSIX_PATH_EXTENSIONS;

	for (const dir of paths) {
		for (const ext of extensions) {
			const fullPath = path.join(dir, exe + ext);
			if (existsSync(fullPath)) {
				return fullPath;
			}
		}
	}

	return undefined;
}

function getGitBashCandidates(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): ShellCandidate[] {
	if (platform !== "win32") {
		return [];
	}

	const candidates: ShellCandidate[] = [];
	const programFiles = env.ProgramFiles;
	if (programFiles) {
		candidates.push(
			createCandidate(path.win32.join(programFiles, "Git", "bin", "bash.exe"), "bash", platform, "git-bash"),
		);
	}
	const programFilesX86 = env["ProgramFiles(x86)"];
	if (programFilesX86) {
		candidates.push(
			createCandidate(path.win32.join(programFilesX86, "Git", "bin", "bash.exe"), "bash", platform, "git-bash-x86"),
		);
	}

	const git = resolveExecutableSync("git", env);
	if (git) {
		candidates.push(
			createCandidate(path.win32.join(git, "..", "..", "bin", "bash.exe"), "bash", platform, "git-bash-from-git"),
		);
	}

	return candidates;
}

function getBashCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): ShellCandidate[] {
	const candidates: ShellCandidate[] = [];
	const currentShell = env.SHELL;
	if (currentShell) {
		const file = normalizeFileName(currentShell, platform);
		if (!SHELL_BLACKLIST.has(file)) {
			candidates.push(createCandidate(currentShell, "bash", platform, "env:SHELL"));
		}
	}

	if (platform === "win32") {
		candidates.push(...getGitBashCandidates(env, platform));
		candidates.push(createCandidate("bash.exe", "bash", platform, "PATH:bash.exe"));
		return candidates;
	}

	if (platform === "darwin") {
		candidates.push(createCandidate("/bin/bash", "bash", platform, "darwin:/bin/bash"));
	}

	candidates.push(createCandidate("bash", "bash", platform, "PATH:bash"));
	candidates.push(createCandidate("/bin/sh", "bash", platform, "fallback:sh"));
	return candidates;
}

function getPowerShellCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): ShellCandidate[] {
	const candidates: ShellCandidate[] = [];
	const comSpec = env.ComSpec;
	if (comSpec) {
		const file = normalizeFileName(comSpec, platform);
		if (file === "powershell.exe" || file === "powershell" || file === "pwsh.exe" || file === "pwsh") {
			candidates.push(createCandidate(comSpec, "powershell", platform, "env:ComSpec"));
		}
	}

	candidates.push(createCandidate("pwsh.exe", "powershell", platform, "PATH:pwsh.exe"));
	candidates.push(createCandidate("powershell.exe", "powershell", platform, "PATH:powershell.exe"));
	candidates.push(createCandidate("pwsh", "powershell", platform, "PATH:pwsh"));
	candidates.push(createCandidate("powershell", "powershell", platform, "PATH:powershell"));
	return candidates;
}

function getCmdCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): ShellCandidate[] {
	if (platform !== "win32") {
		return [];
	}

	const candidates: ShellCandidate[] = [];
	if (env.ComSpec && detectShellKind(env.ComSpec) === "cmd") {
		candidates.push(createCandidate(env.ComSpec, "cmd", platform, "env:ComSpec"));
	}
	candidates.push(createCandidate("cmd.exe", "cmd", platform, "PATH:cmd.exe"));
	return candidates;
}

function dedupeCandidates(candidates: ShellCandidate[]): ShellCandidate[] {
	const seen = new Set<string>();
	return candidates.filter((candidate) => {
		const key = `${candidate.kind}:${candidate.shell.toLowerCase()}:${candidate.args.join(" ")}`;
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});
}

export function getShellCandidates(options: ShellRuntimeOptions = {}): ShellCandidate[] {
	const platform = options.platform ?? process.platform;
	const env = options.env ?? process.env;

	if (options.shellPath) {
		return [createCandidate(options.shellPath, detectShellKind(options.shellPath), platform, "settings.shellPath")];
	}

	if (options.shellKind === "powershell") {
		return dedupeCandidates(getPowerShellCandidates(platform, env));
	}
	if (options.shellKind === "cmd") {
		return dedupeCandidates(getCmdCandidates(platform, env));
	}
	if (options.shellKind === "bash") {
		return dedupeCandidates(getBashCandidates(platform, env));
	}

	if (platform === "win32") {
		return dedupeCandidates([
			...getPowerShellCandidates(platform, env),
			...getBashCandidates(platform, env),
			...getCmdCandidates(platform, env),
		]);
	}

	return dedupeCandidates(getBashCandidates(platform, env));
}

function defaultProbe(candidate: ShellCandidate, env: NodeJS.ProcessEnv): { ok: boolean; reason?: string } {
	const result = spawnSync(candidate.shell, [...candidate.args, candidate.probe], {
		encoding: "utf-8",
		timeout: 1500,
		windowsHide: true,
		env,
	});

	if (result.error) {
		return { ok: false, reason: result.error.message };
	}

	if (result.status !== 0) {
		const stderr = result.stderr?.toString().trim();
		return { ok: false, reason: stderr || `exit ${result.status}` };
	}

	const stdout = result.stdout?.toString() ?? "";
	if (!stdout.includes(PROBE_TOKEN)) {
		return { ok: false, reason: "probe output mismatch" };
	}

	return { ok: true };
}

export function selectShellRuntime(options: ShellRuntimeOptions = {}): ShellRuntime {
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const deps: ShellRuntimeDeps = {
		resolveExecutable: options.deps?.resolveExecutable ?? resolveExecutableSync,
		probe: options.deps?.probe ?? defaultProbe,
	};

	const failures: string[] = [];
	for (const candidate of getShellCandidates({ ...options, platform, env })) {
		const resolved = deps.resolveExecutable(candidate.shell, env);
		if (!resolved) {
			failures.push(`${candidate.label} (${candidate.source}): executable not found`);
			continue;
		}

		const runtime: ShellCandidate = {
			...candidate,
			shell: resolved,
			label: getLabel(resolved, candidate.kind, platform),
		};
		const result = deps.probe(runtime, env);
		if (result.ok) {
			return {
				shell: runtime.shell,
				args: runtime.args,
				kind: runtime.kind,
				label: runtime.label,
				source: runtime.source,
			};
		}

		failures.push(`${runtime.label} (${runtime.source}): ${result.reason ?? "probe failed"}`);
	}

	const settingHint = options.shellPath
		? "Update shellPath in settings.json."
		: "Set shellKind or shellPath in settings.json.";
	throw new Error(
		`No usable shell found for platform ${platform}. ${settingHint}\n${failures.map((item) => `  - ${item}`).join("\n")}`,
	);
}
