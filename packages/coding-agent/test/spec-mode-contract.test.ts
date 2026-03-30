import { describe, expect, it } from "vitest";
import {
	buildSpecExecutionTurnContext,
	buildSpecPlanningTurnContext,
	getSpecPlanningSubagentNames,
	getSpecPlanningToolNames,
	getSpecPlanningTurnOutcome,
	isApprovableSpecPlan,
	SPEC_PLANNING_RECOVERY_HINT,
} from "../src/core/spec/mode.js";
import { parseSpecPlan } from "../src/core/spec/plan.js";

describe("spec mode contract", () => {
	it("exposes the canonical planning tools and read-only helper agents", () => {
		expect(getSpecPlanningToolNames()).toEqual([
			"read",
			"bash",
			"grep",
			"find",
			"ls",
			"webfetch",
			"websearch",
			"task",
			"ask",
		]);
		expect(getSpecPlanningSubagentNames()).toEqual(["planner", "explore", "reviewer"]);
	});

	it("marks a fully structured proposed_plan block as approvable", () => {
		const plan = parseSpecPlan(`
<proposed_plan>
# Spec Contract
## Summary
- Tighten the planning contract before implementation starts
## Change Surface
- packages/coding-agent/src/core/spec/mode.ts
## Key Changes
- Move planning instructions into a dedicated contract module
## Test Plan
1. Add contract regression coverage
</proposed_plan>
`);

		expect(isApprovableSpecPlan(plan)).toBe(true);
		expect(getSpecPlanningTurnOutcome(plan!.markdown)).toMatchObject({
			kind: "valid-plan",
		});
	});

	it("keeps incomplete draft plans in planning instead of approving them", () => {
		const outcome = getSpecPlanningTurnOutcome(`
<proposed_plan>
# Draft Only
## Summary
- A short draft without enough structure
## Key Changes
- Add something later
</proposed_plan>
`);

		expect(outcome).toMatchObject({
			kind: "continue-planning",
			statusMessage: expect.stringContaining("Change Surface"),
		});
	});

	it("treats focused plain-text questions as planning continuations", () => {
		expect(getSpecPlanningTurnOutcome("Which shell should we target for the first implementation pass?")).toEqual({
			kind: "question",
		});
	});

	it("flags implementation-first prose as a contract violation", () => {
		const outcome = getSpecPlanningTurnOutcome("I will start implementation now and create the files.");

		expect(outcome).toMatchObject({
			kind: "contract-violation",
			statusMessage: expect.stringContaining(SPEC_PLANNING_RECOVERY_HINT),
		});
	});

	it("builds planning and execution contexts from the shared contract", () => {
		const plan = parseSpecPlan(`
<proposed_plan>
# Execute Approved Spec
## Summary
- Reuse the approved plan as execution context
## Change Surface
- packages/coding-agent/src/modes/interactive/interactive-mode.ts
## Key Changes
- Inject a hidden execution context message per turn
## Test Plan
1. Verify execution turns keep the approved spec in scope
</proposed_plan>
`)!;

		expect(buildSpecPlanningTurnContext()).toContain("Do not claim that you are starting implementation");
		expect(buildSpecExecutionTurnContext(plan, ".hirocode/docs/execute-approved-spec.md")).toContain(
			"Approved spec artifact: .hirocode/docs/execute-approved-spec.md",
		);
	});
});
