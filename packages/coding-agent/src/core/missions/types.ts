import type { ThinkingLevel } from "@hirocode/agent-core";
import type { DelegatedTaskResult } from "../subagents/types.js";

export type MissionStatus = "planning" | "running" | "paused" | "completed" | "failed" | "aborted";
export type MissionFeatureStatus = "pending" | "running" | "completed" | "failed" | "blocked" | "skipped";
export type MissionMilestoneStatus = "pending" | "running" | "validated" | "failed" | "completed";
export type MissionWorkerStatus = "pending" | "running" | "completed" | "failed" | "aborted";
export type MissionMergeStatus = "pending" | "reviewing" | "applied" | "failed" | "skipped";

export interface MissionModelSelection {
	modelArg: string;
	provider?: string;
	modelId?: string;
	thinkingLevel?: ThinkingLevel;
}

export interface MissionModelStrategy {
	planningModel?: MissionModelSelection;
	executionModel?: MissionModelSelection;
	reviewModel?: MissionModelSelection;
	summaryModel?: MissionModelSelection;
}

export interface MissionFeaturePlan {
	id: string;
	title: string;
	description: string;
	milestoneId: string;
	dependsOn: string[];
	workspacePaths: string[];
	agent?: string;
	validationCommands?: string[];
	successCriteria: string[];
}

export interface MissionMilestonePlan {
	id: string;
	title: string;
	description: string;
	featureIds: string[];
	successCriteria: string[];
	validationCommands?: string[];
}

export interface MissionBudgetEstimate {
	floorRuns: number;
	estimatedRuns: number;
	reasoning: string;
}

export interface MissionPlan {
	title: string;
	goal: string;
	summary: string;
	features: MissionFeaturePlan[];
	milestones: MissionMilestonePlan[];
	successCriteria: string[];
	validationPlan: string[];
	modelStrategy: MissionModelStrategy;
	budgetEstimate: MissionBudgetEstimate;
	markdown: string;
}

export interface MissionWave {
	id: string;
	featureIds: string[];
}

export interface MissionMilestoneSchedule {
	milestoneId: string;
	waves: MissionWave[];
}

export interface MissionSchedule {
	maxParallel: number;
	milestones: MissionMilestoneSchedule[];
}

export interface MissionFeatureRun {
	featureId: string;
	status: MissionFeatureStatus;
	agent: string;
	branch?: string;
	baseRef?: string;
	worktreePath?: string;
	taskId?: string;
	sessionId?: string;
	sessionFile?: string;
	startedAt?: string;
	completedAt?: string;
	resultSummary?: string;
	lastError?: string;
	usageCost?: number;
	patchFile?: string;
	diffStatFile?: string;
	mergeStatus?: MissionMergeStatus;
	mergeSummary?: string;
	reviewSummary?: string;
	mergedAt?: string;
}

export interface MissionValidationCheck {
	label: string;
	command: string;
	worktreePath: string;
	exitCode: number;
	output: string;
}

export interface MissionValidationReport {
	milestoneId: string;
	status: "passed" | "failed";
	structuredChecks: MissionValidationCheck[];
	reviewer?: {
		taskId?: string;
		sessionId?: string;
		sessionFile?: string;
		summary: string;
		result: DelegatedTaskResult;
	};
	findings: string[];
	createdAt: string;
}

export interface MissionWorkerState {
	featureId: string;
	status: MissionWorkerStatus;
	agent: string;
	taskId?: string;
	sessionId?: string;
	sessionFile?: string;
	worktreePath?: string;
	branch?: string;
	startedAt?: string;
	completedAt?: string;
	lastTool?: string;
	lastUpdate?: string;
}

export interface MissionRecord {
	id: string;
	goal: string;
	title: string;
	status: MissionStatus;
	cwd: string;
	createdAt: string;
	updatedAt: string;
	plan?: MissionPlan;
	schedule?: MissionSchedule;
	featureRuns: Record<string, MissionFeatureRun>;
	milestoneStatus: Record<string, MissionMilestoneStatus>;
	validationReports: Record<string, MissionValidationReport>;
	workers: Record<string, MissionWorkerState>;
	currentMilestoneId?: string;
	pausedReason?: string;
	actualCost: number;
	actualTurns: number;
	artifactsDir?: string;
}

export interface MissionSessionLink {
	missionId: string;
	status: MissionStatus;
	goal: string;
	title?: string;
	updatedAt: string;
}

export type MissionEvent =
	| { type: "mission_created"; missionId: string; goal: string; createdAt: string }
	| { type: "mission_plan_saved"; missionId: string; title: string; createdAt: string }
	| { type: "mission_started"; missionId: string; createdAt: string }
	| { type: "mission_paused"; missionId: string; reason?: string; createdAt: string }
	| { type: "mission_resumed"; missionId: string; createdAt: string }
	| { type: "mission_aborted"; missionId: string; createdAt: string }
	| { type: "feature_started"; missionId: string; featureId: string; createdAt: string }
	| { type: "feature_finished"; missionId: string; featureId: string; status: MissionFeatureStatus; createdAt: string }
	| { type: "feature_merge_started"; missionId: string; featureId: string; createdAt: string }
	| {
			type: "feature_merge_finished";
			missionId: string;
			featureId: string;
			status: MissionMergeStatus;
			createdAt: string;
	  }
	| {
			type: "milestone_validated";
			missionId: string;
			milestoneId: string;
			status: "passed" | "failed";
			createdAt: string;
	  };
