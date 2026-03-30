import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { saveSpecArtifact } from "../src/core/spec/artifact.js";
import {
	buildSpecExecutionTurnContext,
	buildSpecPlannerPrompt,
	buildSpecPlanningTurnContext,
	getSpecPlanningTurnOutcome,
	isApprovableSpecPlan,
} from "../src/core/spec/mode.js";
import { extractProposedPlanDisplayState, parseSpecPlan, stripProposedPlanBlocks } from "../src/core/spec/plan.js";
import { getBuiltinMessageRenderer } from "../src/modes/interactive/components/builtin-message-renderers.js";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.js";

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length > 0) {
		fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
	}
});

beforeAll(() => {
	initTheme("dark");
});

describe("parseSpecPlan", () => {
	it("extracts a structured legacy plan from a proposed_plan block", () => {
		const plan = parseSpecPlan(`
<proposed_plan>
# Export Personal Data
## Summary
- Build a user-facing export workflow for GDPR requests
## Goals
- Let users export their personal data
## Constraints
- Must remain read-only during planning
## Acceptance Criteria
- Users can request a ZIP export
## Technical Details
- Reuse the background job framework for long-running exports
## File Changes
- Update the export API module and the settings page
## Implementation Plan
1. Add export job orchestration
2. Add download UI
## Verification Plan
1. Add backend tests
2. Run the UI flow manually
## Assumptions
- Export files are stored in object storage
</proposed_plan>
`);

		expect(plan).toMatchObject({
			title: "Export Personal Data",
			summary: ["Build a user-facing export workflow for GDPR requests"],
			goals: ["Let users export their personal data"],
			constraints: ["Must remain read-only during planning"],
			acceptanceCriteria: ["Users can request a ZIP export"],
			technicalDetails: ["Reuse the background job framework for long-running exports"],
			fileChanges: ["Update the export API module and the settings page"],
			implementationPlan: ["Add export job orchestration", "Add download UI"],
			verificationPlan: ["Add backend tests", "Run the UI flow manually"],
			assumptions: ["Export files are stored in object storage"],
		});
		expect(isApprovableSpecPlan(plan)).toBe(true);
	});

	it("accepts compact codex-style plans and maps them into the richer schema", () => {
		const plan = parseSpecPlan(`
<proposed_plan>
# Mission Control Timeline
Brief summary line for the whole plan.

## Key Changes
- Add mission timeline rendering in the interactive TUI
- Persist worker timestamps and merge summaries in mission state

## Change Surface
- packages/coding-agent/src/modes/interactive/interactive-mode.ts
- packages/coding-agent/src/core/missions/store.ts

## Test Plan
1. Add mission control component tests
2. Run coding-agent checks

## Assumptions
- Existing mission widgets remain supported
</proposed_plan>
`);

		expect(plan).toMatchObject({
			title: "Mission Control Timeline",
			summary: ["Brief summary line for the whole plan."],
			fileChanges: [
				"packages/coding-agent/src/modes/interactive/interactive-mode.ts",
				"packages/coding-agent/src/core/missions/store.ts",
			],
			implementationPlan: [
				"Add mission timeline rendering in the interactive TUI",
				"Persist worker timestamps and merge summaries in mission state",
			],
			verificationPlan: ["Add mission control component tests", "Run coding-agent checks"],
			assumptions: ["Existing mission widgets remain supported"],
		});
		expect(isApprovableSpecPlan(plan)).toBe(true);
	});

	it("accepts dynamic headings that map into the richer schema", () => {
		const plan = parseSpecPlan(`
<proposed_plan>
# RPC Worker Fix Plan
## Root Cause Analysis
- runDelegatedTaskWithRpc() treats the prompt response as task completion too early

## Change Plan
- Wait for the agent_end event in task-runner.ts before returning

## Change Surface
- packages/coding-agent/src/core/subagents/task-runner.ts

## Rollout
1. Add a completion promise
2. Listen for agent_end
3. Recompute the exit timing

## Verification Steps
1. Mission feature keeps running
2. Prompt command failure returns immediately
</proposed_plan>
`);

		expect(plan).toMatchObject({
			title: "RPC Worker Fix Plan",
			technicalDetails: ["runDelegatedTaskWithRpc() treats the prompt response as task completion too early"],
			fileChanges: ["packages/coding-agent/src/core/subagents/task-runner.ts"],
			implementationPlan: [
				"Wait for the agent_end event in task-runner.ts before returning",
				"Add a completion promise",
				"Listen for agent_end",
				"Recompute the exit timing",
			],
			verificationPlan: ["Mission feature keeps running", "Prompt command failure returns immediately"],
		});
		expect(isApprovableSpecPlan(plan)).toBe(false);
	});

	it("keeps incomplete plans parseable but not approvable", () => {
		const plan = parseSpecPlan(`
<proposed_plan>
# Incomplete
## Goals
- Only one section
</proposed_plan>
`);

		expect(plan).toMatchObject({
			title: "Incomplete",
			goals: ["Only one section"],
		});
		expect(isApprovableSpecPlan(plan)).toBe(false);
	});

	it("strips proposed_plan markup from visible assistant text", () => {
		expect(
			stripProposedPlanBlocks(
				`Before\n<proposed_plan>\n# Title\n## Goals\n- One\n## Constraints\n- Two\n## Acceptance Criteria\n- Three\n## Implementation Plan\n1. Four\n## Verification Plan\n1. Five\n</proposed_plan>\nAfter`,
			),
		).toBe("Before\nAfter");
	});

	it("extracts plan content while hiding partial opening and closing tags", () => {
		expect(extractProposedPlanDisplayState("Before\n<propos")).toEqual({
			visibleText: "Before\n",
			planText: undefined,
			complete: false,
		});

		expect(
			extractProposedPlanDisplayState("Before\n<proposed_plan>\n## Goals\n- One\n## Constraints\n- Two\n</prop"),
		).toEqual({
			visibleText: "Before\n",
			planText: "## Goals\n- One\n## Constraints\n- Two",
			complete: false,
		});
	});

	it("splits visible assistant text from a completed proposed_plan block", () => {
		expect(
			extractProposedPlanDisplayState("Intro\n<proposed_plan>\n# Title\n## Goals\n- One\n</proposed_plan>\nOutro"),
		).toEqual({
			visibleText: "Intro\n\nOutro",
			planText: "# Title\n## Goals\n- One",
			complete: true,
		});
	});
});

describe("spec prompt helpers", () => {
	it("builds planning instructions with the expected structure", () => {
		const prompt = buildSpecPlanningTurnContext();
		expect(prompt).toContain("[SPECIFICATION MODE ACTIVE]");
		expect(prompt).toContain("You are planning only.");
		expect(prompt).toContain("Use the ask tool for material ambiguities");
		expect(prompt).toContain("## Change Surface");
		expect(prompt).toContain("Do not end with a dead-end summary");
	});

	it("builds the planner subagent prompt from the shared spec contract", () => {
		const prompt = buildSpecPlannerPrompt();
		expect(prompt).toContain("You are a read-only planner agent");
		expect(prompt).toContain("Return exactly one <proposed_plan> block");
		expect(prompt).toContain("Do not add prose before or after the block.");
	});

	it("builds execution context from an approved plan", () => {
		const plan = parseSpecPlan(`
<proposed_plan>
# Export Personal Data
## Summary
- Build a user-facing export workflow
## Change Surface
- packages/coding-agent/src/core/spec/plan.ts
## Key Changes
- Add export job orchestration
## Test Plan
1. Add backend tests
</proposed_plan>
`)!;
		const prompt = buildSpecExecutionTurnContext(plan, ".hirocode/docs/export-personal-data.md");
		expect(prompt).toContain("[EXECUTING APPROVED SPEC]");
		expect(prompt).toContain("Approved spec artifact: .hirocode/docs/export-personal-data.md");
		expect(prompt).toContain("## Test Plan");
	});

	it("classifies execution-oriented prose as a contract violation", () => {
		expect(getSpecPlanningTurnOutcome("I will start implementation now and create the files.")).toMatchObject({
			kind: "contract-violation",
		});
	});
});

describe("spec plan rendering", () => {
	it("renders spec plans with the approval document chrome", () => {
		const renderer = getBuiltinMessageRenderer("spec-plan");
		expect(renderer).toBeTypeOf("function");

		const component = renderer!(
			{
				role: "custom",
				customType: "spec-plan",
				content: "# Export Personal Data\n\n## Summary\n- Build an export workflow",
				display: true,
				timestamp: Date.now(),
			},
			{ expanded: false },
			theme,
		);
		const renderedWithAnsi = component!.render(100).join("\n");
		const rendered = stripAnsi(renderedWithAnsi);

		expect(rendered).toContain("Specification for approval");
		expect(rendered).toContain("Export Personal Data");
		expect(rendered).not.toContain("[spec-plan]");
		expect(renderedWithAnsi).toContain(theme.fg("customMessageLabel", theme.bold("Specification for approval")));
	});
});

describe("saveSpecArtifact", () => {
	it("writes approved plans into .hirocode/docs", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "hirocode-spec-artifact-"));
		tempDirs.push(root);
		const plan = parseSpecPlan(`
<proposed_plan>
# Export Personal Data
## Summary
- Build a user-facing export workflow
## Change Surface
- packages/coding-agent/src/core/spec/plan.ts
## Key Changes
- Add export job orchestration
## Test Plan
1. Add backend tests
</proposed_plan>
`)!;

		const savedPath = await saveSpecArtifact(root, plan);
		expect(savedPath).toContain(path.join(".hirocode", "docs"));
		expect(fs.readFileSync(savedPath, "utf-8")).toContain("# Export Personal Data");
	});
});
