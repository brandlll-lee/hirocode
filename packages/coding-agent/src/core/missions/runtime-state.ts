import type { MissionFeatureRun, MissionRecord, MissionStatus, MissionWorkerState } from "./types.js";

export function mergeMissionRuntimeSnapshot(current: MissionRecord | undefined, next: MissionRecord): MissionRecord {
	if (!current || current.id !== next.id) {
		return next;
	}

	return {
		...current,
		...next,
		status: mergeMissionStatus(current.status, next.status),
		updatedAt: newerTimestamp(current.updatedAt, next.updatedAt),
		plan: next.plan ?? current.plan,
		schedule: next.schedule ?? current.schedule,
		currentMilestoneId: next.currentMilestoneId ?? current.currentMilestoneId,
		pausedReason: next.status === "paused" ? (next.pausedReason ?? current.pausedReason) : next.pausedReason,
		featureRuns: mergeFeatureRuns(current.featureRuns, next.featureRuns),
		workers: mergeWorkers(current.workers, next.workers),
		validationReports: { ...current.validationReports, ...next.validationReports },
		milestoneStatus: { ...current.milestoneStatus, ...next.milestoneStatus },
		actualCost: Math.max(current.actualCost, next.actualCost),
		actualTurns: Math.max(current.actualTurns, next.actualTurns),
		artifactsDir: next.artifactsDir ?? current.artifactsDir,
	};
}

function mergeMissionStatus(current: MissionStatus, next: MissionStatus): MissionStatus {
	if (current !== "planning" && next === "planning") {
		return current;
	}
	return next;
}

function mergeFeatureRuns(
	current: Record<string, MissionFeatureRun>,
	next: Record<string, MissionFeatureRun>,
): Record<string, MissionFeatureRun> {
	const merged: Record<string, MissionFeatureRun> = { ...current };
	for (const [featureId, nextRun] of Object.entries(next)) {
		const currentRun = merged[featureId];
		merged[featureId] = !currentRun ? nextRun : mergeFeatureRun(currentRun, nextRun);
	}
	return merged;
}

function mergeFeatureRun(current: MissionFeatureRun, next: MissionFeatureRun): MissionFeatureRun {
	const { newer, older } = pickByFreshness(current, next, getFeatureRunFreshness);
	return {
		...older,
		...newer,
		branch: newer.branch ?? older.branch,
		baseRef: newer.baseRef ?? older.baseRef,
		worktreePath: newer.worktreePath ?? older.worktreePath,
		taskId: newer.taskId ?? older.taskId,
		sessionId: newer.sessionId ?? older.sessionId,
		sessionFile: newer.sessionFile ?? older.sessionFile,
		startedAt: newer.startedAt ?? older.startedAt,
		completedAt: newer.completedAt ?? older.completedAt,
		lastError: newer.lastError ?? older.lastError,
		patchFile: newer.patchFile ?? older.patchFile,
		diffStatFile: newer.diffStatFile ?? older.diffStatFile,
		mergeSummary: newer.mergeSummary ?? older.mergeSummary,
		reviewSummary: newer.reviewSummary ?? older.reviewSummary,
		mergedAt: newer.mergedAt ?? older.mergedAt,
		usageCost: newer.usageCost ?? older.usageCost,
	};
}

function mergeWorkers(
	current: Record<string, MissionWorkerState>,
	next: Record<string, MissionWorkerState>,
): Record<string, MissionWorkerState> {
	const merged: Record<string, MissionWorkerState> = { ...current };
	for (const [featureId, nextWorker] of Object.entries(next)) {
		const currentWorker = merged[featureId];
		merged[featureId] = !currentWorker ? nextWorker : mergeWorker(currentWorker, nextWorker);
	}
	return merged;
}

function mergeWorker(current: MissionWorkerState, next: MissionWorkerState): MissionWorkerState {
	const { newer, older } = pickByFreshness(current, next, getWorkerFreshness);
	return {
		...older,
		...newer,
		taskId: newer.taskId ?? older.taskId,
		sessionId: newer.sessionId ?? older.sessionId,
		sessionFile: newer.sessionFile ?? older.sessionFile,
		worktreePath: newer.worktreePath ?? older.worktreePath,
		branch: newer.branch ?? older.branch,
		startedAt: newer.startedAt ?? older.startedAt,
		completedAt: newer.completedAt ?? older.completedAt,
		lastTool: newer.lastTool ?? older.lastTool,
		lastUpdate: newer.lastUpdate ?? older.lastUpdate,
	};
}

function pickByFreshness<T>(current: T, next: T, getFreshness: (value: T) => number): { newer: T; older: T } {
	return getFreshness(next) >= getFreshness(current)
		? { newer: next, older: current }
		: { newer: current, older: next };
}

function getFeatureRunFreshness(run: MissionFeatureRun): number {
	return timestampScore(run.completedAt) || timestampScore(run.mergedAt) || timestampScore(run.startedAt);
}

function getWorkerFreshness(worker: MissionWorkerState): number {
	return timestampScore(worker.lastUpdate) || timestampScore(worker.completedAt) || timestampScore(worker.startedAt);
}

function newerTimestamp(left: string, right: string): string {
	return timestampScore(right) >= timestampScore(left) ? right : left;
}

function timestampScore(value: string | undefined): number {
	if (!value) return 0;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : 0;
}
