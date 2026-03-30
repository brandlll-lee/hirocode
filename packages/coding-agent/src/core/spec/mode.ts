import { parseSpecPlan } from "./plan.js";
import type { SpecPlanSections } from "./types.js";

export const SPEC_PLANNING_TOOL_NAMES = Object.freeze([
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

export const SPEC_PLANNING_SUBAGENT_NAMES = Object.freeze(["planner", "explore", "reviewer"]);

export const SPEC_PLANNING_RECOVERY_HINT =
	"Continue exploring, use the ask tool for material decisions, or emit an approvable <proposed_plan> block.";

export type SpecPlanningTurnOutcome =
	| {
			kind: "valid-plan";
			plan: SpecPlanSections;
	  }
	| {
			kind: "question";
	  }
	| {
			kind: "continue-planning";
			statusMessage: string;
	  }
	| {
			kind: "contract-violation";
			statusMessage: string;
	  };

const SPEC_PLAN_TEMPLATE = [
	"<proposed_plan>",
	"# <Short title>",
	"## Summary",
	"- <brief summary>",
	"## Key Changes",
	"- <grouped implementation change>",
	"## Change Surface",
	"- <affected file or subsystem>",
	"## Test Plan",
	"1. <verification step>",
	"## Assumptions",
	"- <optional assumption>",
	"</proposed_plan>",
].join("\n");

const QUESTION_PATTERN =
	/(?:\?\s*$|？\s*$|^(?:which|what|should|can|could|would|do you|does the user|is the user)\b)/iu;
const EXECUTION_INTENT_PATTERN =
	/(?:start(?:ing)? implementation|begin(?:ning)? implementation|create (?:the )?files|write the files|implement the plan|i(?:'| wi)ll implement)/iu;

export function getSpecPlanningToolNames(): string[] {
	return [...SPEC_PLANNING_TOOL_NAMES];
}

export function getSpecPlanningSubagentNames(): string[] {
	return [...SPEC_PLANNING_SUBAGENT_NAMES];
}

export function buildSpecPlanningTurnContext(): string {
	return [
		"[SPECIFICATION MODE ACTIVE]",
		"You are planning only. Treat this as a read-only design turn, not an implementation turn.",
		"",
		"## Rules",
		"- Explore the repository before asking the user about anything you can discover yourself.",
		"- Stay read-only until the user approves a complete plan.",
		"- You may inspect code, search the repository, use read-only shell commands, and delegate only to the read-only planner/explore/reviewer agents.",
		"- Do not edit files, write files, apply patches, or run mutating shell commands.",
		"- Do not claim that you are starting implementation, creating files, or switching out of specification mode.",
		"- Use the ask tool for material ambiguities and tradeoffs. Do not ask multiple-choice planning questions as plain assistant text.",
		"",
		"## Output contract",
		"- If the design is not ready, end with one focused question.",
		"- If the user explicitly asked for factual repository inspection, you may answer with findings and stay in planning mode.",
		"- If the design is ready, emit exactly one <proposed_plan> block in markdown using this structure:",
		SPEC_PLAN_TEMPLATE,
		"- Do not end with a dead-end summary that neither asks a question nor emits an approvable <proposed_plan> block.",
	].join("\n");
}

export function buildSpecExecutionTurnContext(plan: SpecPlanSections, artifactPath: string | undefined): string {
	const artifactLine = artifactPath
		? `Approved spec artifact: ${artifactPath}`
		: "Approved spec artifact: not saved yet";
	return [
		"[EXECUTING APPROVED SPEC]",
		"Implement only the approved specification. Do not re-plan unless the user explicitly asks to return to planning.",
		"Run verification and cite concrete results before claiming completion.",
		artifactLine,
		"",
		plan.markdown,
	].join("\n");
}

export function buildSpecPlannerPrompt(): string {
	return [
		"You are a read-only planner agent specialized in specification work.",
		"",
		"Inspect the codebase, synthesize findings, and delegate only to read-only helper agents when necessary.",
		"Never edit files, write files, or run mutating commands.",
		"",
		"Return exactly one <proposed_plan> block in markdown using this structure:",
		SPEC_PLAN_TEMPLATE,
		"",
		"Do not add prose before or after the block.",
	].join("\n");
}

export function isApprovableSpecPlan(plan: SpecPlanSections | undefined): plan is SpecPlanSections {
	if (!plan) {
		return false;
	}

	return (
		plan.summary.length > 0 &&
		plan.fileChanges.length > 0 &&
		plan.implementationPlan.length > 0 &&
		plan.verificationPlan.length > 0
	);
}

export function getSpecPlanningTurnOutcome(messageText: string): SpecPlanningTurnOutcome {
	const plan = parseSpecPlan(messageText);
	if (isApprovableSpecPlan(plan)) {
		return { kind: "valid-plan", plan };
	}

	if (plan) {
		return {
			kind: "continue-planning",
			statusMessage: `Specification draft is missing ${describeMissingPlanSections(plan)}. ${SPEC_PLANNING_RECOVERY_HINT}`,
		};
	}

	const trimmed = messageText.trim();
	if (!trimmed) {
		return {
			kind: "continue-planning",
			statusMessage: `Specification planning is still in progress. ${SPEC_PLANNING_RECOVERY_HINT}`,
		};
	}

	if (QUESTION_PATTERN.test(trimmed)) {
		return { kind: "question" };
	}

	if (EXECUTION_INTENT_PATTERN.test(trimmed)) {
		return {
			kind: "contract-violation",
			statusMessage: `Specification mode blocked an execution-oriented response. ${SPEC_PLANNING_RECOVERY_HINT}`,
		};
	}

	return {
		kind: "continue-planning",
		statusMessage: `Specification planning is still in progress. ${SPEC_PLANNING_RECOVERY_HINT}`,
	};
}

function describeMissingPlanSections(plan: SpecPlanSections): string {
	const missing: string[] = [];
	if (plan.summary.length === 0) {
		missing.push("a Summary section");
	}
	if (plan.fileChanges.length === 0) {
		missing.push("a Change Surface section");
	}
	if (plan.implementationPlan.length === 0) {
		missing.push("a Key Changes section");
	}
	if (plan.verificationPlan.length === 0) {
		missing.push("a Test Plan section");
	}

	if (missing.length === 0) {
		return "required planning details";
	}
	if (missing.length === 1) {
		return missing[0];
	}

	return `${missing.slice(0, -1).join(", ")} and ${missing[missing.length - 1]}`;
}
