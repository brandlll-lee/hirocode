import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type Static, Type } from "@sinclair/typebox";
import { TypeCompiler } from "@sinclair/typebox/compiler";
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
		allowSubagents: Type.Optional(Type.Boolean()),
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

function normalizeTools(value: AgentFrontmatter["tools"]): string[] | undefined {
	const tools = Array.isArray(value)
		? value.map((item) => item.trim()).filter(Boolean)
		: value
			? value
					.split(",")
					.map((item) => item.trim())
					.filter(Boolean)
			: [];

	if (tools.length === 0) {
		return undefined;
	}

	return [...new Set(tools)];
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
	return {
		name: parsed.name,
		description: parsed.description,
		tools: normalizeTools(parsed.tools),
		model: parsed.model,
		allowSubagents: parsed.allowSubagents,
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
