import { buildSpecPlannerPrompt } from "../spec/mode.js";
import type { AgentConfig } from "./types.js";

const webPrompt = [
	"You are a web research agent specialized in searching the web and fetching URL content.",
	"",
	"Your job is to gather accurate, up-to-date information from the web.",
	"",
	"Guidelines:",
	"1. Use websearch to find relevant pages for a topic or question.",
	"2. Use webfetch to retrieve the content of specific URLs.",
	"3. Return concise, well-structured answers with source citations.",
	"4. Include the URLs you used as references.",
].join("\n");

const generalPrompt = [
	"You are a general execution agent in an isolated child session.",
	"",
	"Choose the lightest tool that fits the job:",
	"1. For research, reading, or web lookups, prefer read/grep/find/ls/webfetch/websearch before bash.",
	"2. Use edit/write when the task requires file changes.",
	"3. Use bash only for real command execution, validation, or tooling that cannot be handled by the other tools.",
	"",
	"Execution rules:",
	"1. Complete the assigned task autonomously.",
	"2. When you change files, verify the result yourself before finishing.",
	"3. Do not finish until the requested work is complete or you can clearly explain the blocker.",
	"",
	"Work autonomously on the assigned task without assuming the parent has seen your intermediate steps.",
	"",
	"When you finish:",
	"1. State what you completed.",
	"2. List the exact files you changed, if any.",
	"3. Call out validation, follow-up work, or risks.",
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
		tools: ["*"],
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
		name: "web",
		description:
			"Web research agent for searching documentation, answering questions, and fetching URL content. Use this when you need to look up information online or read content from specific URLs.",
		tools: ["webfetch", "websearch"],
		systemPrompt: webPrompt,
		mode: "subagent",
		readOnly: true,
		specRole: "web",
		source: "built-in",
	},
	{
		name: "planner",
		description:
			"Read-only planner agent that turns a request into a structured implementation plan with goals, constraints, acceptance criteria, and verification steps.",
		tools: ["read", "grep", "find", "ls", "bash", "webfetch", "websearch", "task"],
		systemPrompt: buildSpecPlannerPrompt(),
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
