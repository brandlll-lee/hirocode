import type {
	MissionFeaturePlan,
	MissionMilestoneSchedule,
	MissionPlan,
	MissionSchedule,
	MissionWave,
} from "./types.js";

export function buildMissionSchedule(plan: MissionPlan, maxParallel = 2): MissionSchedule {
	const featureMap = new Map(plan.features.map((feature) => [feature.id, feature]));
	const milestones: MissionMilestoneSchedule[] = [];

	for (const milestone of plan.milestones) {
		const milestoneFeatures = milestone.featureIds
			.map((featureId) => featureMap.get(featureId))
			.filter((feature): feature is MissionFeaturePlan => Boolean(feature));
		const waves = buildMilestoneWaves(milestoneFeatures, maxParallel);
		milestones.push({ milestoneId: milestone.id, waves });
	}

	return { maxParallel, milestones };
}

function buildMilestoneWaves(features: MissionFeaturePlan[], maxParallel: number): MissionWave[] {
	const remaining = new Set(features.map((feature) => feature.id));
	const completed = new Set<string>();
	const featureMap = new Map(features.map((feature) => [feature.id, feature]));
	const waves: MissionWave[] = [];
	let safety = 0;

	while (remaining.size > 0 && safety < 200) {
		safety += 1;
		const ready = Array.from(remaining)
			.map((featureId) => featureMap.get(featureId))
			.filter((feature): feature is MissionFeaturePlan => Boolean(feature))
			.filter((feature) =>
				feature.dependsOn.every((dependency) => !featureMap.has(dependency) || completed.has(dependency)),
			);

		if (ready.length === 0) {
			const fallback = Array.from(remaining)
				.map((featureId) => featureMap.get(featureId))
				.find((feature): feature is MissionFeaturePlan => Boolean(feature));
			if (!fallback) {
				break;
			}
			waves.push({ id: `wave-${waves.length + 1}`, featureIds: [fallback.id] });
			remaining.delete(fallback.id);
			completed.add(fallback.id);
			continue;
		}

		const wave: string[] = [];
		for (const feature of ready) {
			if (wave.length >= maxParallel) {
				break;
			}
			const conflicts = wave.some((featureId) => {
				const existing = featureMap.get(featureId);
				return existing ? featuresConflict(existing, feature) : false;
			});
			if (conflicts) {
				continue;
			}
			wave.push(feature.id);
		}

		if (wave.length === 0) {
			wave.push(ready[0].id);
		}

		waves.push({ id: `wave-${waves.length + 1}`, featureIds: wave });
		for (const featureId of wave) {
			remaining.delete(featureId);
			completed.add(featureId);
		}
	}

	return waves;
}

function featuresConflict(left: MissionFeaturePlan, right: MissionFeaturePlan): boolean {
	if (left.workspacePaths.length === 0 || right.workspacePaths.length === 0) {
		return true;
	}
	const leftPaths = new Set(left.workspacePaths.map(normalizeWorkspacePath));
	for (const candidate of right.workspacePaths.map(normalizeWorkspacePath)) {
		for (const existing of leftPaths) {
			if (candidate === existing || candidate.startsWith(`${existing}/`) || existing.startsWith(`${candidate}/`)) {
				return true;
			}
		}
	}
	return false;
}

function normalizeWorkspacePath(value: string): string {
	return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}
