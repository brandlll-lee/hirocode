import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type Static, Type } from "@sinclair/typebox";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import { isValidThinkingLevel } from "../../cli/args.js";
import { getAgentDir } from "../../config.js";
import { parseFrontmatter } from "../../utils/frontmatter.js";
import { builtInAgents } from "./builtin-agents.js";
import type { AgentConfig, AgentDiscoveryResult, AgentScope, AgentSource } from "./types.js";

export type { AgentConfig, AgentDiscoveryResult, AgentScope } from "./types.js";

const agentFrontmatterSchema = Type.Object(
	{
		name: Type.String({ minLength: 1, pattern: "^[a-z0-9][a-z0-9_-]*$" }),
		description: Type.String({ minLength: 1 }),
		tools: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])),
		model: Type.Optional(Type.String({ minLength: 1 })),
		reasoningEffort: Type.Optional(Type.String({ minLength: 1 })),
		allowSubagents: Type.Optional(Type.Boolean()),
		mode: Type.Optional(Type.Union([Type.Literal("primary"), Type.Literal("subagent"), Type.Literal("both")])),
		hidden: Type.Optional(Type.Boolean()),
		readOnly: Type.Optional(Type.Boolean()),
		specRole: Type.Optional(
			Type.Union([
				Type.Literal("general"),
				Type.Literal("explore"),
				Type.Literal("planner"),
				Type.Literal("reviewer"),
				Type.Literal("validator"),
			]),
		),
		taskPermissions: Type.Optional(
			Type.Record(
				Type.String({ minLength: 1 }),
				Type.Union([Type.Literal("allow"), Type.Literal("deny"), Type.Literal("ask")]),
			),
		),
	},
	{ additionalProperties: true },
);

const validateAgentFrontmatter = TypeCompiler.Compile(agentFrontmatterSchema);
type AgentFrontmatter = Static<typeof agentFrontmatterSchema>;

// Droid-compatible tool category strings → hirocode tool names
const TOOL_CATEGORY_MAP: Record<string, string[]> = {
	"read-only": ["read", "grep", "find", "ls"],
	edit: ["edit", "write"],
	execute: ["bash"],
	web: ["webfetch", "websearch"],
};

// Sentinel value for MCP tools (resolved at runtime in task-runner)
export const MCP_TOOLS_SENTINEL = "mcp";

// Droid capitalized tool name aliases → hirocode lowercase names
const TOOL_NAME_ALIASES: Record<string, string> = {
	Read: "read",
	LS: "ls",
	Grep: "grep",
	Glob: "find",
	Create: "write",
	Edit: "edit",
	ApplyPatch: "edit",
	Execute: "bash",
	WebSearch: "websearch",
	FetchUrl: "webfetch",
	TodoWrite: "todowrite",
	Task: "task",
};

function resolveToolName(name: string): string {
	return TOOL_NAME_ALIASES[name] ?? name;
}

function normalizeTools(value: AgentFrontmatter["tools"]): string[] | undefined {
	const raw = Array.isArray(value)
		? value.map((item) => item.trim()).filter(Boolean)
		: value
			? value
					.split(",")
					.map((item) => item.trim())
					.filter(Boolean)
			: [];

	if (raw.length === 0) {
		return undefined;
	}

	// Single category string expands to its tool list
	if (raw.length === 1 && raw[0] in TOOL_CATEGORY_MAP) {
		return TOOL_CATEGORY_MAP[raw[0]];
	}

	// Expand any category names mixed into an array, then normalize aliases
	const expanded: string[] = [];
	for (const item of raw) {
		if (item in TOOL_CATEGORY_MAP) {
			expanded.push(...TOOL_CATEGORY_MAP[item]);
		} else if (item === MCP_TOOLS_SENTINEL) {
			expanded.push(MCP_TOOLS_SENTINEL);
		} else {
			expanded.push(resolveToolName(item));
		}
	}

	return [...new Set(expanded)];
}

export function parseAgentMarkdown(
	content: string,
	source: Exclude<AgentSource, "built-in">,
	filePath: string,
): AgentConfig | undefined {
	const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);
	if (!validateAgentFrontmatter.Check(frontmatter)) {
		return undefined;
	}

	const prompt = body.trim();
	if (!prompt) {
		return undefined;
	}

	const parsed = frontmatter as AgentFrontmatter;
	const reasoningEffort =
		typeof parsed.reasoningEffort === "string" && isValidThinkingLevel(parsed.reasoningEffort)
			? parsed.reasoningEffort
			: undefined;
	return {
		name: parsed.name,
		description: parsed.description,
		tools: normalizeTools(parsed.tools),
		model: parsed.model,
		reasoningEffort,
		allowSubagents: parsed.allowSubagents,
		mode: parsed.mode,
		hidden: parsed.hidden,
		readOnly: parsed.readOnly,
		specRole: parsed.specRole,
		taskPermissions: parsed.taskPermissions
			? Object.entries(parsed.taskPermissions).map(([pattern, action]) => ({ pattern, action }))
			: undefined,
		systemPrompt: prompt,
		source,
		filePath,
	};
}

function loadAgentsFromDir(dir: string, source: Exclude<AgentSource, "built-in">): AgentConfig[] {
	if (!fs.existsSync(dir)) {
		return [];
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}

	const agents: AgentConfig[] = [];
	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const agent = parseAgentMarkdown(content, source, filePath);
		if (agent) {
			agents.push(agent);
		}
	}

	return agents;
}

function isDirectory(filePath: string): boolean {
	try {
		return fs.statSync(filePath).isDirectory();
	} catch {
		return false;
	}
}

function getUserAgentDirs(): string[] {
	const primaryDir = path.join(getAgentDir(), "agents");
	const legacyDir = path.join(os.homedir(), ".pi", "agent", "agents");
	return primaryDir === legacyDir ? [primaryDir] : [legacyDir, primaryDir];
}

/** Returns the primary user agents directory (writable). */
export function getUserAgentsDir(): string {
	return path.join(getAgentDir(), "agents");
}

/** Returns the default project agents directory path for a given cwd (may not exist yet). */
export function getDefaultProjectAgentsDir(cwd: string): string {
	return path.join(cwd, ".hirocode", "agents");
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const primary = path.join(currentDir, ".hirocode", "agents");
		if (isDirectory(primary)) {
			return primary;
		}

		const legacy = path.join(currentDir, ".pi", "agents");
		if (isDirectory(legacy)) {
			return legacy;
		}

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) {
			return null;
		}
		currentDir = parentDir;
	}
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);
	const userAgents = scope === "project" ? [] : getUserAgentDirs().flatMap((dir) => loadAgentsFromDir(dir, "user"));
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");
	const agentMap = new Map<string, AgentConfig>();

	for (const agent of builtInAgents) {
		agentMap.set(agent.name, agent);
	}

	if (scope === "both") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	} else if (scope === "user") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
	} else {
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	}

	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	if (agents.length === 0) {
		return { text: "none", remaining: 0 };
	}

	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((agent) => `${agent.name} (${agent.source}): ${agent.description}`).join("; "),
		remaining,
	};
}
