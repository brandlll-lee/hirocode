import type { MissionBudgetEstimate, MissionPlan } from "./types.js";

export function estimateMissionBudget(plan: Pick<MissionPlan, "features" | "milestones">): MissionBudgetEstimate {
	const floorRuns = plan.features.length + 2 * plan.milestones.length;
	const estimatedRuns = floorRuns + Math.max(0, Math.ceil(plan.features.length / 3) - 1);
	return {
		floorRuns,
		estimatedRuns,
		reasoning: `Droid's published heuristic starts at features + 2 * milestones (${floorRuns}). Hirocode adds a small buffer for likely follow-up fixes and validator retries (${estimatedRuns}).`,
	};
}
