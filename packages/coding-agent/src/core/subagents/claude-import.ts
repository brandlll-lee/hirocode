import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseFrontmatter } from "../../utils/frontmatter.js";

export interface ClaudeAgentInfo {
	name: string;
	description: string;
	model?: string;
	tools?: string[];
	systemPrompt: string;
	filePath: string;
	/** Tools that could not be mapped to a hirocode equivalent */
	invalidTools: string[];
}

export interface ImportResult {
	imported: string[];
	failed: Array<{ name: string; error: string }>;
}

// Claude Code tool names → hirocode tool names
const CLAUDE_TOOL_MAP: Record<string, string | null> = {
	Read: "read",
	Write: "write",
	Edit: "edit",
	MultiEdit: "edit",
	Bash: "bash",
	Glob: "find",
	Grep: "grep",
	LS: "ls",
	Task: "task",
	TodoWrite: "todowrite",
	TodoRead: null, // no equivalent
	WebSearch: "websearch",
	WebFetch: "webfetch",
	BrowseURL: "webfetch",
	NotebookRead: "read",
	NotebookEdit: null, // no equivalent
	mcp: "mcp",
};

// Claude model family → hirocode model value
function mapClaudeModel(model: string | undefined): string {
	if (!model || model === "inherit") return "inherit";
	const lower = model.toLowerCase();
	if (lower.includes("sonnet")) return "inherit"; // let parent decide
	if (lower.includes("haiku")) return "inherit";
	if (lower.includes("opus")) return "inherit";
	return model; // pass through unknown models as-is
}

function parseClaudeAgentFile(filePath: string): ClaudeAgentInfo | undefined {
	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf-8");
	} catch {
		return undefined;
	}

	const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);
	const systemPrompt = body.trim();
	if (!systemPrompt) return undefined;

	const rawName = typeof frontmatter.name === "string" ? frontmatter.name.trim() : path.basename(filePath, ".md");

	// Normalize name to hirocode pattern: lowercase, hyphens
	const name =
		rawName
			.toLowerCase()
			.replace(/[^a-z0-9_-]/g, "-")
			.replace(/^-+|-+$/g, "") || "imported-agent";

	const description =
		typeof frontmatter.description === "string"
			? frontmatter.description.trim()
			: `Imported from ${path.basename(filePath)}`;

	const rawTools = Array.isArray(frontmatter.tools)
		? (frontmatter.tools as unknown[]).map(String)
		: typeof frontmatter.tools === "string"
			? frontmatter.tools
					.split(",")
					.map((t) => t.trim())
					.filter(Boolean)
			: undefined;

	const invalidTools: string[] = [];
	const tools: string[] | undefined = rawTools
		? rawTools
				.map((t) => {
					const mapped = CLAUDE_TOOL_MAP[t];
					if (mapped === undefined) {
						invalidTools.push(t);
						return null;
					}
					return mapped; // null means no equivalent, skip
				})
				.filter((t): t is string => t !== null)
		: undefined;

	return {
		name,
		description,
		model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
		tools: tools && tools.length > 0 ? [...new Set(tools)] : undefined,
		systemPrompt,
		filePath,
		invalidTools,
	};
}

function claudeAgentsDirExists(dir: string): boolean {
	try {
		return fs.statSync(dir).isDirectory();
	} catch {
		return false;
	}
}

/** Scan Claude Code agent directories for importable agents. */
export function scanClaudeAgents(cwd: string): ClaudeAgentInfo[] {
	const dirs = [path.join(os.homedir(), ".claude", "agents"), path.join(cwd, ".claude", "agents")];

	const agents: ClaudeAgentInfo[] = [];
	const seen = new Set<string>();

	for (const dir of dirs) {
		if (!claudeAgentsDirExists(dir)) continue;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const entry of entries) {
			if (!entry.name.endsWith(".md")) continue;
			if (!entry.isFile() && !entry.isSymbolicLink()) continue;
			const filePath = path.join(dir, entry.name);
			const agent = parseClaudeAgentFile(filePath);
			if (agent && !seen.has(agent.name)) {
				seen.add(agent.name);
				agents.push(agent);
			}
		}
	}

	return agents;
}

/** Convert a parsed Claude agent into a hirocode .md file content string. */
export function convertToHirocodeMd(agent: ClaudeAgentInfo): string {
	const model = mapClaudeModel(agent.model);
	const lines = ["---"];
	lines.push(`name: ${agent.name}`);
	lines.push(`description: ${agent.description}`);
	lines.push(`model: ${model}`);
	if (agent.tools && agent.tools.length > 0) {
		lines.push("tools:");
		for (const t of agent.tools) {
			lines.push(`  - ${t}`);
		}
	}
	lines.push("---");
	lines.push("");
	lines.push(agent.systemPrompt);
	return lines.join("\n");
}

/** Write converted agents to targetDir. Returns per-agent success/failure. */
export function importClaudeAgents(agents: ClaudeAgentInfo[], targetDir: string): ImportResult {
	fs.mkdirSync(targetDir, { recursive: true });

	const imported: string[] = [];
	const failed: Array<{ name: string; error: string }> = [];

	for (const agent of agents) {
		const fileName = `${agent.name}.md`;
		const destPath = path.join(targetDir, fileName);
		try {
			const content = convertToHirocodeMd(agent);
			fs.writeFileSync(destPath, content, { encoding: "utf-8", mode: 0o644 });
			imported.push(agent.name);
		} catch (err) {
			failed.push({ name: agent.name, error: err instanceof Error ? err.message : String(err) });
		}
	}

	return { imported, failed };
}

/** Check if an agent name already exists in targetDir. */
export function agentExistsInDir(name: string, targetDir: string): boolean {
	return fs.existsSync(path.join(targetDir, `${name}.md`));
}
