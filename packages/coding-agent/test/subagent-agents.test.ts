import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverAgents, parseAgentMarkdown } from "../examples/extensions/subagent/agents.js";

const AGENT_DIR_ENV = "HIROCODE_CODING_AGENT_DIR";
const LEGACY_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const originalAgentDir = process.env[AGENT_DIR_ENV];
const originalLegacyAgentDir = process.env[LEGACY_AGENT_DIR_ENV];

function writeAgent(filePath: string, content: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content, "utf-8");
}

afterEach(() => {
	if (originalAgentDir === undefined) delete process.env[AGENT_DIR_ENV];
	else process.env[AGENT_DIR_ENV] = originalAgentDir;

	if (originalLegacyAgentDir === undefined) delete process.env[LEGACY_AGENT_DIR_ENV];
	else process.env[LEGACY_AGENT_DIR_ENV] = originalLegacyAgentDir;
});

describe("subagent agent discovery", () => {
	it("parses formalized frontmatter with YAML arrays", () => {
		const parsed = parseAgentMarkdown(
			`---
name: code-reviewer
description: Reviews diffs for bugs
allowSubagents: true
taskPermissions:
  reviewer: deny
  "*": allow
tools:
  - Read
  - Grep
  - Read
model: claude-sonnet-4-5
---

Review the provided code and report risks.
`,
			"user",
			"/tmp/code-reviewer.md",
		);

		expect(parsed).toEqual({
			name: "code-reviewer",
			description: "Reviews diffs for bugs",
			allowSubagents: true,
			taskPermissions: [
				{ pattern: "reviewer", action: "deny" },
				{ pattern: "*", action: "allow" },
			],
			tools: ["Read", "Grep"],
			model: "claude-sonnet-4-5",
			systemPrompt: "Review the provided code and report risks.",
			source: "user",
			filePath: "/tmp/code-reviewer.md",
		});
	});

	it("rejects invalid agent markdown definitions", () => {
		expect(
			parseAgentMarkdown(
				`---
name: Invalid Name
description: Broken
---

Prompt body.
`,
				"user",
				"/tmp/broken.md",
			),
		).toBeUndefined();

		expect(
			parseAgentMarkdown(
				`---
name: valid-name
description: Missing prompt body
---
`,
				"user",
				"/tmp/missing-body.md",
			),
		).toBeUndefined();
	});

	it("prefers .hirocode project agents and lets them override user agents", () => {
		const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hirocode-subagent-agents-"));
		const userAgentDir = path.join(tempRoot, "home-agent");
		const repoRoot = path.join(tempRoot, "repo");
		const nestedCwd = path.join(repoRoot, "packages", "coding-agent");

		process.env[AGENT_DIR_ENV] = userAgentDir;

		writeAgent(
			path.join(userAgentDir, "agents", "shared.md"),
			`---
name: shared
description: User shared agent
tools: Read, Grep
---

User prompt.
`,
		);
		writeAgent(
			path.join(userAgentDir, "agents", "user-only.md"),
			`---
name: user-only
description: User only agent
---

User only prompt.
`,
		);
		writeAgent(
			path.join(repoRoot, ".hirocode", "agents", "shared.md"),
			`---
name: shared
description: Project shared agent
tools:
  - Read
  - Glob
---

Project prompt.
`,
		);
		writeAgent(
			path.join(repoRoot, ".hirocode", "agents", "project-only.md"),
			`---
name: project-only
description: Project only agent
---

Project only prompt.
`,
		);

		const result = discoverAgents(nestedCwd, "both");
		const byName = new Map(result.agents.map((agent) => [agent.name, agent]));

		expect(result.projectAgentsDir).toBe(path.join(repoRoot, ".hirocode", "agents"));
		expect(byName.get("general")?.source).toBe("built-in");
		expect(byName.get("explore")?.source).toBe("built-in");
		expect(byName.get("shared")?.source).toBe("project");
		expect(byName.get("shared")?.systemPrompt).toBe("Project prompt.");
		expect(byName.get("shared")?.tools).toEqual(["Read", "Glob"]);
		expect(byName.get("user-only")?.source).toBe("user");
		expect(byName.get("project-only")?.source).toBe("project");
	});

	it("falls back to legacy .pi project agents when .hirocode is absent", () => {
		const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hirocode-subagent-legacy-"));
		const userAgentDir = path.join(tempRoot, "home-agent");
		const repoRoot = path.join(tempRoot, "repo");

		process.env[AGENT_DIR_ENV] = userAgentDir;
		writeAgent(
			path.join(repoRoot, ".pi", "agents", "legacy.md"),
			`---
name: legacy
description: Legacy project agent
---

Legacy prompt.
`,
		);

		const result = discoverAgents(repoRoot, "project");
		const byName = new Map(result.agents.map((agent) => [agent.name, agent]));

		expect(result.projectAgentsDir).toBe(path.join(repoRoot, ".pi", "agents"));
		expect(byName.get("legacy")).toMatchObject({
			name: "legacy",
			description: "Legacy project agent",
			source: "project",
			systemPrompt: "Legacy prompt.",
		});
		expect(byName.get("general")?.source).toBe("built-in");
		expect(byName.get("explore")?.source).toBe("built-in");
	});

	it("includes built-in general and explore agents even without custom files", () => {
		const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hirocode-built-in-agents-"));
		process.env[AGENT_DIR_ENV] = path.join(tempRoot, "home-agent");

		const result = discoverAgents(tempRoot, "both");
		const byName = new Map(result.agents.map((agent) => [agent.name, agent]));

		expect(byName.get("general")).toMatchObject({
			name: "general",
			source: "built-in",
		});
		expect(byName.get("explore")).toMatchObject({
			name: "explore",
			source: "built-in",
			tools: ["read", "grep", "find", "ls", "bash"],
		});
	});
});
