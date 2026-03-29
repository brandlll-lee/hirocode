import * as fs from "node:fs";
import * as path from "node:path";
import type { ReadonlySessionManager } from "../session-manager.js";
import { discoverAgents } from "../subagents/agent-registry.js";
import { getDelegatedTaskOutput, runDelegatedTask } from "../subagents/task-runner.js";
import { createChildTaskSession } from "../subagents/task-sessions.js";
import type { DelegatedTaskApprovalHandler } from "../subagents/types.js";
import { applyMissionPatch, createMissionWorktree, removeMissionWorktree } from "../workspace/git-worktree.js";
import { reviewAndApplyMissionFeature } from "./merge-gate.js";
import { buildMissionSchedule } from "./scheduler.js";
import {
	appendMissionEvent,
	resolveMissionPaths,
	saveMission,
	updateMissionStatus,
	writeMissionLink,
} from "./store.js";
import type {
	MissionEvent,
	MissionFeaturePlan,
	MissionMilestonePlan,
	MissionRecord,
	MissionValidationReport,
	MissionWorkerState,
} from "./types.js";
import { validateMissionMilestone } from "./validator.js";

export interface MissionOrchestratorCallbacks {
	onMissionUpdate?: (mission: MissionRecord, event: MissionEvent) => void;
	onDelegatedApproval?: DelegatedTaskApprovalHandler;
}

export class MissionOrchestrator {
	private paused = false;
	private aborted = false;
	private activeWorkers = new Map<string, AbortController>();

	constructor(
		private readonly sessionManager: ReadonlySessionManager,
		private readonly callbacks: MissionOrchestratorCallbacks = {},
	) {}

	async start(mission: MissionRecord): Promise<MissionRecord> {
		if (!mission.plan) {
			throw new Error("Mission plan is required before execution can start.");
		}
		let current = mission.schedule ? mission : { ...mission, schedule: buildMissionSchedule(mission.plan, 2) };
		current = await updateMissionStatus(current, "running");
		writeMissionLink(this.sessionManager as never, current);
		await this.emit(current, { type: "mission_started", missionId: current.id, createdAt: new Date().toISOString() });

		for (const milestoneSchedule of current.schedule!.milestones) {
			if (this.aborted) {
				return this.finalize(current, "aborted");
			}

			const milestone = current.plan!.milestones.find((item) => item.id === milestoneSchedule.milestoneId);
			if (!milestone) {
				continue;
			}
			if (current.milestoneStatus[milestone.id] === "completed") {
				continue;
			}
			current.currentMilestoneId = milestone.id;
			current.milestoneStatus[milestone.id] = "running";
			current.updatedAt = new Date().toISOString();
			await saveMission(current);

			for (const wave of milestoneSchedule.waves) {
				await this.waitIfPaused(current);
				if (this.aborted) {
					return this.finalize(current, "aborted");
				}
				const features = wave.featureIds
					.map((featureId) => current.plan!.features.find((feature) => feature.id === featureId))
					.filter((feature): feature is MissionFeaturePlan => Boolean(feature));
				const pendingFeatures = features.filter((feature) => {
					const status = current.featureRuns[feature.id]?.status;
					return status !== "completed" && status !== "skipped";
				});
				if (pendingFeatures.length === 0) {
					continue;
				}
				const results = await Promise.all(pendingFeatures.map((feature) => this.runFeature(current, feature)));
				current = results.reduce((_record, next) => next, current);
				if (pendingFeatures.some((feature) => current.featureRuns[feature.id]?.status === "failed")) {
					return this.pauseMission(
						current,
						`Feature execution failed in milestone ${milestone.title}. Use /mission retry or /mission replan.`,
					);
				}
			}

			const workers = milestone.featureIds
				.map((featureId) => current.workers[featureId])
				.filter((worker): worker is MissionWorkerState => Boolean(worker));
			const validation = await this.runMilestoneValidation(current, milestone, workers);
			current.validationReports[milestone.id] = validation;
			current.milestoneStatus[milestone.id] = validation.status === "passed" ? "completed" : "failed";
			current.updatedAt = new Date().toISOString();
			await saveMission(current);
			await this.emit(current, {
				type: "milestone_validated",
				missionId: current.id,
				milestoneId: milestone.id,
				status: validation.status,
				createdAt: validation.createdAt,
			});
			if (validation.status === "failed") {
				return this.pauseMission(
					current,
					`Validation failed for ${milestone.title}. Review findings in Mission Control and retry or re-plan.`,
				);
			}

			const merged = await this.mergeMilestoneFeatures(current, milestone);
			if (merged.status === "failed") {
				return merged.record;
			}
			current = merged.record;
		}

		return this.finalize(current, "completed");
	}

	pause(): void {
		this.paused = true;
	}

	resume(): void {
		this.paused = false;
	}

	abort(): void {
		this.aborted = true;
		for (const controller of this.activeWorkers.values()) {
			controller.abort();
		}
	}

	private async runFeature(mission: MissionRecord, feature: MissionFeaturePlan): Promise<MissionRecord> {
		const agent =
			discoverAgents(mission.cwd, "both").agents.find(
				(item) => item.name === (feature.agent ?? mission.plan?.modelStrategy.executionModel?.modelId ?? "general"),
			) ?? discoverAgents(mission.cwd, "both").agents.find((item) => item.name === "general");
		if (!agent) {
			throw new Error("No worker agent available for mission execution.");
		}

		const worktree = await createMissionWorktree({
			cwd: mission.cwd,
			missionId: mission.id,
			featureId: feature.id,
			rootDir: resolveMissionPaths(mission.cwd, mission.id).worktreesDir,
		});
		if (worktree.created) {
			await this.applyMergedMissionPatches(mission, worktree.path);
		}

		const sessionRef = createChildTaskSession(this.sessionManager, {
			cwd: worktree.path,
			metadata: {
				agent: agent.name,
				agentSource: agent.source,
				title: `${feature.title}`,
				model: feature.agent ? agent.model : (mission.plan?.modelStrategy.executionModel?.modelArg ?? agent.model),
				tools: agent.tools,
				systemPrompt: agent.systemPrompt,
			},
			state: {
				status: "running",
				task: feature.description,
				description: feature.title,
			},
		});

		const startedAt = new Date().toISOString();
		mission.featureRuns[feature.id] = {
			featureId: feature.id,
			status: "running",
			agent: agent.name,
			branch: worktree.branch,
			baseRef: worktree.baseRef,
			worktreePath: worktree.path,
			taskId: sessionRef.taskId,
			sessionId: sessionRef.sessionId,
			sessionFile: sessionRef.sessionFile,
			startedAt,
			mergeStatus: "pending",
		};
		mission.workers[feature.id] = {
			featureId: feature.id,
			status: "running",
			agent: agent.name,
			taskId: sessionRef.taskId,
			sessionId: sessionRef.sessionId,
			sessionFile: sessionRef.sessionFile,
			worktreePath: worktree.path,
			branch: worktree.branch,
			startedAt,
			lastUpdate: startedAt,
		};
		await saveMission({ ...mission, updatedAt: new Date().toISOString() });
		await this.emit(mission, {
			type: "feature_started",
			missionId: mission.id,
			featureId: feature.id,
			createdAt: startedAt,
		});

		const controller = new AbortController();
		this.activeWorkers.set(feature.id, controller);
		try {
			const previousFailure = mission.featureRuns[feature.id]?.lastError;
			if (previousFailure) {
				mission.featureRuns[feature.id] = { ...mission.featureRuns[feature.id], lastError: undefined };
			}
			const taskPrompt = buildFeaturePrompt(mission, feature, worktree.path, previousFailure);
			const result = await runDelegatedTask({
				sessionRef,
				agent,
				task: taskPrompt,
				defaultCwd: worktree.path,
				cwd: worktree.path,
				parentActiveToolNames: [
					"read",
					"bash",
					"edit",
					"write",
					"grep",
					"find",
					"ls",
					"webfetch",
					"websearch",
					"task",
				],
				approvalHandler: this.callbacks.onDelegatedApproval,
				signal: controller.signal,
				onUpdate: (update) => {
					mission.workers[feature.id] = {
						...mission.workers[feature.id],
						lastTool: getLastToolName(update),
						lastUpdate: new Date().toISOString(),
					};
				},
			});
			const summary = getDelegatedTaskOutput(result.messages).trim();
			mission.featureRuns[feature.id] = {
				...mission.featureRuns[feature.id],
				status: result.exitCode === 0 ? "completed" : "failed",
				completedAt: new Date().toISOString(),
				resultSummary: summary,
				lastError: result.errorMessage,
				usageCost: result.usage.cost,
			};
			mission.workers[feature.id] = {
				...mission.workers[feature.id],
				status: result.exitCode === 0 ? "completed" : "failed",
				completedAt: new Date().toISOString(),
				lastTool: getLastToolName(result),
				lastUpdate: new Date().toISOString(),
			};
			mission.actualCost += result.usage.cost;
			mission.actualTurns += result.usage.turns;
			mission.updatedAt = new Date().toISOString();
			await saveMission(mission);
			await this.emit(mission, {
				type: "feature_finished",
				missionId: mission.id,
				featureId: feature.id,
				status: mission.featureRuns[feature.id]?.status ?? "failed",
				createdAt: new Date().toISOString(),
			});
			return mission;
		} catch (error) {
			mission.featureRuns[feature.id] = {
				...mission.featureRuns[feature.id],
				status: controller.signal.aborted ? "blocked" : "failed",
				completedAt: new Date().toISOString(),
				lastError: error instanceof Error ? error.message : String(error),
			};
			mission.workers[feature.id] = {
				...mission.workers[feature.id],
				status: controller.signal.aborted ? "aborted" : "failed",
				completedAt: new Date().toISOString(),
				lastUpdate: new Date().toISOString(),
			};
			mission.updatedAt = new Date().toISOString();
			await saveMission(mission);
			await this.emit(mission, {
				type: "feature_finished",
				missionId: mission.id,
				featureId: feature.id,
				status: mission.featureRuns[feature.id]?.status ?? "failed",
				createdAt: new Date().toISOString(),
			});
			return mission;
		} finally {
			this.activeWorkers.delete(feature.id);
		}
	}

	private async runMilestoneValidation(
		mission: MissionRecord,
		milestone: MissionMilestonePlan,
		workers: MissionWorkerState[],
	): Promise<MissionValidationReport> {
		return validateMissionMilestone({
			missionId: mission.id,
			cwd: mission.cwd,
			sessionManager: this.sessionManager,
			milestone,
			workers,
			artifactsDir: mission.artifactsDir ?? "",
			reviewModelArg: mission.plan?.modelStrategy.reviewModel?.modelArg,
			approvalHandler: this.callbacks.onDelegatedApproval,
		});
	}

	private async mergeMilestoneFeatures(
		mission: MissionRecord,
		milestone: MissionMilestonePlan,
	): Promise<{ status: "ok"; record: MissionRecord } | { status: "failed"; record: MissionRecord }> {
		for (const featureId of milestone.featureIds) {
			const feature = mission.plan?.features.find((item) => item.id === featureId);
			const run = mission.featureRuns[featureId];
			if (!feature || !run || run.status !== "completed") {
				continue;
			}
			if (run.mergeStatus === "applied" || run.mergeStatus === "skipped") {
				continue;
			}

			run.mergeStatus = "reviewing";
			mission.updatedAt = new Date().toISOString();
			await saveMission(mission);
			await this.emit(mission, {
				type: "feature_merge_started",
				missionId: mission.id,
				featureId,
				createdAt: mission.updatedAt,
			});

			const outcome = await reviewAndApplyMissionFeature({
				missionId: mission.id,
				cwd: mission.cwd,
				sessionManager: this.sessionManager,
				artifactsDir: mission.artifactsDir ?? resolveMissionPaths(mission.cwd, mission.id).artifactsDir,
				feature,
				run,
				reviewModelArg: mission.plan?.modelStrategy.reviewModel?.modelArg,
				approvalHandler: this.callbacks.onDelegatedApproval,
			});

			run.patchFile = outcome.patchFile;
			run.diffStatFile = outcome.diffStatFile;
			run.mergeSummary = outcome.summary;
			run.reviewSummary = outcome.reviewSummary;
			run.mergeStatus = outcome.status;
			run.mergedAt = outcome.mergedAt;
			mission.updatedAt = new Date().toISOString();
			await saveMission(mission);
			await this.emit(mission, {
				type: "feature_merge_finished",
				missionId: mission.id,
				featureId,
				status: outcome.status,
				createdAt: mission.updatedAt,
			});

			if (outcome.status === "failed") {
				return {
					status: "failed",
					record: await this.pauseMission(
						mission,
						`Merge gate failed for ${feature.title}. Review the patch, diff review, or clean the main workspace before retrying.`,
					),
				};
			}

			if (outcome.status === "applied" || outcome.status === "skipped") {
				await removeMissionWorktree(
					{
						path: run.worktreePath ?? mission.cwd,
						branch: run.branch,
						baseRef: run.baseRef,
						isIsolated: Boolean(run.worktreePath),
						created: false,
					},
					mission.cwd,
				);
			}
		}

		return { status: "ok", record: mission };
	}

	private async waitIfPaused(mission: MissionRecord): Promise<void> {
		while (this.paused && !this.aborted) {
			await this.pauseMission(mission, mission.pausedReason ?? "Paused from Mission Control");
			await sleep(200);
		}
	}

	private async pauseMission(mission: MissionRecord, reason: string): Promise<MissionRecord> {
		const next = await updateMissionStatus({ ...mission, artifactsDir: mission.artifactsDir }, "paused", reason);
		writeMissionLink(this.sessionManager as never, next);
		await this.emit(next, { type: "mission_paused", missionId: next.id, reason, createdAt: next.updatedAt });
		return next;
	}

	private async finalize(mission: MissionRecord, status: "completed" | "aborted"): Promise<MissionRecord> {
		const next = await updateMissionStatus(mission, status);
		writeMissionLink(this.sessionManager as never, next);
		return next;
	}

	private async emit(mission: MissionRecord, event: MissionEvent): Promise<void> {
		await appendMissionEvent(mission, event);
		this.callbacks.onMissionUpdate?.(mission, event);
	}

	private async applyMergedMissionPatches(mission: MissionRecord, cwd: string): Promise<void> {
		for (const run of Object.values(mission.featureRuns)) {
			if (run.mergeStatus !== "applied" || !run.patchFile) {
				continue;
			}
			const apply = await applyMissionPatch(cwd, run.patchFile);
			if (!apply.success) {
				throw new Error(`Failed to prime worktree with prior mission patch ${run.patchFile}: ${apply.output}`);
			}
		}
	}
}

function readAgentsMd(cwd: string): string | undefined {
	const agentsMdPath = path.join(cwd, "AGENTS.md");
	if (!fs.existsSync(agentsMdPath)) {
		return undefined;
	}
	try {
		const content = fs.readFileSync(agentsMdPath, "utf-8").trim();
		return content.length > 0 ? content.slice(0, 4000) : undefined;
	} catch {
		return undefined;
	}
}

function buildFeaturePrompt(
	mission: MissionRecord,
	feature: MissionFeaturePlan,
	worktreePath: string,
	previousFailure?: string,
): string {
	const agentsMd = readAgentsMd(mission.cwd);
	return [
		`Mission: ${mission.title}`,
		`Goal: ${mission.goal}`,
		`Feature: ${feature.title}`,
		`Milestone: ${feature.milestoneId}`,
		`Worktree: ${worktreePath}`,
		"",
		feature.description,
		"",
		"## EXECUTION MANDATE",
		"You MUST use your edit and write tools to create or modify files.",
		"Do NOT just describe the implementation — the files must actually exist on disk when you finish.",
		"After creating files, run bash to verify them (e.g. run the validation commands below).",
		"Your task is NOT done until: (a) files are written, (b) validation commands pass.",
		"",
		previousFailure ? `## PREVIOUS ATTEMPT FAILED\n${previousFailure}\nFix the above before finishing.\n` : "",
		feature.successCriteria.length > 0 ? `Success criteria:\n- ${feature.successCriteria.join("\n- ")}` : "",
		feature.workspacePaths.length > 0 ? `Focus paths:\n- ${feature.workspacePaths.join("\n- ")}` : "",
		feature.validationCommands && feature.validationCommands.length > 0
			? `Validation commands (run these yourself and fix failures):\n- ${feature.validationCommands.join("\n- ")}`
			: "",
		agentsMd ? `Project conventions (AGENTS.md):\n${agentsMd}` : "",
	]
		.filter(Boolean)
		.join("\n");
}

function getLastToolName(result: { messages?: unknown[] }): string | undefined {
	const messages = Array.isArray(result.messages) ? result.messages : [];
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (!message || typeof message !== "object") {
			continue;
		}
		const typedMessage = message as { role?: string; content?: unknown };
		if (typedMessage.role !== "assistant" || !Array.isArray(typedMessage.content)) {
			continue;
		}
		for (let partIndex = typedMessage.content.length - 1; partIndex >= 0; partIndex -= 1) {
			const part = typedMessage.content[partIndex] as { type?: string; name?: string } | undefined;
			if (part?.type === "toolCall" && typeof part.name === "string") {
				return part.name;
			}
		}
	}
	return undefined;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
