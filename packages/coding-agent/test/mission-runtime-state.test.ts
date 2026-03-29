import { describe, expect, it } from "vitest";
import { mergeMissionRuntimeSnapshot } from "../src/core/missions/runtime-state.js";
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

describe("mission runtime state", () => {
	it("does not regress a running mission back to planning", () => {
		const running = createMission({
			status: "running",
			updatedAt: "2026-03-27T10:01:00.000Z",
		});
		const stalePlanning = createMission({
			status: "planning",
			updatedAt: "2026-03-27T10:00:30.000Z",
		});

		const merged = mergeMissionRuntimeSnapshot(running, stalePlanning);
		expect(merged.status).toBe("running");
		expect(merged.updatedAt).toBe("2026-03-27T10:01:00.000Z");
	});

	it("preserves child session metadata when a stale feature snapshot arrives", () => {
		const withSession = createMission({
			status: "running",
			updatedAt: "2026-03-27T10:02:00.000Z",
			featureRuns: {
				"app-shell": {
					featureId: "app-shell",
					status: "running",
					agent: "general",
					taskId: "task-1",
					sessionId: "session-1",
					sessionFile: "F:/CodeHub/.hirocode/session-1.jsonl",
					startedAt: "2026-03-27T10:02:00.000Z",
				},
			},
			workers: {
				"app-shell": {
					featureId: "app-shell",
					status: "running",
					agent: "general",
					taskId: "task-1",
					sessionId: "session-1",
					sessionFile: "F:/CodeHub/.hirocode/session-1.jsonl",
					startedAt: "2026-03-27T10:02:00.000Z",
					lastUpdate: "2026-03-27T10:02:05.000Z",
				},
			},
		});
		const staleSnapshot = createMission({
			status: "running",
			updatedAt: "2026-03-27T10:01:30.000Z",
			featureRuns: {
				"app-shell": {
					featureId: "app-shell",
					status: "running",
					agent: "general",
				},
			},
			workers: {
				"app-shell": {
					featureId: "app-shell",
					status: "running",
					agent: "general",
				},
			},
		});

		const merged = mergeMissionRuntimeSnapshot(withSession, staleSnapshot);
		expect(merged.featureRuns["app-shell"]?.sessionFile).toBe("F:/CodeHub/.hirocode/session-1.jsonl");
		expect(merged.featureRuns["app-shell"]?.taskId).toBe("task-1");
		expect(merged.workers["app-shell"]?.sessionFile).toBe("F:/CodeHub/.hirocode/session-1.jsonl");
		expect(merged.workers["app-shell"]?.sessionId).toBe("session-1");
	});
});
