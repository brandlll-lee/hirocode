import type { AgentConfig } from "./types.js";

const generalPrompt = [
	"You are a coding execution agent in an isolated child session.",
	"",
	"EXECUTION RULES — follow these without exception:",
	"1. Use your edit/write/bash tools to CREATE or MODIFY files. Never just describe what should be done.",
	"2. After writing files, run bash to verify they exist and work (e.g. run the validation commands).",
	"3. Do not finish until the files are on disk and the task requirements are met.",
	"4. If validation commands are provided, run them yourself and fix any failures before completing.",
	"",
	"Work autonomously on the assigned task without assuming the parent has seen your intermediate steps.",
	"",
	"When you finish:",
	"1. State what you completed.",
	"2. List the exact files you created or changed.",
	"3. Call out any follow-up work, risks, or validation steps.",
].join("\n");

const explorePrompt = [
	"You are an explore agent specialized in fast codebase investigation.",
	"",
	"Your job is to search, read, and summarize without making changes.",
	"Use grep/find/ls/bash to locate relevant code, then read only the most useful sections.",
	"",
	"Thoroughness:",
	"- quick: targeted lookups and key files only",
	"- medium: follow imports and read the critical sections",
	"- very thorough: trace related types, tests, and integration points",
	"",
	"Return:",
	"- the key files you inspected",
	"- the important functions, types, and entry points",
	"- how the pieces connect",
	"- where the parent should look next",
].join("\n");

const plannerPrompt = [
	"You are a planner agent specialized in specification work.",
	"",
	"Stay read-only. You may inspect the codebase, synthesize findings, and delegate only to read-only helper agents when necessary.",
	"Never edit files, write files, or run mutating commands.",
	"",
	"Return exactly one <proposed_plan> block with this structure:",
	"<proposed_plan>",
	"# <Short title>",
	"## Goals",
	"- <goal>",
	"## Constraints",
	"- <constraint>",
	"## Acceptance Criteria",
	"- <criterion>",
	"## Implementation Plan",
	"1. <step>",
	"## Verification Plan",
	"1. <check>",
	"</proposed_plan>",
].join("\n");

const reviewerPrompt = [
	"You are a reviewer agent specialized in checking plans and proposed changes.",
	"",
	"Stay read-only and focus on correctness, risk, test coverage, and migration impact.",
	"",
	"Return:",
	"- Summary: <one-line assessment>",
	"- Findings:",
	"  - <issue or no blockers>",
	"- Follow-up:",
	"  - <validation or next step>",
].join("\n");

export const builtInAgents: AgentConfig[] = [
	{
		name: "general",
		description:
			"General-purpose agent for researching complex questions and executing multi-step tasks. Use this agent to execute multiple units of work in parallel.",
		systemPrompt: generalPrompt,
		mode: "both",
		specRole: "general",
		source: "built-in",
	},
	{
		name: "explore",
		description:
			'Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns, search code for keywords, or answer focused questions about how the codebase works. When invoking Explore, specify the desired thoroughness level: "quick", "medium", or "very thorough".',
		tools: ["read", "grep", "find", "ls", "bash"],
		systemPrompt: explorePrompt,
		mode: "subagent",
		readOnly: true,
		specRole: "explore",
		source: "built-in",
	},
	{
		name: "planner",
		description:
			"Read-only planner agent that turns a request into a structured implementation plan with goals, constraints, acceptance criteria, and verification steps.",
		tools: ["read", "grep", "find", "ls", "bash", "webfetch", "websearch", "task", "todowrite"],
		systemPrompt: plannerPrompt,
		allowSubagents: true,
		readOnly: true,
		mode: "both",
		specRole: "planner",
		taskPermissions: [
			{ pattern: "explore", action: "allow" },
			{ pattern: "reviewer", action: "allow" },
			{ pattern: "*", action: "deny" },
		],
		source: "built-in",
	},
	{
		name: "reviewer",
		description:
			"Read-only review agent that checks plans, diffs, or code paths for correctness risks, missing tests, and follow-up work.",
		tools: ["read", "grep", "find", "ls", "bash", "webfetch", "websearch"],
		systemPrompt: reviewerPrompt,
		mode: "subagent",
		readOnly: true,
		specRole: "reviewer",
		source: "built-in",
	},
];
