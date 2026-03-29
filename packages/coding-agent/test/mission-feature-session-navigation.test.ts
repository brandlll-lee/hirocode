import { describe, expect, it } from "vitest";
import { resolveMissionFeatureSessionNavigation } from "../src/core/missions/feature-session-navigation.js";
import type { MissionRecord } from "../src/core/missions/types.js";

function createMission(overrides: Partial<MissionRecord> = {}): MissionRecord {
	return {
		id: "mission-1",
		goal: "Build todo app",
		title: "Todo Mission",
		status: "planning",
		cwd: "F:/CodeHub/mission_test",
		createdAt: "2026-03-27T10:00:00.000Z",
		updatedAt: "2026-03-27T10:00:00.000Z",
		featureRuns: {},
		milestoneStatus: {},
		validationReports: {},
		workers: {},
		actualCost: 0,
		actualTurns: 0,
		...overrides,
	};
}

describe("mission feature session navigation", () => {
	it("returns the child session when a feature session exists", () => {
		const result = resolveMissionFeatureSessionNavigation(
			createMission({
				status: "running",
				featureRuns: {
					"app-shell": {
						featureId: "app-shell",
						status: "running",
						agent: "general",
						sessionFile: "F:/CodeHub/.hirocode/session-1.jsonl",
					},
				},
			}),
			"app-shell",
		);

		expect(result).toEqual({
			kind: "session",
			featureId: "app-shell",
			sessionFile: "F:/CodeHub/.hirocode/session-1.jsonl",
		});
	});

	it("keeps mission control waiting when a running feature session is not ready", () => {
		const result = resolveMissionFeatureSessionNavigation(
			createMission({
				status: "running",
				featureRuns: {
					"app-shell": {
						featureId: "app-shell",
						status: "pending",
						agent: "general",
					},
				},
			}),
			"app-shell",
		);

		expect(result.kind).toBe("waiting");
		if (result.kind !== "waiting") {
			throw new Error(`Expected waiting navigation result, got ${result.kind}`);
		}
		expect(result.message).toContain("worker is starting");
	});

	it("keeps the same session result for non-running missions", () => {
		const result = resolveMissionFeatureSessionNavigation(
			createMission({
				status: "paused",
				featureRuns: {
					"app-shell": {
						featureId: "app-shell",
						status: "completed",
						agent: "general",
						sessionFile: "F:/CodeHub/.hirocode/session-1.jsonl",
					},
				},
			}),
			"app-shell",
		);

		expect(result).toEqual({
			kind: "session",
			featureId: "app-shell",
			sessionFile: "F:/CodeHub/.hirocode/session-1.jsonl",
		});
	});
});
