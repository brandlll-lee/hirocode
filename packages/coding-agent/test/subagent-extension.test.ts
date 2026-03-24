import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TUI } from "@hirocode/tui";
import stripAnsi from "strip-ansi";
import { afterEach, describe, expect, it } from "vitest";
import { registerSubagentTools } from "../examples/extensions/subagent/index.js";
import type { ExtensionAPI } from "../src/core/extensions/types.js";
import {
	formatModelReference,
	resolveAgentInvocation,
	resolveEffectiveSubagentModel,
} from "../src/core/subagents/invocation.js";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.js";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.js";

const AGENT_DIR_ENV = "HIROCODE_CODING_AGENT_DIR";
const originalAgentDir = process.env[AGENT_DIR_ENV];

type RegisteredToolDefinition = Parameters<ExtensionAPI["registerTool"]>[0];
type RegisteredHandler = (...args: unknown[]) => Promise<unknown> | unknown;

function collectRegisteredExtension() {
	const tools: RegisteredToolDefinition[] = [];
	const handlers = new Map<string, RegisteredHandler>();
	const labels: Array<{ entryId: string; label: string | undefined }> = [];
	const api = {
		registerTool(tool: RegisteredToolDefinition) {
			tools.push(tool);
		},
		on(event: string, handler: RegisteredHandler) {
			handlers.set(event, handler);
		},
		setLabel(entryId: string, label: string | undefined) {
			labels.push({ entryId, label });
		},
	} as Pick<ExtensionAPI, "on" | "registerTool" | "setLabel"> as ExtensionAPI;

	registerSubagentTools(api);
	return { tools, handlers, labels };
}

function collectRegisteredTools(): RegisteredToolDefinition[] {
	return collectRegisteredExtension().tools;
}

function createFakeTui() {
	return {
		requestRender: () => {},
	} as unknown as TUI;
}

function createLegacySubagentTaskSession(cwd: string) {
	const agentRoot = path.join(cwd, "agent-home");
	process.env[AGENT_DIR_ENV] = agentRoot;
	const taskId = "legacy-task";
	const taskDir = path.join(agentRoot, "subagents", "parent-session");
	const sessionFile = path.join(taskDir, `task-${taskId}.jsonl`);
	const metadataFile = path.join(taskDir, `task-${taskId}.json`);
	fs.mkdirSync(taskDir, { recursive: true });
	fs.writeFileSync(sessionFile, `{"type":"session","id":"${taskId}"}\n`, "utf-8");
	fs.writeFileSync(
		metadataFile,
		`${JSON.stringify(
			{
				taskId,
				parentSessionId: "parent-session",
				agent: "worker",
				agentSource: "user",
				allowSubagents: false,
				sessionFile,
				metadataFile,
				sessionId: taskId,
			},
			null,
			2,
		)}\n`,
		"utf-8",
	);
	return { taskId, sessionFile };
}

initTheme("dark");

afterEach(() => {
	if (originalAgentDir === undefined) delete process.env[AGENT_DIR_ENV];
	else process.env[AGENT_DIR_ENV] = originalAgentDir;
});

describe("subagent extension registration", () => {
	it("registers the subagent tool and lifecycle handlers", () => {
		const extension = collectRegisteredExtension();
		const tools = extension.tools;

		expect(tools.map((tool) => tool.name)).toEqual(["subagent"]);
		expect(tools.find((tool) => tool.name === "subagent")?.promptSnippet).toContain("Delegate isolated work");
		expect(extension.handlers.has("tool_call")).toBe(true);
		expect(extension.handlers.has("tool_result")).toBe(true);
	});

	it("inherits the parent model when the agent does not specify one", () => {
		expect(resolveEffectiveSubagentModel(undefined, { provider: "openai", id: "gpt-5.4" })).toEqual({
			provider: "openai",
			modelId: "gpt-5.4",
			modelArg: "openai/gpt-5.4",
		});

		expect(resolveEffectiveSubagentModel("claude-haiku-4-5", { provider: "openai", id: "gpt-5.4" })).toEqual({
			modelId: "claude-haiku-4-5",
			modelArg: "claude-haiku-4-5",
		});
	});

	it("formats provider and model references for UI display", () => {
		expect(formatModelReference("openai", "gpt-5.4")).toBe("openai/gpt-5.4");
		expect(formatModelReference(undefined, "gpt-5.4")).toBe("gpt-5.4");
	});

	it("shows an inline spinner while a delegated task is running and a success dot when complete", () => {
		const subagentTool = collectRegisteredTools().find((tool) => tool.name === "subagent");
		expect(subagentTool).toBeDefined();

		const component = new ToolExecutionComponent(
			"subagent",
			"tool-ui-1",
			{
				agent: "scout",
				task: "Inspect subagent files",
			},
			{},
			subagentTool,
			createFakeTui(),
		);
		component.markExecutionStarted();

		const runningRaw = component.render(120).join("\n");
		const runningPlain = stripAnsi(runningRaw);
		expect(runningPlain).toContain("⠋ subagent scout [user]");
		expect(runningRaw).toContain("\u001b[48;");

		component.updateResult(
			{
				content: [{ type: "text", text: "done" }],
				details: { mode: "single", agentScope: "user", projectAgentsDir: null, results: [] },
				isError: false,
			},
			false,
		);

		const successRaw = component.render(120).join("\n");
		const successPlain = stripAnsi(successRaw);
		expect(successPlain).toContain("● subagent scout [user]");
		expect(successRaw).toContain(theme.fg("success", "●"));
		expect(successRaw).toContain("\u001b[48;");
	});

	it("shows an inline error dot when a delegated task fails", () => {
		const subagentTool = collectRegisteredTools().find((tool) => tool.name === "subagent");
		expect(subagentTool).toBeDefined();

		const component = new ToolExecutionComponent(
			"subagent",
			"tool-ui-2",
			{
				agent: "scout",
				task: "Inspect subagent files",
			},
			{},
			subagentTool,
			createFakeTui(),
		);
		component.markExecutionStarted();
		component.updateResult(
			{
				content: [{ type: "text", text: "failed" }],
				details: { mode: "single", agentScope: "user", projectAgentsDir: null, results: [] },
				isError: true,
			},
			false,
		);

		const errorRaw = component.render(120).join("\n");
		const errorPlain = stripAnsi(errorRaw);
		expect(errorPlain).toContain("● subagent scout [user]");
		expect(errorRaw).toContain(theme.fg("error", "●"));
		expect(errorRaw).toContain("\u001b[48;");
	});

	it("uses tsx when the parent CLI is started from a ts entrypoint", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "hirocode-subagent-invoke-"));
		const scriptPath = path.join(root, "packages", "coding-agent", "src", "cli.ts");
		const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");

		fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
		fs.mkdirSync(path.dirname(tsxCli), { recursive: true });
		fs.writeFileSync(scriptPath, "export {}\n", "utf-8");
		fs.writeFileSync(tsxCli, "", "utf-8");

		const invocation = resolveAgentInvocation(["--mode", "json"], {
			currentScript: scriptPath,
			execPath: process.execPath,
		});

		expect(invocation.command).toBe(process.execPath);
		expect(invocation.args).toEqual([tsxCli, scriptPath, "--mode", "json"]);
	});

	it("labels the tool row on subagent results", async () => {
		const extension = collectRegisteredExtension();
		const handler = extension.handlers.get("tool_result") as RegisteredHandler;
		expect(handler).toBeDefined();

		await handler(
			{
				toolName: "subagent",
				details: {
					mode: "single",
					agentScope: "user",
					projectAgentsDir: null,
					results: [
						{
							taskId: "task-1",
							sessionId: "task-1",
							sessionFile: "/tmp/task-1.jsonl",
							metadataFile: "/tmp/task-1.json",
							parentSessionId: "parent-session",
							agent: "scout",
							agentSource: "user",
							task: "Find auth flow",
							exitCode: 0,
							messages: [],
							stderr: "",
							usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
						},
					],
				},
			},
			{
				sessionManager: {
					getLeafEntry: () => ({ id: "leaf-1" }),
					getLabel: () => undefined,
				},
			} as never,
		);

		expect(extension.labels).toEqual([{ entryId: "leaf-1", label: "subagent:scout" }]);
	});

	it("blocks nested delegated task calls inside child subagent sessions by default", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "hirocode-subagent-nested-"));
		const legacy = createLegacySubagentTaskSession(cwd);

		const extension = collectRegisteredExtension();
		const handler = extension.handlers.get("tool_call") as RegisteredHandler;

		const result = await handler({ toolName: "subagent" }, {
			sessionManager: {
				getSessionId: () => legacy.taskId,
				getSessionFile: () => legacy.sessionFile,
			},
		} as never);

		expect(result).toEqual({
			block: true,
			reason:
				"Nested subagents are disabled for delegated sessions. Set allowSubagents: true in the agent frontmatter to opt in.",
		});
	});
});
