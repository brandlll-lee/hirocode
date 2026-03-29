import { describe, expect, it } from "vitest";
import { estimateMissionBudget } from "../src/core/missions/estimator.js";
import {
	buildMissionPlanningContext,
	extractMissionPlanDisplayState,
	looksLikeMissionPlanReadySignal,
	parseMissionPlan,
	stripMissionPlanBlocks,
} from "../src/core/missions/planner.js";
import { buildMissionSchedule } from "../src/core/missions/scheduler.js";

const missionPlanMessage = `
<mission_plan>
{
  "title": "Todo App Mission",
  "summary": "Build a todo app with auth and deployment.",
  "features": [
    {
      "id": "auth",
      "title": "Auth",
      "description": "Add authentication flows.",
      "milestoneId": "foundation",
      "dependsOn": [],
      "workspacePaths": ["src/auth"],
      "agent": "general",
      "validationCommands": ["npm run check"],
      "successCriteria": ["Users can sign in"]
    },
    {
      "id": "todo-ui",
      "title": "Todo UI",
      "description": "Build the todo interface.",
      "milestoneId": "product",
      "dependsOn": ["auth"],
      "workspacePaths": ["src/ui/todo"],
      "agent": "general",
      "validationCommands": ["npm run check"],
      "successCriteria": ["Users can manage todos"]
    },
    {
      "id": "deploy",
      "title": "Deploy",
      "description": "Prepare deployment.",
      "milestoneId": "product",
      "dependsOn": ["auth"],
      "workspacePaths": ["infra/deploy"],
      "agent": "general",
      "validationCommands": ["npm run check"],
      "successCriteria": ["Deployment instructions are complete"]
    }
  ],
  "milestones": [
    {
      "id": "foundation",
      "title": "Foundation",
      "description": "Create the core auth base.",
      "featureIds": ["auth"],
      "successCriteria": ["Auth works"],
      "validationCommands": ["npm run check"]
    },
    {
      "id": "product",
      "title": "Product",
      "description": "Finish the app and deployment.",
      "featureIds": ["todo-ui", "deploy"],
      "successCriteria": ["Todo flows work", "Deployment is documented"],
      "validationCommands": ["npm run check"]
    }
  ],
  "successCriteria": ["The app is functional"],
  "validationPlan": ["Run npm run check"],
  "modelStrategy": {
    "planningModel": { "modelArg": "openai/gpt-5.4", "provider": "openai", "modelId": "gpt-5.4", "thinkingLevel": "high" },
    "executionModel": { "modelArg": "openai/gpt-5.4" },
    "reviewModel": { "modelArg": "anthropic/claude-opus-4-6" }
  }
}
</mission_plan>
`;

describe("mission planner", () => {
	it("builds a mission planning context", () => {
		const context = buildMissionPlanningContext();
		expect(context).toContain("[MISSION PLANNING MODE ACTIVE]");
		expect(context).toContain("<mission_plan>");
		expect(context).toContain("workspacePaths");
	});

	it("includes available skills in the planning context", () => {
		const skills = [
			{ name: "review", description: "Review code changes and identify bugs" },
			{ name: "agent-browser", description: "Automate browsers for testing" },
		];
		const context = buildMissionPlanningContext(skills);
		expect(context).toContain("Available skills that workers can leverage");
		expect(context).toContain("- review: Review code changes and identify bugs");
		expect(context).toContain("- agent-browser: Automate browsers for testing");
	});

	it("builds a planning context without skills when none provided", () => {
		const context = buildMissionPlanningContext([]);
		expect(context).not.toContain("Available skills");
		expect(context).toContain("[MISSION PLANNING MODE ACTIVE]");
	});

	it("parses a structured mission plan", () => {
		const plan = parseMissionPlan("Build a full-stack todo app with auth", missionPlanMessage);
		expect(plan).toBeDefined();
		expect(plan?.title).toBe("Todo App Mission");
		expect(plan?.features).toHaveLength(3);
		expect(plan?.milestones).toHaveLength(2);
		expect(plan?.budgetEstimate.floorRuns).toBe(7);
		expect(plan?.markdown).toContain("## Features");
	});

	it("creates phase-wave schedules with safe parallelization", () => {
		const plan = parseMissionPlan("Build a full-stack todo app with auth", missionPlanMessage)!;
		const schedule = buildMissionSchedule(plan, 2);
		expect(schedule.maxParallel).toBe(2);
		expect(schedule.milestones[0]?.waves).toHaveLength(1);
		expect(schedule.milestones[0]?.waves[0]?.featureIds).toEqual(["auth"]);
		expect(schedule.milestones[1]?.waves[0]?.featureIds).toHaveLength(2);
		expect(schedule.milestones[1]?.waves[0]?.featureIds).toEqual(expect.arrayContaining(["todo-ui", "deploy"]));
	});

	it("estimates mission budgets using the Droid heuristic floor", () => {
		const estimate = estimateMissionBudget({
			features: [{ id: "a" }, { id: "b" }, { id: "c" }] as never,
			milestones: [{ id: "m1" }, { id: "m2" }] as never,
		});
		expect(estimate.floorRuns).toBe(7);
		expect(estimate.estimatedRuns).toBeGreaterThanOrEqual(estimate.floorRuns);
	});

	it("planning context mandates collaboration before emitting the plan", () => {
		const context = buildMissionPlanningContext();
		expect(context).toContain("Do NOT emit a <mission_plan> block in your first response");
		expect(context).toContain("Phase 1");
		expect(context).toContain("Phase 2");
		expect(context).toContain("Phase 3");
		expect(context).toContain("After reviewing ask answers");
		expect(context).toContain("explicitly ask whether the user wants you to generate the mission plan now");
		expect(context).toContain("Do not end with a dead-end summary");
		expect(context).toContain("never end a planning response with only a restatement");
		expect(context).toContain("Never mention the literal tag <mission_plan> in normal conversational text");
		expect(context).toContain("Once the user confirms readiness, do not ask for confirmation again.");
	});

	it("treats Chinese confirmation phrases as ready signals", () => {
		expect(looksLikeMissionPlanReadySignal("确认！")).toBe(true);
		expect(looksLikeMissionPlanReadySignal("可以，按这个来")).toBe(true);
		expect(looksLikeMissionPlanReadySignal("继续")).toBe(true);
		expect(looksLikeMissionPlanReadySignal("我还在想")).toBe(false);
	});

	it("builds a forced plan context after explicit confirmation", () => {
		const context = buildMissionPlanningContext([], { userConfirmedReady: true });
		expect(context).toContain("[USER CONFIRMED READY TO GENERATE THE PLAN]");
		expect(context).toContain("output exactly one <mission_plan> block and no conversational text");
	});

	it("stripMissionPlanBlocks removes the plan tag and content from display text", () => {
		const raw = 'Here is my analysis.\n<mission_plan>\n{"title":"Test"}\n</mission_plan>\nAny questions?';
		const stripped = stripMissionPlanBlocks(raw);
		expect(stripped).not.toContain("<mission_plan>");
		expect(stripped).not.toContain("title");
		expect(stripped).toContain("Here is my analysis.");
		expect(stripped).toContain("Any questions?");
	});

	it("extractMissionPlanDisplayState hides plan content while streaming", () => {
		const streaming = 'Thinking...\n<mission_plan>\n{"title":"Partial';
		const state = extractMissionPlanDisplayState(streaming);
		expect(state.visibleText.trim()).toBe("Thinking...");
		expect(state.planText).toContain("Partial");
		expect(state.complete).toBe(false);
	});

	it("extractMissionPlanDisplayState returns full visible text after closing tag", () => {
		const full = 'Before.\n<mission_plan>\n{"title":"Done"}\n</mission_plan>\nAfter.';
		const state = extractMissionPlanDisplayState(full);
		expect(state.visibleText).toContain("Before.");
		expect(state.visibleText).toContain("After.");
		expect(state.complete).toBe(true);
		expect(state.planText).toContain("Done");
	});

	it("does not treat inline tag mentions as a real mission plan block", () => {
		const inline = "If you confirm, I can output the formal `<mission_plan>` JSON next.";
		const state = extractMissionPlanDisplayState(inline);
		expect(state.visibleText).toBe(inline);
		expect(state.planText).toBeUndefined();
		expect(state.complete).toBe(false);
	});
});
