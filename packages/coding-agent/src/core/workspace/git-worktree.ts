import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface MissionWorktree {
	path: string;
	branch?: string;
	baseRef?: string;
	isIsolated: boolean;
	created: boolean;
}

export interface MissionWorktreeDiff {
	patch: string;
	diffStat: string;
}

export async function createMissionWorktree(options: {
	cwd: string;
	missionId: string;
	featureId: string;
	rootDir: string;
}): Promise<MissionWorktree> {
	const gitRoot = await getGitRoot(options.cwd);
	if (!gitRoot) {
		return { path: options.cwd, isIsolated: false, created: false };
	}

	const baseRef = (await getCurrentBranch(gitRoot)) ?? "HEAD";
	const branch = sanitizeBranchName(`hirocode/mission-${options.missionId}/${options.featureId}`);
	const worktreePath = path.join(options.rootDir, sanitizeSegment(options.featureId));
	fs.mkdirSync(options.rootDir, { recursive: true });

	let created = false;
	if (!fs.existsSync(worktreePath)) {
		await execGit(gitRoot, ["worktree", "add", "--force", "-b", branch, worktreePath, baseRef]);
		created = true;
	}

	return {
		path: worktreePath,
		branch,
		baseRef,
		isIsolated: true,
		created,
	};
}

export async function removeMissionWorktree(worktree: MissionWorktree, cwd: string): Promise<void> {
	if (!worktree.isIsolated || !worktree.branch) {
		return;
	}
	const gitRoot = await getGitRoot(cwd);
	if (!gitRoot) {
		return;
	}
	try {
		await execGit(gitRoot, ["worktree", "remove", "--force", worktree.path]);
	} catch {
		// Ignore cleanup errors.
	}
	try {
		await execGit(gitRoot, ["branch", "-D", worktree.branch]);
	} catch {
		// Ignore cleanup errors.
	}
	if (fs.existsSync(worktree.path)) {
		fs.rmSync(worktree.path, { recursive: true, force: true });
	}
}

async function getGitRoot(cwd: string): Promise<string | undefined> {
	try {
		const { stdout } = await execGit(cwd, ["rev-parse", "--show-toplevel"]);
		return stdout.trim();
	} catch {
		return undefined;
	}
}

export async function getMissionGitRoot(cwd: string): Promise<string | undefined> {
	return getGitRoot(cwd);
}

async function getCurrentBranch(cwd: string): Promise<string | undefined> {
	try {
		const { stdout } = await execGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
		const branch = stdout.trim();
		return branch.length > 0 ? branch : undefined;
	} catch {
		return undefined;
	}
}

async function execGit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
	return execFileAsync("git", args, { cwd, windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
}

export async function readMissionWorktreeDiff(worktree: MissionWorktree): Promise<MissionWorktreeDiff> {
	if (!worktree.isIsolated || !worktree.baseRef) {
		return { patch: "", diffStat: "" };
	}
	const baseRef = worktree.baseRef;
	const [{ stdout: diffStat }, { stdout: patch }] = await Promise.all([
		execGit(worktree.path, ["diff", "--stat", "--no-color", baseRef]),
		execGit(worktree.path, ["diff", "--binary", "--full-index", "--no-color", baseRef]),
	]);
	return { patch, diffStat };
}

export async function isMissionWorkspaceClean(cwd: string): Promise<boolean> {
	const gitRoot = await getGitRoot(cwd);
	if (!gitRoot) {
		return true;
	}
	const { stdout } = await execGit(gitRoot, ["status", "--porcelain", "--untracked-files=no"]);
	return stdout.trim().length === 0;
}

export async function applyMissionPatch(cwd: string, patchFile: string): Promise<{ success: boolean; output: string }> {
	const gitRoot = await getGitRoot(cwd);
	if (!gitRoot) {
		return { success: false, output: "Not a git workspace." };
	}
	try {
		await execGit(gitRoot, ["apply", "--check", "--3way", "--whitespace=nowarn", patchFile]);
	} catch (error) {
		return {
			success: false,
			output: error instanceof Error ? error.message : String(error),
		};
	}

	try {
		const { stdout, stderr } = await execGit(gitRoot, ["apply", "--3way", "--whitespace=nowarn", patchFile]);
		return { success: true, output: `${stdout}${stderr}`.trim() };
	} catch (error) {
		return {
			success: false,
			output: error instanceof Error ? error.message : String(error),
		};
	}
}

function sanitizeBranchName(value: string): string {
	return value
		.replace(/[^a-zA-Z0-9/_-]+/g, "-")
		.replace(/\/+/g, "/")
		.replace(/^-+|-+$/g, "");
}

function sanitizeSegment(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}
