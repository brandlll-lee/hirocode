import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/core/subagents/agent-registry.js", () => ({
	discoverAgents: () => ({ agents: [], projectAgentsDir: null }),
}));

vi.mock("../src/core/subagents/task-runner.js", () => ({
	getDelegatedTaskOutput: () => "Review: PASS - no blockers",
	runDelegatedTask: vi.fn(),
}));

import { reviewAndApplyMissionFeature } from "../src/core/missions/merge-gate.js";
import { SessionManager } from "../src/core/session-manager.js";
import { createMissionWorktree } from "../src/core/workspace/git-worktree.js";

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length > 0) {
		fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
	}
});

describe("mission merge gate", () => {
	it("creates a patch artifact and applies it to the main workspace", async () => {
		const root = createRepo();
		const sessionManager = SessionManager.create(root, path.join(root, "sessions"));
		const worktree = await createMissionWorktree({
			cwd: root,
			missionId: "mission-1",
			featureId: "feature-auth",
			rootDir: path.join(root, ".hirocode", "missions", "mission-1", "worktrees"),
		});

		fs.writeFileSync(path.join(worktree.path, "app.txt"), "hello\nworld\n", "utf-8");

		const outcome = await reviewAndApplyMissionFeature({
			missionId: "mission-1",
			cwd: root,
			sessionManager,
			artifactsDir: path.join(root, ".hirocode", "missions", "mission-1", "artifacts"),
			feature: {
				id: "feature-auth",
				title: "Auth",
				description: "Add authentication",
				milestoneId: "foundation",
				dependsOn: [],
				workspacePaths: ["app.txt"],
				agent: "general",
				successCriteria: ["Auth works"],
			},
			run: {
				featureId: "feature-auth",
				status: "completed",
				agent: "general",
				worktreePath: worktree.path,
				branch: worktree.branch,
				baseRef: worktree.baseRef,
			},
		});

		expect(outcome.status).toBe("applied");
		expect(outcome.patchFile).toBeDefined();
		expect(outcome.diffStatFile).toBeDefined();
		expect(normalizeEol(fs.readFileSync(path.join(root, "app.txt"), "utf-8"))).toBe("hello\nworld\n");
	});

	it("fails safely when the main workspace already has tracked changes", async () => {
		const root = createRepo();
		const sessionManager = SessionManager.create(root, path.join(root, "sessions"));
		const worktree = await createMissionWorktree({
			cwd: root,
			missionId: "mission-2",
			featureId: "feature-ui",
			rootDir: path.join(root, ".hirocode", "missions", "mission-2", "worktrees"),
		});

		fs.writeFileSync(path.join(worktree.path, "app.txt"), "hello\nworld\n", "utf-8");
		fs.writeFileSync(path.join(root, "app.txt"), "dirty workspace\n", "utf-8");

		const outcome = await reviewAndApplyMissionFeature({
			missionId: "mission-2",
			cwd: root,
			sessionManager,
			artifactsDir: path.join(root, ".hirocode", "missions", "mission-2", "artifacts"),
			feature: {
				id: "feature-ui",
				title: "UI",
				description: "Build the UI",
				milestoneId: "product",
				dependsOn: [],
				workspacePaths: ["app.txt"],
				agent: "general",
				successCriteria: ["UI works"],
			},
			run: {
				featureId: "feature-ui",
				status: "completed",
				agent: "general",
				worktreePath: worktree.path,
				branch: worktree.branch,
				baseRef: worktree.baseRef,
			},
		});

		expect(outcome.status).toBe("failed");
		expect(outcome.summary).toContain("Main workspace has uncommitted changes");
		expect(normalizeEol(fs.readFileSync(path.join(root, "app.txt"), "utf-8"))).toBe("dirty workspace\n");
	});
});

function createRepo(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "hirocode-mission-merge-"));
	tempDirs.push(root);
	fs.mkdirSync(path.join(root, ".hirocode"), { recursive: true });
	fs.writeFileSync(path.join(root, "app.txt"), "hello\n", "utf-8");
	execGit(root, ["init"]);
	execGit(root, ["config", "user.email", "hirocode@example.com"]);
	execGit(root, ["config", "user.name", "Hirocode Tests"]);
	execGit(root, ["add", "app.txt"]);
	execGit(root, ["commit", "-m", "initial"]);
	return root;
}

function execGit(cwd: string, args: string[]): void {
	execFileSync("git", args, { cwd, stdio: "pipe", windowsHide: true });
}

function normalizeEol(value: string): string {
	return value.replace(/\r\n/g, "\n");
}
