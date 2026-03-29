import * as fs from "node:fs";
import * as path from "node:path";
import type { ReadonlySessionManager } from "../session-manager.js";
import { discoverAgents } from "../subagents/agent-registry.js";
import { getDelegatedTaskOutput, runDelegatedTask } from "../subagents/task-runner.js";
import { createChildTaskSession } from "../subagents/task-sessions.js";
import type { DelegatedTaskApprovalHandler } from "../subagents/types.js";
import {
	applyMissionPatch,
	isMissionWorkspaceClean,
	type MissionWorktree,
	readMissionWorktreeDiff,
} from "../workspace/git-worktree.js";
import type { MissionFeaturePlan, MissionFeatureRun } from "./types.js";

export interface MissionMergeOutcome {
	status: "applied" | "failed" | "skipped";
	summary: string;
	reviewSummary?: string;
	patchFile?: string;
	diffStatFile?: string;
	mergedAt?: string;
}

export async function reviewAndApplyMissionFeature(options: {
	missionId: string;
	cwd: string;
	sessionManager: ReadonlySessionManager;
	artifactsDir: string;
	feature: MissionFeaturePlan;
	run: MissionFeatureRun;
	reviewModelArg?: string;
	approvalHandler?: DelegatedTaskApprovalHandler;
}): Promise<MissionMergeOutcome> {
	if (!options.run.worktreePath || !options.run.baseRef) {
		return { status: "skipped", summary: "Feature did not run inside an isolated worktree." };
	}

	const worktree: MissionWorktree = {
		path: options.run.worktreePath,
		branch: options.run.branch,
		baseRef: options.run.baseRef,
		isIsolated: true,
		created: false,
	};
	const diff = await readMissionWorktreeDiff(worktree);
	if (!diff.patch.trim()) {
		return { status: "skipped", summary: "No patch to merge from the feature worktree." };
	}

	const patchDir = path.join(options.artifactsDir, "patches");
	fs.mkdirSync(patchDir, { recursive: true });
	const patchFile = path.join(patchDir, `${options.feature.id}.patch`);
	const diffStatFile = path.join(patchDir, `${options.feature.id}.diffstat.txt`);
	fs.writeFileSync(patchFile, diff.patch, "utf-8");
	fs.writeFileSync(diffStatFile, `${diff.diffStat.trim()}\n`, "utf-8");

	const cleanWorkspace = await isMissionWorkspaceClean(options.cwd);
	if (!cleanWorkspace) {
		return {
			status: "failed",
			summary: "Main workspace has uncommitted changes. Merge paused to avoid corrupting the primary checkout.",
			patchFile,
			diffStatFile,
		};
	}

	const reviewerAgent = discoverAgents(options.cwd, "both").agents.find((agent) => agent.name === "reviewer");
	let reviewSummary = "";
	if (reviewerAgent) {
		const prompt = buildMergeReviewPrompt(
			options.missionId,
			options.feature,
			options.run,
			patchFile,
			diffStatFile,
			diff.diffStat,
		);
		const sessionRef = createChildTaskSession(options.sessionManager, {
			cwd: options.run.worktreePath,
			metadata: {
				agent: reviewerAgent.name,
				agentSource: reviewerAgent.source,
				title: `${options.feature.title} merge reviewer`,
				model: options.reviewModelArg ?? reviewerAgent.model,
				tools: reviewerAgent.tools,
				systemPrompt: reviewerAgent.systemPrompt,
			},
			state: {
				status: "running",
				task: prompt,
				description: reviewerAgent.description,
			},
		});
		const result = await runDelegatedTask({
			sessionRef,
			agent: { ...reviewerAgent, model: options.reviewModelArg ?? reviewerAgent.model },
			task: prompt,
			defaultCwd: options.run.worktreePath,
			cwd: options.run.worktreePath,
			parentActiveToolNames: ["read", "grep", "find", "ls", "bash", "webfetch", "websearch"],
			approvalHandler: options.approvalHandler,
		});
		reviewSummary = getDelegatedTaskOutput(result.messages).trim();
		if (isNegativeReview(reviewSummary)) {
			return {
				status: "failed",
				summary: "Patch review failed. Mission paused before merging changes into the main workspace.",
				reviewSummary,
				patchFile,
				diffStatFile,
			};
		}
	}

	const applyResult = await applyMissionPatch(options.cwd, patchFile);
	if (!applyResult.success) {
		return {
			status: "failed",
			summary: `Patch apply failed: ${applyResult.output}`,
			reviewSummary,
			patchFile,
			diffStatFile,
		};
	}

	return {
		status: "applied",
		summary: "Patch applied to the main workspace.",
		reviewSummary,
		patchFile,
		diffStatFile,
		mergedAt: new Date().toISOString(),
	};
}

function buildMergeReviewPrompt(
	missionId: string,
	feature: MissionFeaturePlan,
	run: MissionFeatureRun,
	patchFile: string,
	diffStatFile: string,
	diffStat: string,
): string {
	return [
		`Mission ${missionId} merge review`,
		`Feature: ${feature.title}`,
		`Patch file: ${patchFile}`,
		`Diff stat file: ${diffStatFile}`,
		`Worktree: ${run.worktreePath}`,
		`Base ref: ${run.baseRef}`,
		"",
		"Structured diff stat:",
		diffStat.trim() || "(no diff stat available)",
		"",
		"Review the patch before it is merged into the main workspace.",
		"Return one of:",
		"Review: PASS - <short rationale>",
		"Review: FAIL - <blockers and next steps>",
	].join("\n");
}

function isNegativeReview(summary: string): boolean {
	if (!summary) {
		return false;
	}
	if (/Review:\s*FAIL/i.test(summary)) {
		return true;
	}
	return /blocker|regression|unsafe|do not merge|fail/i.test(summary) && !/no blockers/i.test(summary);
}
