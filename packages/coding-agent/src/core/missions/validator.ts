import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ReadonlySessionManager } from "../session-manager.js";
import { discoverAgents } from "../subagents/agent-registry.js";
import { getDelegatedTaskOutput, runDelegatedTask } from "../subagents/task-runner.js";
import { createChildTaskSession } from "../subagents/task-sessions.js";
import type { DelegatedTaskApprovalHandler } from "../subagents/types.js";
import type {
	MissionMilestonePlan,
	MissionValidationCheck,
	MissionValidationReport,
	MissionWorkerState,
} from "./types.js";

export async function validateMissionMilestone(options: {
	missionId: string;
	cwd: string;
	sessionManager: ReadonlySessionManager;
	milestone: MissionMilestonePlan;
	workers: MissionWorkerState[];
	artifactsDir: string;
	reviewModelArg?: string;
	approvalHandler?: DelegatedTaskApprovalHandler;
}): Promise<MissionValidationReport> {
	const structuredChecks = await runStructuredChecks(options.cwd, options.milestone, options.workers);
	const reviewerAgent = discoverAgents(options.cwd, "both").agents.find((agent) => agent.name === "reviewer");
	let reviewer: MissionValidationReport["reviewer"] | undefined;
	const findings: string[] = [];

	for (const check of structuredChecks) {
		if (check.exitCode !== 0) {
			findings.push(`${check.label} failed (${check.exitCode}) in ${check.worktreePath}`);
		}
	}

	if (reviewerAgent && options.workers.length > 0) {
		const targetWorker = options.workers[0];
		const reviewPrompt = buildReviewerPrompt(options.missionId, options.milestone, structuredChecks, options.workers);
		const taskRef = createChildTaskSession(options.sessionManager, {
			cwd: targetWorker.worktreePath ?? options.cwd,
			metadata: {
				agent: reviewerAgent.name,
				agentSource: reviewerAgent.source,
				title: `${options.milestone.title} validator`,
				model: options.reviewModelArg ?? reviewerAgent.model,
				tools: reviewerAgent.tools,
				systemPrompt: reviewerAgent.systemPrompt,
			},
			state: {
				status: "running",
				task: reviewPrompt,
				description: reviewerAgent.description,
			},
		});
		const result = await runDelegatedTask({
			sessionRef: taskRef,
			agent: { ...reviewerAgent, model: options.reviewModelArg ?? reviewerAgent.model },
			task: reviewPrompt,
			defaultCwd: targetWorker.worktreePath ?? options.cwd,
			cwd: targetWorker.worktreePath ?? options.cwd,
			parentActiveToolNames: ["read", "grep", "find", "ls", "bash", "webfetch", "websearch"],
			approvalHandler: options.approvalHandler,
		});
		const summary = getDelegatedTaskOutput(result.messages) || "Reviewer completed with no summary.";
		reviewer = {
			taskId: result.taskId,
			sessionId: result.sessionId,
			sessionFile: result.sessionFile,
			summary,
			result,
		};
		if (/blocker|risk|fail|regression/i.test(summary)) {
			findings.push(summary.trim());
		}
	}

	const report: MissionValidationReport = {
		milestoneId: options.milestone.id,
		status: findings.length === 0 ? "passed" : "failed",
		structuredChecks,
		reviewer,
		findings,
		createdAt: new Date().toISOString(),
	};

	const reportFile = path.join(options.artifactsDir, `${options.milestone.id}-validation.json`);
	fs.mkdirSync(options.artifactsDir, { recursive: true });
	fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, "utf-8");

	return report;
}

async function runStructuredChecks(
	cwd: string,
	milestone: MissionMilestonePlan,
	workers: MissionWorkerState[],
): Promise<MissionValidationCheck[]> {
	const checks: MissionValidationCheck[] = [];
	const commands =
		milestone.validationCommands && milestone.validationCommands.length > 0
			? milestone.validationCommands
			: detectValidationCommands(cwd);
	for (const worker of workers) {
		const worktreePath = worker.worktreePath ?? cwd;
		for (const command of commands) {
			const result = await runCommand(command, worktreePath);
			checks.push({
				label: `${worker.featureId}: ${command}`,
				command,
				worktreePath,
				exitCode: result.exitCode,
				output: result.output,
			});
		}
	}
	return checks;
}

function detectValidationCommands(cwd: string): string[] {
	const packageJsonPath = path.join(cwd, "package.json");
	if (!fs.existsSync(packageJsonPath)) {
		return [];
	}
	try {
		const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as { scripts?: Record<string, string> };
		const scripts = packageJson.scripts ?? {};
		const candidates = ["check", "lint", "typecheck", "build"];
		return candidates.filter((name) => Boolean(scripts[name])).map((name) => `npm run ${name}`);
	} catch {
		return [];
	}
}

async function runCommand(command: string, cwd: string): Promise<{ exitCode: number; output: string }> {
	return new Promise((resolve) => {
		const proc = spawn(command, { cwd, shell: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		proc.stdout.on("data", (data) => {
			output += data.toString();
		});
		proc.stderr.on("data", (data) => {
			output += data.toString();
		});
		proc.on("close", (code) => {
			resolve({ exitCode: code ?? 1, output: output.trim() });
		});
		proc.on("error", (error) => {
			resolve({ exitCode: 1, output: error.message });
		});
	});
}

function buildReviewerPrompt(
	missionId: string,
	milestone: MissionMilestonePlan,
	checks: MissionValidationCheck[],
	workers: MissionWorkerState[],
): string {
	const checkSummary =
		checks.length > 0
			? checks.map((check) => `- ${check.command} in ${check.worktreePath}: exit ${check.exitCode}`).join("\n")
			: "- No structured validation commands were provided.";
	const workerSummary = workers
		.map((worker) => `- ${worker.featureId} (${worker.status}) in ${worker.worktreePath ?? "workspace"}`)
		.join("\n");
	return [
		`Mission ${missionId} milestone review`,
		`Milestone: ${milestone.title}`,
		"",
		"Feature runs:",
		workerSummary,
		"",
		"Structured validation results:",
		checkSummary,
		"",
		"Review the milestone for correctness, regression risk, and missing validation. Return a concise summary with blockers if any.",
	].join("\n");
}
