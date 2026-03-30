import { describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.js";
import {
	createInactiveSpecState,
	createSpecState,
	hasPendingSpecPlan,
	isSpecArmedForNextTurn,
	readLatestSpecState,
	writeSpecState,
} from "../src/core/spec/state.js";

describe("spec state mask", () => {
	it("enables the spec mask for non-inactive states by default", () => {
		const planning = createSpecState({ phase: "planning" });
		expect(planning.maskEnabled).toBe(true);
		expect(createSpecState({ phase: "approved" }).maskEnabled).toBe(true);
		expect(createSpecState({ phase: "executing" }).maskEnabled).toBe(true);
		expect(createSpecState({ phase: "inactive" }).maskEnabled).toBe(false);
	});

	it("clears the mask when creating an inactive state", () => {
		const state = createInactiveSpecState(createSpecState({ phase: "planning", maskEnabled: true }));
		expect(state.phase).toBe("inactive");
		expect(state.maskEnabled).toBe(false);
	});

	it("separates next-turn spec arming from pending approved plans", () => {
		const planning = createSpecState({ phase: "planning" });
		const approved = createSpecState({
			phase: "approved",
			plan: {
				title: "Spec",
				sections: [],
				summary: [],
				goals: [],
				constraints: [],
				acceptanceCriteria: [],
				technicalDetails: [],
				fileChanges: [],
				userJourney: [],
				errorScenarios: [],
				securityCompliance: [],
				scalePerformance: [],
				implementationPlan: [],
				verificationPlan: [],
				assumptions: [],
				markdown: "# Spec",
			},
		});

		expect(isSpecArmedForNextTurn(planning)).toBe(true);
		expect(hasPendingSpecPlan(planning)).toBe(false);
		expect(isSpecArmedForNextTurn(approved)).toBe(false);
		expect(hasPendingSpecPlan(approved)).toBe(true);
		expect(hasPendingSpecPlan(createInactiveSpecState(approved))).toBe(false);
	});

	it("normalizes persisted states that predate maskEnabled", () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendCustomEntry("hirocode.spec.state", {
			id: "spec-1",
			phase: "approved",
			updatedAt: new Date().toISOString(),
			title: "Spec",
			plan: {
				title: "Spec",
				summary: [],
				goals: [],
				constraints: [],
				acceptanceCriteria: ["done"],
				technicalDetails: [],
				fileChanges: [],
				userJourney: [],
				errorScenarios: [],
				securityCompliance: [],
				scalePerformance: [],
				implementationPlan: ["do thing"],
				verificationPlan: ["verify"],
				assumptions: [],
				markdown: "# Spec",
			},
		});

		expect(readLatestSpecState(sessionManager)?.maskEnabled).toBe(true);
		expect(readLatestSpecState(sessionManager)?.plan?.sections).toEqual([]);
	});

	it("reconstructs plan sections for persisted legacy specs", () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendCustomEntry("hirocode.spec.state", {
			id: "spec-legacy",
			phase: "approved",
			updatedAt: new Date().toISOString(),
			title: "Legacy Spec",
			plan: {
				title: "Legacy Spec",
				summary: [],
				goals: [],
				constraints: [],
				acceptanceCriteria: [],
				technicalDetails: [],
				fileChanges: ["packages/coding-agent/src/core/spec/plan.ts"],
				userJourney: [],
				errorScenarios: [],
				securityCompliance: [],
				scalePerformance: [],
				implementationPlan: ["Refactor parser"],
				verificationPlan: ["Run spec tests"],
				assumptions: [],
				markdown:
					"# Legacy Spec\n## 修改方案\n- Refactor parser\n## 涉及文件\n- packages/coding-agent/src/core/spec/plan.ts\n## 验证方案\n- Run spec tests",
			},
		});

		expect(readLatestSpecState(sessionManager)?.plan?.sections.map((section) => section.title)).toEqual([
			"修改方案",
			"涉及文件",
			"验证方案",
		]);
	});

	it("normalizes legacy hidden planning states to inactive", () => {
		const sessionManager = SessionManager.inMemory();
		const persisted = writeSpecState(sessionManager, {
			id: "spec-2",
			phase: "planning",
			maskEnabled: false,
			request: "Plan a feature",
			plan: undefined,
		});

		expect(persisted.phase).toBe("inactive");
		expect(persisted.maskEnabled).toBe(false);
		expect(isSpecArmedForNextTurn(persisted)).toBe(false);
		expect(readLatestSpecState(sessionManager)?.phase).toBe("inactive");
		expect(readLatestSpecState(sessionManager)?.maskEnabled).toBe(false);
	});

	it("normalizes legacy planning states without planning metadata", () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendCustomEntry("hirocode.spec.state", {
			id: "spec-planning-legacy",
			phase: "planning",
			updatedAt: new Date().toISOString(),
			maskEnabled: true,
			request: "Plan a feature",
		});

		expect(readLatestSpecState(sessionManager)).toMatchObject({
			phase: "planning",
			maskEnabled: true,
		});
	});
});
