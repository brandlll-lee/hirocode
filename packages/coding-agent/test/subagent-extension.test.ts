import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TUI } from "@hirocode/tui";
import stripAnsi from "strip-ansi";
import { afterEach, describe, expect, it } from "vitest";
import {
	formatModelReference,
	registerSubagentTools,
	resolveAgentInvocation,
	resolveEffectiveSubagentModel,
} from "../examples/extensions/subagent/index.js";
import {
	createTaskReference,
	initializeTaskSession,
	persistTaskReference,
} from "../examples/extensions/subagent/task-persistence.js";
import type { ExtensionAPI } from "../src/core/extensions/types.js";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.js";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.js";

const AGENT_DIR_ENV = "HIROCODE_CODING_AGENT_DIR";
const LEGACY_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const originalAgentDir = process.env[AGENT_DIR_ENV];
const originalLegacyAgentDir = process.env[LEGACY_AGENT_DIR_ENV];

type RegisteredToolDefinition = Parameters<ExtensionAPI["registerTool"]>[0];
type RegisteredCommandDefinition = Parameters<ExtensionAPI["registerCommand"]>[1];
type ToolContext = Parameters<RegisteredToolDefinition["execute"]>[4];
type RegisteredHandler = (...args: unknown[]) => Promise<unknown> | unknown;

function collectRegisteredExtension() {
	const tools: RegisteredToolDefinition[] = [];
	const commands = new Map<string, RegisteredCommandDefinition>();
	const handlers = new Map<string, RegisteredHandler>();
	const appendedEntries: Array<{ customType: string; data?: unknown }> = [];
	const labels: Array<{ entryId: string; label: string | undefined }> = [];
	const api = {
		registerTool(tool: RegisteredToolDefinition) {
			tools.push(tool);
		},
		registerCommand(name: string, command: RegisteredCommandDefinition) {
			commands.set(name, command);
		},
		on(event: string, handler: RegisteredHandler) {
			handlers.set(event, handler);
		},
		appendEntry(customType: string, data?: unknown) {
			appendedEntries.push({ customType, data });
		},
		setLabel(entryId: string, label: string | undefined) {
			labels.push({ entryId, label });
		},
	} as Pick<ExtensionAPI, "appendEntry" | "on" | "registerCommand" | "registerTool" | "setLabel"> as ExtensionAPI;

	registerSubagentTools(api);
	return { tools, commands, handlers, appendedEntries, labels };
}

function collectRegisteredTools(): RegisteredToolDefinition[] {
	return collectRegisteredExtension().tools;
}

function createToolContext(
	cwd: string,
	options?: {
		model?: { provider: string; id: string };
		branch?: unknown[];
	},
): ToolContext {
	return {
		cwd,
		hasUI: false,
		model: options?.model,
		sessionManager: {
			getSessionId: () => "parent-session",
			getSessionFile: () => path.join(cwd, "parent-session.jsonl"),
			getBranch: () => options?.branch ?? [],
		},
	} as unknown as ToolContext;
}

function createFakeTui() {
	return {
		requestRender: () => {},
	} as unknown as TUI;
}

function createSubagentBranchEntry(data: {
	toolName: "subagent" | "task";
	mode: "single" | "parallel" | "chain";
	taskId: string;
	sessionId?: string;
	sessionFile: string;
	metadataFile: string;
	parentSessionId: string;
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	status: "running" | "completed" | "failed" | "error" | "aborted";
}) {
	return {
		type: "custom",
		id: `entry-${data.taskId}`,
		parentId: null,
		timestamp: new Date().toISOString(),
		customType: "subagent-record",
		data,
	};
}

initTheme("dark");

afterEach(() => {
	if (originalAgentDir === undefined) delete process.env[AGENT_DIR_ENV];
	else process.env[AGENT_DIR_ENV] = originalAgentDir;

	if (originalLegacyAgentDir === undefined) delete process.env[LEGACY_AGENT_DIR_ENV];
	else process.env[LEGACY_AGENT_DIR_ENV] = originalLegacyAgentDir;
});

describe("subagent extension registration", () => {
	it("registers tools, commands, and lifecycle handlers", () => {
		const extension = collectRegisteredExtension();
		const tools = extension.tools;

		expect(tools.map((tool) => tool.name).sort()).toEqual(["subagent", "task"]);
		expect(tools.find((tool) => tool.name === "task")?.promptSnippet).toContain("Delegate one focused task");
		expect(tools.find((tool) => tool.name === "subagent")?.promptSnippet).toContain("Delegate isolated work");
		expect(extension.commands.has("subagents")).toBe(true);
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
		const taskTool = collectRegisteredTools().find((tool) => tool.name === "task");
		expect(taskTool).toBeDefined();

		const component = new ToolExecutionComponent(
			"task",
			"tool-ui-1",
			{
				description: "scan subagent implementation",
				prompt: "Inspect subagent files",
				subagent_type: "scout",
			},
			{},
			taskTool,
			createFakeTui(),
		);
		component.markExecutionStarted();

		const runningRaw = component.render(120).join("\n");
		const runningPlain = stripAnsi(runningRaw);
		expect(runningPlain).toContain("⠋ task scout [user]");
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
		expect(successPlain).toContain("● task scout [user]");
		expect(successRaw).toContain(theme.fg("success", "●"));
		expect(successRaw).toContain("\u001b[48;");
	});

	it("shows an inline error dot when a delegated task fails", () => {
		const taskTool = collectRegisteredTools().find((tool) => tool.name === "task");
		expect(taskTool).toBeDefined();

		const component = new ToolExecutionComponent(
			"task",
			"tool-ui-2",
			{
				description: "scan subagent implementation",
				prompt: "Inspect subagent files",
				subagent_type: "scout",
			},
			{},
			taskTool,
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
		expect(errorPlain).toContain("● task scout [user]");
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

	it("records subagent sessions on tool results and labels the tool row", async () => {
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

		expect(extension.appendedEntries).toEqual([
			{
				customType: "subagent-record",
				data: {
					toolName: "subagent",
					mode: "single",
					taskId: "task-1",
					sessionId: "task-1",
					sessionFile: "/tmp/task-1.jsonl",
					metadataFile: "/tmp/task-1.json",
					parentSessionId: "parent-session",
					agent: "scout",
					agentSource: "user",
					task: "Find auth flow",
					status: "completed",
				},
			},
		]);
		expect(extension.labels).toEqual([{ entryId: "leaf-1", label: "subagent:scout" }]);
	});

	it("opens the latest delegated child session from the /subagents command", async () => {
		const extension = collectRegisteredExtension();
		const command = extension.commands.get("subagents");
		expect(command).toBeDefined();

		const sessionFile = path.join(os.tmpdir(), "hirocode-child-session.jsonl");
		fs.writeFileSync(sessionFile, "", "utf-8");
		let switchedTo: string | undefined;

		await command!.handler("", {
			hasUI: false,
			sessionManager: {
				getBranch: () => [
					{
						type: "custom",
						id: "entry-1",
						parentId: null,
						timestamp: new Date().toISOString(),
						customType: "subagent-record",
						data: {
							toolName: "task",
							mode: "single",
							taskId: "task-1",
							sessionId: "task-1",
							sessionFile,
							metadataFile: path.join(os.tmpdir(), "hirocode-child-session.json"),
							parentSessionId: "parent-session",
							agent: "reviewer",
							agentSource: "user",
							task: "Review auth changes",
							status: "completed",
						},
					},
				],
			},
			ui: {
				notify: () => {},
			},
			switchSession: async (sessionPath: string) => {
				switchedTo = sessionPath;
				return { cancelled: false };
			},
		} as never);

		expect(switchedTo).toBe(sessionFile);
		fs.unlinkSync(sessionFile);
	});

	it("opens a delegated child session directly in interactive mode", async () => {
		const extension = collectRegisteredExtension();
		const command = extension.commands.get("subagents");
		expect(command).toBeDefined();

		const sessionFile = path.join(os.tmpdir(), "hirocode-live-viewer-session.jsonl");
		fs.writeFileSync(sessionFile, "", "utf-8");
		let switchedTo: string | undefined;

		await command!.handler("", {
			hasUI: true,
			sessionManager: {
				getBranch: () => [
					createSubagentBranchEntry({
						toolName: "task",
						mode: "single",
						taskId: "task-live",
						sessionId: "task-live",
						sessionFile,
						metadataFile: path.join(os.tmpdir(), "hirocode-live-viewer-session.json"),
						parentSessionId: "parent-session",
						agent: "reviewer",
						agentSource: "user",
						task: "Review auth changes",
						status: "completed",
					}),
				],
				getSessionFile: () => path.join(os.tmpdir(), "hirocode-parent-session.jsonl"),
			},
			ui: {
				notify: () => {},
			},
			switchSession: async (sessionPath: string) => {
				switchedTo = sessionPath;
				return { cancelled: false };
			},
		} as never);

		expect(switchedTo).toBe(sessionFile);
		fs.unlinkSync(sessionFile);
	});

	it("lets you choose among multiple subagents and wait for running work to finish before opening", async () => {
		const extension = collectRegisteredExtension();
		const command = extension.commands.get("subagents");
		expect(command).toBeDefined();

		const runningSessionFile = path.join(os.tmpdir(), "hirocode-running-child-session.jsonl");
		const completedSessionFile = path.join(os.tmpdir(), "hirocode-completed-child-session.jsonl");
		fs.writeFileSync(runningSessionFile, "", "utf-8");
		fs.writeFileSync(completedSessionFile, "", "utf-8");

		const selectCalls: Array<{ title: string; options: string[] }> = [];
		let waitedForIdle = false;
		let switchedTo: string | undefined;

		await command!.handler("", {
			hasUI: true,
			sessionManager: {
				getBranch: () => [
					createSubagentBranchEntry({
						toolName: "subagent",
						mode: "parallel",
						taskId: "task-complete",
						sessionId: "task-complete",
						sessionFile: completedSessionFile,
						metadataFile: path.join(os.tmpdir(), "hirocode-completed-child-session.json"),
						parentSessionId: "parent-session",
						agent: "planner",
						agentSource: "user",
						task: "Summarize current architecture",
						status: "completed",
					}),
					createSubagentBranchEntry({
						toolName: "subagent",
						mode: "parallel",
						taskId: "task-running",
						sessionId: "task-running",
						sessionFile: runningSessionFile,
						metadataFile: path.join(os.tmpdir(), "hirocode-running-child-session.json"),
						parentSessionId: "parent-session",
						agent: "scout",
						agentSource: "user",
						task: "Scan auth code paths",
						status: "running",
					}),
				],
				getSessionFile: () => path.join(os.tmpdir(), "hirocode-parent-session.jsonl"),
			},
			ui: {
				notify: () => {},
				select: async (title: string, options: string[]) => {
					selectCalls.push({ title, options });
					if (title === "Subagent Sessions") {
						return options[0];
					}
					if (title === "Open running subagent session?") {
						return "Wait until idle (Recommended)";
					}
					return undefined;
				},
			},
			waitForIdle: async () => {
				waitedForIdle = true;
			},
			switchSession: async (sessionPath: string) => {
				switchedTo = sessionPath;
				return { cancelled: false };
			},
		} as never);

		expect(selectCalls[0]).toEqual({
			title: "Subagent Sessions",
			options: ["⏳ scout (user) - Scan auth code paths", "✓ planner (user) - Summarize current architecture"],
		});
		expect(selectCalls[1]?.title).toBe("Open running subagent session?");
		expect(waitedForIdle).toBe(true);
		expect(switchedTo).toBe(runningSessionFile);

		fs.unlinkSync(runningSessionFile);
		fs.unlinkSync(completedSessionFile);
	});

	it("blocks nested delegated task calls inside child subagent sessions by default", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "hirocode-subagent-nested-"));
		process.env[AGENT_DIR_ENV] = path.join(cwd, "agent-home");

		const extension = collectRegisteredExtension();
		const handler = extension.handlers.get("tool_call") as RegisteredHandler;
		const reference = createTaskReference("parent-session", {
			agent: "worker",
			agentSource: "user",
			allowSubagents: false,
			systemPrompt: "Do work",
		});
		initializeTaskSession(reference, cwd, path.join(cwd, "parent.jsonl"));
		persistTaskReference(reference);

		const result = await handler({ toolName: "task" }, {
			sessionManager: {
				getSessionId: () => reference.taskId,
				getSessionFile: () => reference.sessionFile,
			},
		} as never);

		expect(result).toEqual({
			block: true,
			reason:
				"Nested subagents are disabled for delegated sessions. Set allowSubagents: true in the agent frontmatter to opt in.",
		});
	});

	it("task alias returns a clear error for unknown task_id resume", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "hirocode-subagent-task-"));
		process.env[AGENT_DIR_ENV] = path.join(cwd, "agent-home");

		const taskTool = collectRegisteredTools().find((tool) => tool.name === "task");
		expect(taskTool).toBeDefined();

		const result = await taskTool!.execute(
			"tool-1",
			{
				description: "Resume review",
				prompt: "Review auth changes",
				subagent_type: "reviewer",
				task_id: "task-123",
			},
			undefined,
			undefined,
			createToolContext(cwd),
		);

		expect(result.content[0]).toEqual({
			type: "text",
			text: "Unknown task_id task-123. Resume only works for task runs created by this extension.",
		});
	});

	it("task alias uses standard Task-style parameters and surfaces unknown agents cleanly", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "hirocode-subagent-task-"));
		process.env[AGENT_DIR_ENV] = path.join(cwd, "agent-home");

		const taskTool = collectRegisteredTools().find((tool) => tool.name === "task");
		expect(taskTool).toBeDefined();

		const result = await taskTool!.execute(
			"tool-2",
			{
				description: "Inspect auth",
				prompt: "Find authentication-related code",
				subagent_type: "scout",
			},
			undefined,
			undefined,
			createToolContext(cwd),
		);

		expect(result.content[0].type).toBe("text");
		expect((result.content[0] as { type: "text"; text: string }).text).toContain('Unknown agent: "scout"');
	});

	it("task alias rejects unknown resume ids before spawning", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "hirocode-subagent-task-"));
		process.env[AGENT_DIR_ENV] = path.join(cwd, "agent-home");

		const taskTool = collectRegisteredTools().find((tool) => tool.name === "task");
		expect(taskTool).toBeDefined();

		const result = await taskTool!.execute(
			"tool-3",
			{
				description: "Continue auth scan",
				prompt: "Continue from where you left off",
				subagent_type: "scout",
				task_id: "missing-task",
			},
			undefined,
			undefined,
			createToolContext(cwd),
		);

		expect(result.content[0]).toEqual({
			type: "text",
			text: "Unknown task_id missing-task. Resume only works for task runs created by this extension.",
		});
	});
});
