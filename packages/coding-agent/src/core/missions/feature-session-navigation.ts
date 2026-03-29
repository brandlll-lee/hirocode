import type { MissionRecord } from "./types.js";

export type MissionFeatureSessionNavigation =
	| { kind: "session"; featureId: string; sessionFile: string }
	| { kind: "waiting"; featureId: string; message: string }
	| { kind: "unavailable"; featureId: string; message: string };

export function resolveMissionFeatureSessionNavigation(
	mission: MissionRecord | undefined,
	featureId: string,
): MissionFeatureSessionNavigation {
	const run = mission?.featureRuns[featureId];
	const sessionFile = run?.sessionFile;

	if (sessionFile) {
		return { kind: "session", featureId, sessionFile };
	}

	if (mission?.status === "running" && (!run || run.status === "pending" || run.status === "running")) {
		return {
			kind: "waiting",
			featureId,
			message: `Feature ${featureId} worker is starting; child session is not ready yet.`,
		};
	}

	return {
		kind: "unavailable",
		featureId,
		message: `Feature ${featureId} does not have a child session yet.`,
	};
}
