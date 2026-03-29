import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { saveSpecArtifact } from "../src/core/spec/artifact.js";
import {
	buildSpecExecutionContext,
	buildSpecPlanningBlockedMessage,
	buildSpecPlanningContext,
	buildSpecPlanningContinuationContext,
	collectSpecPlanningEvidence,
	evaluateSpecPlanningGate,
	extractProposedPlanDisplayState,
	mergeSpecPlanningEvidence,
	parseSpecPlan,
	shouldAutoContinueSpecPlanning,
	stripProposedPlanBlocks,
} from "../src/core/spec/plan.js";
import { getBuiltinMessageRenderer } from "../src/modes/interactive/components/builtin-message-renderers.js";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.js";

const tempDirs: string[] = [];
const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
	},
};

afterEach(() => {
	while (tempDirs.length > 0) {
		fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
	}
});

beforeAll(() => {
	initTheme("dark");
});

describe("parseSpecPlan", () => {
	it("extracts a structured plan from a proposed_plan block", () => {
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
			sections: expect.arrayContaining([
				expect.objectContaining({ title: "Summary" }),
				expect.objectContaining({ title: "Implementation Plan" }),
			]),
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
	});

	it("requires implementation, change-scope, and verification signals", () => {
		expect(
			parseSpecPlan(`
<proposed_plan>
# Incomplete
## Goals
- Only one section
</proposed_plan>
`),
		).toBeUndefined();
	});

	it("accepts droid-style plans with dynamic headings", () => {
		const plan = parseSpecPlan(`
<proposed_plan>
# RPC Worker 修复方案
## 根因分析
- runDelegatedTaskWithRpc() 过早把 prompt 响应当成任务完成

## 修改方案
- 在 task-runner.ts 中等待 agent_end 事件后再退出

## 改动汇总表
- packages/coding-agent/src/core/subagents/task-runner.ts

## 实施顺序
1. 添加 completion promise
2. 监听 agent_end
3. 重新计算退出时机

## 各场景验证
1. Mission feature 正常运行
2. prompt 命令失败时直接返回
</proposed_plan>
`);

		expect(plan).toMatchObject({
			title: "RPC Worker 修复方案",
			technicalDetails: ["runDelegatedTaskWithRpc() 过早把 prompt 响应当成任务完成"],
			fileChanges: ["packages/coding-agent/src/core/subagents/task-runner.ts"],
			verificationPlan: ["Mission feature 正常运行", "prompt 命令失败时直接返回"],
		});
		expect(plan?.implementationPlan).toEqual([
			"在 task-runner.ts 中等待 agent_end 事件后再退出",
			"添加 completion promise",
			"监听 agent_end",
			"重新计算退出时机",
		]);
		expect(plan?.sections.map((section) => section.title)).toEqual([
			"根因分析",
			"修改方案",
			"改动汇总表",
			"实施顺序",
			"各场景验证",
		]);
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
		const prompt = buildSpecPlanningContext();
		expect(prompt).toContain("[SPECIFICATION MODE ACTIVE]");
		expect(prompt).toContain("This is a conversation, not a one-shot prompt.");
		expect(prompt).toContain(
			"Do not emit <proposed_plan> for greetings, self-introductions, or incomplete requests.",
		);
		expect(prompt).toContain("If the user asks for a factual repository inspection");
		expect(prompt).toContain("You have access to an ask tool for interactive clarification.");
		expect(prompt).toContain(
			"If the implementation is already decision-complete and the planning gate is satisfied, you may emit <proposed_plan> in the current response.",
		);
		expect(prompt).toContain("Use the ask tool at least twice in separate calls before you emit <proposed_plan>.");
		expect(prompt).toContain("Phase 1 - Explore and ask (first response):");
		expect(prompt).toContain("Inspect AGENTS.md, README, package manifests, lockfiles, and the current codebase");
		expect(prompt).toContain("If none exist, say that the repository has no dependency baseline yet");
		expect(prompt).toContain("If the task touches a new project, scaffolding, package.json, framework selection");
		expect(prompt).toContain("If dependency review is still missing, inspect package manifests or lockfiles next");
		expect(prompt).toContain("Before you emit <proposed_plan>, all of the following must already be true:");
		expect(prompt).toContain("You read AGENTS.md, CLAUDE.md, or equivalent project instructions.");
		expect(prompt).toContain(
			"You reviewed package manifests, lockfiles, or equivalent dependency declarations, or explicitly verified that the repository does not have that dependency baseline yet.",
		);
		expect(prompt).toContain(
			"For dependency-sensitive tasks, you verified official current stable versions before finalizing.",
		);
		expect(prompt).toContain(
			"Do not end with a dead-end summary like 'I cannot emit the plan yet' without also stating the missing evidence and the next read-only step.",
		);
		expect(prompt).toContain(
			"If you are not emitting <proposed_plan> yet, continue the planning conversation by either issuing another ask tool call or stating the missing evidence and the next read-only step.",
		);
		expect(prompt).toContain("Never write multiple-choice questions as plain assistant text");
		expect(prompt).toContain("Choose headings that fit the task.");
		expect(prompt).not.toContain("You have already completed at least one prior planning turn.");
		expect(prompt).not.toContain("A good compact structure is usually:");
		expect(prompt).not.toContain("## Implementation Changes");
	});

	it("collects planning evidence from repository, ask, and web investigation", () => {
		const evidence = collectSpecPlanningEvidence([
			{
				role: "assistant",
				content: [
					{ type: "toolCall", id: "1", name: "read", arguments: { path: "AGENTS.md" } },
					{ type: "toolCall", id: "2", name: "read", arguments: { path: "package.json" } },
					{
						type: "toolCall",
						id: "3",
						name: "ask",
						arguments: { questions: [{ question: "Scope?", options: [{ label: "Landing page" }] }] },
					},
					{
						type: "toolCall",
						id: "4",
						name: "ask",
						arguments: { questions: [{ question: "Version?", options: [{ label: "Latest stable" }] }] },
					},
					{
						type: "toolCall",
						id: "5",
						name: "websearch",
						arguments: { query: "react vite latest stable versions official docs" },
					},
					{
						type: "toolCall",
						id: "6",
						name: "webfetch",
						arguments: { url: "https://react.dev/" },
					},
				],
				api: "openai-responses",
				provider: "openai",
				model: "gpt-5.4",
				usage,
				stopReason: "stop",
				timestamp: Date.now(),
			},
			{
				role: "toolResult",
				toolCallId: "1",
				toolName: "read",
				content: [{ type: "text", text: "# Development Rules" }],
				isError: false,
				timestamp: Date.now(),
			},
			{
				role: "toolResult",
				toolCallId: "2",
				toolName: "read",
				content: [{ type: "text", text: '{"dependencies":{"react":"^19.2.4"}}' }],
				isError: false,
				timestamp: Date.now(),
			},
			{
				role: "toolResult",
				toolCallId: "3",
				toolName: "ask",
				content: [],
				isError: false,
				timestamp: Date.now(),
			},
			{
				role: "toolResult",
				toolCallId: "4",
				toolName: "ask",
				content: [],
				isError: false,
				timestamp: Date.now(),
			},
			{
				role: "toolResult",
				toolCallId: "5",
				toolName: "websearch",
				content: [],
				details: {
					query: "react vite latest stable versions official docs",
				},
				isError: false,
				timestamp: Date.now(),
			},
			{
				role: "toolResult",
				toolCallId: "6",
				toolName: "webfetch",
				content: [],
				details: {
					url: "https://react.dev/",
					title: "React latest stable release",
				},
				isError: false,
				timestamp: Date.now(),
			},
		]);

		expect(evidence).toEqual({
			hasGrounding: true,
			hasAsk: true,
			hasAgentsGuidance: true,
			hasDependencyReview: true,
			askCount: 2,
			hasWebSearch: true,
			hasWebFetch: true,
			hasVersionResearch: true,
		});
	});

	it("treats explicit negative manifest inspection as completed dependency review in an empty repository", () => {
		const evidence = collectSpecPlanningEvidence([
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "dep-1", name: "find", arguments: { pattern: "**/package.json" } }],
				api: "openai-responses",
				provider: "openai",
				model: "gpt-5.4",
				usage,
				stopReason: "stop",
				timestamp: Date.now(),
			},
			{
				role: "toolResult",
				toolCallId: "dep-1",
				toolName: "find",
				content: [
					{
						type: "text",
						text: "No files found matching pattern. Repository is empty and has no dependency baseline yet.",
					},
				],
				isError: false,
				timestamp: Date.now(),
			},
		]);

		expect(evidence.hasDependencyReview).toBe(true);
	});

	it("merges planning evidence across turns without enforcing order", () => {
		const merged = mergeSpecPlanningEvidence(
			{
				hasGrounding: true,
				hasAsk: true,
				hasAgentsGuidance: true,
				hasDependencyReview: false,
				askCount: 1,
				hasWebSearch: false,
				hasWebFetch: true,
				hasVersionResearch: false,
			},
			{
				hasGrounding: false,
				hasAsk: true,
				hasAgentsGuidance: false,
				hasDependencyReview: true,
				askCount: 1,
				hasWebSearch: true,
				hasWebFetch: false,
				hasVersionResearch: true,
			},
		);

		expect(merged).toEqual({
			hasGrounding: true,
			hasAsk: true,
			hasAgentsGuidance: true,
			hasDependencyReview: true,
			askCount: 2,
			hasWebSearch: true,
			hasWebFetch: true,
			hasVersionResearch: true,
		});
	});

	it("allows first-turn finalization once all strict planning evidence is satisfied", () => {
		expect(
			evaluateSpecPlanningGate({
				priorPlanningTurns: 0,
				evidence: {
					hasGrounding: true,
					hasAsk: true,
					hasAgentsGuidance: true,
					hasDependencyReview: true,
					askCount: 2,
					hasWebSearch: true,
					hasWebFetch: true,
					hasVersionResearch: true,
				},
				requestText: "Scaffold a React + Vite landing page with package.json",
				planMarkdown:
					"# Plan\n## File Changes\n- package.json\n## Implementation Plan\n1. Add Vite\n## Verification Plan\n1. Run npm run check",
			}),
		).toEqual({
			ready: true,
			missing: [],
		});
	});

	it("blocks when AGENTS guidance, dependency review, and multiple ask calls are missing", () => {
		expect(
			evaluateSpecPlanningGate({
				priorPlanningTurns: 1,
				evidence: {
					hasGrounding: true,
					hasAsk: true,
					hasAgentsGuidance: false,
					hasDependencyReview: false,
					askCount: 1,
					hasWebSearch: true,
					hasWebFetch: true,
					hasVersionResearch: false,
				},
				requestText: "Plan a refactor for the existing repository",
				planMarkdown:
					"# Plan\n## Implementation Plan\n1. Refactor modules\n## Verification Plan\n1. Run npm run check",
			}),
		).toEqual({
			ready: false,
			missing: [
				"read AGENTS.md, CLAUDE.md, or equivalent project instructions",
				"review package manifests, lockfiles, or equivalent dependency declarations",
				"use the ask tool in at least two separate calls to clarify scope, constraints, and version choices",
			],
		});
	});

	it("requires official version research for dependency-sensitive tasks", () => {
		expect(
			evaluateSpecPlanningGate({
				priorPlanningTurns: 1,
				evidence: {
					hasGrounding: true,
					hasAsk: true,
					hasAgentsGuidance: true,
					hasDependencyReview: true,
					askCount: 2,
					hasWebSearch: true,
					hasWebFetch: true,
					hasVersionResearch: false,
				},
				requestText: "Create a new React + Vite project from scratch",
				planMarkdown:
					"# Plan\n## File Changes\n- package.json\n## Implementation Plan\n1. Scaffold the app\n## Verification Plan\n1. Run npm run check",
			}),
		).toEqual({
			ready: false,
			missing: ["research official current stable dependency or framework versions relevant to this task"],
		});
	});

	it("allows finalization once all strict planning evidence is satisfied", () => {
		expect(
			evaluateSpecPlanningGate({
				priorPlanningTurns: 0,
				evidence: {
					hasGrounding: true,
					hasAsk: true,
					hasAgentsGuidance: true,
					hasDependencyReview: true,
					askCount: 2,
					hasWebSearch: true,
					hasWebFetch: true,
					hasVersionResearch: true,
				},
				requestText: "Create a new React + Vite project from scratch",
				planMarkdown:
					"# Plan\n## File Changes\n- package.json\n## Implementation Plan\n1. Scaffold the app\n## Verification Plan\n1. Run npm run check",
			}),
		).toEqual({
			ready: true,
			missing: [],
		});
	});

	it("only auto-continues when every missing prerequisite is discoverable", () => {
		expect(
			shouldAutoContinueSpecPlanning([
				"review package manifests, lockfiles, or equivalent dependency declarations",
				"research official current stable dependency or framework versions relevant to this task",
			]),
		).toBe(true);
		expect(
			shouldAutoContinueSpecPlanning([
				"review package manifests, lockfiles, or equivalent dependency declarations",
				"use the ask tool in at least two separate calls to clarify scope, constraints, and version choices",
			]),
		).toBe(false);
	});

	it("formats blocked planning feedback with missing prerequisites and concrete next steps", () => {
		const markdown = buildSpecPlanningBlockedMessage([
			"read AGENTS.md, CLAUDE.md, or equivalent project instructions",
			"use the ask tool in at least two separate calls to clarify scope, constraints, and version choices",
			"research official current stable dependency or framework versions relevant to this task",
		]);

		expect(markdown).toContain("# Specification Still In Progress");
		expect(markdown).toContain("## Missing Prerequisites");
		expect(markdown).toContain("## Next Step");
		expect(markdown).toContain("Read AGENTS.md, CLAUDE.md, or equivalent project instructions");
		expect(markdown).toContain(
			"Use the ask tool again to resolve the remaining scope, constraint, or version decisions.",
		);
		expect(markdown).toContain(
			"Verify the official current stable framework or dependency versions, then confirm any non-default version choice with the user.",
		);
	});

	it("builds a hidden continuation prompt for discoverable missing evidence", () => {
		const prompt = buildSpecPlanningContinuationContext([
			"review package manifests, lockfiles, or equivalent dependency declarations",
		]);

		expect(prompt).toContain("[SPEC PLANNING CONTINUATION]");
		expect(prompt).toContain('Do not wait for the user to type "continue"');
		expect(prompt).toContain("If dependency review is missing, inspect package manifests and lockfiles now.");
		expect(prompt).toContain("For an empty or greenfield repository");
	});

	it("parses codex-style compact sections into the richer schema", () => {
		const plan = parseSpecPlan(`
<proposed_plan>
# Mission Control Timeline
Brief summary line for the whole plan.

## Acceptance Criteria
- Operators can see active workers and merge status in Mission Control

## Key Changes
- Add mission timeline rendering in the interactive TUI
- Persist worker timestamps and merge summaries in mission state

## Test Plan
1. Add mission control component tests
2. Run coding-agent checks

## Assumptions
- Existing mission widgets remain supported

## Security and Compliance
- Do not auto-merge patches when the workspace is dirty
</proposed_plan>
`);

		expect(plan).toMatchObject({
			title: "Mission Control Timeline",
			summary: ["Brief summary line for the whole plan."],
			acceptanceCriteria: ["Operators can see active workers and merge status in Mission Control"],
			implementationPlan: [
				"Add mission timeline rendering in the interactive TUI",
				"Persist worker timestamps and merge summaries in mission state",
			],
			verificationPlan: ["Add mission control component tests", "Run coding-agent checks"],
			assumptions: ["Existing mission widgets remain supported"],
			securityCompliance: ["Do not auto-merge patches when the workspace is dirty"],
		});
	});

	it("builds execution context from an approved plan", () => {
		const plan = parseSpecPlan(`
<proposed_plan>
# Export Personal Data
## Goals
- Let users export their personal data
## Constraints
- Must remain read-only during planning
## Acceptance Criteria
- Users can request a ZIP export
## Implementation Plan
1. Add export job orchestration
## Verification Plan
1. Add backend tests
</proposed_plan>
`)!;
		const prompt = buildSpecExecutionContext(plan, ".hirocode/docs/export-personal-data.md");
		expect(prompt).toContain("[EXECUTING APPROVED SPEC]");
		expect(prompt).toContain("Approved spec artifact: .hirocode/docs/export-personal-data.md");
		expect(prompt).toContain("## Implementation Plan");
	});

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

	it("renders blocked spec feedback with the planning document chrome", () => {
		const renderer = getBuiltinMessageRenderer("spec-plan-blocked");
		expect(renderer).toBeTypeOf("function");

		const component = renderer!(
			{
				role: "custom",
				customType: "spec-plan-blocked",
				content: buildSpecPlanningBlockedMessage([
					"review package manifests, lockfiles, or equivalent dependency declarations",
				]),
				display: true,
				timestamp: Date.now(),
			},
			{ expanded: false },
			theme,
		);
		const rendered = stripAnsi(component!.render(100).join("\n"));

		expect(rendered).toContain("Specification needs more planning");
		expect(rendered).toContain("Missing Prerequisites");
		expect(rendered).toContain("review package manifests, lockfiles, or equivalent dependency declarations");
	});
});

describe("saveSpecArtifact", () => {
	it("writes approved plans into .hirocode/docs", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "hirocode-spec-artifact-"));
		tempDirs.push(root);
		const plan = parseSpecPlan(`
<proposed_plan>
# Export Personal Data
## Goals
- Let users export their personal data
## Constraints
- Must remain read-only during planning
## Acceptance Criteria
- Users can request a ZIP export
## Implementation Plan
1. Add export job orchestration
## Verification Plan
1. Add backend tests
</proposed_plan>
`)!;

		const savedPath = await saveSpecArtifact(root, plan);
		expect(savedPath).toContain(path.join(".hirocode", "docs"));
		expect(fs.readFileSync(savedPath, "utf-8")).toContain("# Export Personal Data");
	});
});
