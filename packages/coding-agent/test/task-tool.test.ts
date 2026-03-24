import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage } from "@hirocode/ai";
import type { TUI } from "@hirocode/tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadEntriesFromFile, SessionManager } from "../src/core/session-manager.js";
import {
	buildTaskNavigationContext,
	createChildTaskSession,
	findTaskSession,
	listChildTaskSessions,
	SUBAGENT_TASK_CUSTOM_TYPE,
} from "../src/core/subagents/task-sessions.js";
import { createTaskToolDefinition } from "../src/core/tools/task.js";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

function createFakeTui() {
	return {
		requestRender: vi.fn(),
	} as unknown as TUI;
}

function createToolContext(cwd: string, sessionManager: SessionManager) {
	return {
		cwd,
		hasUI: false,
		ui: {
			notify: () => {},
		},
		sessionManager,
		modelRegistry: {},
		model: { provider: "openai", id: "gpt-5.4" },
		isIdle: () => true,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
	} as never;
}

const createdDirs: string[] = [];

afterEach(() => {
	while (createdDirs.length > 0) {
		fs.rmSync(createdDirs.pop()!, { recursive: true, force: true });
	}
});

beforeAll(() => {
	initTheme("dark");
});

describe("task core tool", () => {
	it("surfaces built-in agents in unknown-agent errors", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "hirocode-task-tool-"));
		createdDirs.push(root);
		const sessionManager = SessionManager.create(root, path.join(root, "sessions"));
		const tool = createTaskToolDefinition(root, { getParentActiveToolNames: () => ["read", "bash", "task"] });

		const result = await tool.execute(
			"task-tool-1",
			{
				description: "Inspect auth",
				prompt: "Find auth code",
				subagent_type: "missing-agent",
			},
			undefined,
			undefined,
			createToolContext(root, sessionManager),
		);

		expect(result.content[0]?.type).toBe("text");
		expect((result.content[0] as { type: "text"; text: string }).text).toContain('Unknown agent: "missing-agent"');
		expect((result.content[0] as { type: "text"; text: string }).text).toContain("general (built-in)");
		expect((result.content[0] as { type: "text"; text: string }).text).toContain("explore (built-in)");
		expect(result.details?.agentScope).toBe("user");
	});

	it("creates first-class child session files with stored task metadata", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "hirocode-task-session-"));
		createdDirs.push(root);
		const sessionManager = SessionManager.create(root, path.join(root, "sessions"));
		const child = createChildTaskSession(sessionManager, {
			cwd: root,
			metadata: {
				agent: "general",
				agentSource: "built-in",
				allowSubagents: false,
				tools: ["read", "bash"],
				systemPrompt: "Do the delegated task.",
			},
		});

		expect(path.dirname(child.sessionFile)).toBe(sessionManager.getSessionDir());
		expect(fs.existsSync(child.sessionFile)).toBe(true);

		const entries = loadEntriesFromFile(child.sessionFile);
		expect(entries[0]).toMatchObject({
			type: "session",
			id: child.taskId,
			cwd: root,
			parentSession: sessionManager.getSessionFile(),
		});
		expect(entries[1]).toMatchObject({
			type: "custom",
			customType: SUBAGENT_TASK_CUSTOM_TYPE,
			data: {
				agent: "general",
				agentSource: "built-in",
				allowSubagents: false,
				tools: ["read", "bash"],
				systemPrompt: "Do the delegated task.",
			},
		});
	});

	it("finds first-class child sessions by task id", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "hirocode-task-find-"));
		createdDirs.push(root);
		const sessionManager = SessionManager.create(root, path.join(root, "sessions"));
		const child = createChildTaskSession(sessionManager, {
			cwd: root,
			metadata: {
				agent: "explore",
				agentSource: "built-in",
				allowSubagents: false,
			},
		});

		const located = findTaskSession(sessionManager, child.taskId);
		expect(located).toBeDefined();
		expect(located?.legacy).toBe(false);
		expect(located?.reference.sessionFile).toBe(child.sessionFile);
		expect(located?.metadata).toMatchObject({
			agent: "explore",
			agentSource: "built-in",
		});
	});

	it("lists child task sessions with running entries first", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "hirocode-task-list-"));
		createdDirs.push(root);
		const parentSession = SessionManager.create(root, path.join(root, "sessions"));
		const completed = createChildTaskSession(parentSession, {
			cwd: root,
			metadata: { agent: "general", agentSource: "built-in", title: "Completed child" },
			state: { status: "completed", task: "Completed later" },
		});

		const running = createChildTaskSession(parentSession, {
			cwd: root,
			metadata: { agent: "explore", agentSource: "built-in", title: "Running child" },
			state: { status: "running", task: "Still running" },
		});

		const children = listChildTaskSessions(parentSession);
		expect(children).toHaveLength(2);
		expect(children[0]?.reference.sessionFile).toBe(running.sessionFile);
		expect(children[0]?.state?.status).toBe("running");
		expect(children[1]?.reference.sessionFile).toBe(completed.sessionFile);
		expect(children[1]?.state?.status).toBe("completed");
	});

	it("builds a navigation root and descendant list from a child session", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "hirocode-task-navigation-"));
		createdDirs.push(root);
		const parentSession = SessionManager.create(root, path.join(root, "sessions"));
		const childA = createChildTaskSession(parentSession, {
			cwd: root,
			metadata: { agent: "general", agentSource: "built-in", title: "Child A" },
			state: { status: "completed", task: "Analyze auth" },
		});
		createChildTaskSession(parentSession, {
			cwd: root,
			metadata: { agent: "explore", agentSource: "built-in", title: "Child B" },
			state: { status: "running", task: "Inspect interactive mode" },
		});
		const childASession = SessionManager.open(childA.sessionFile, parentSession.getSessionDir());
		createChildTaskSession(childASession, {
			cwd: root,
			metadata: { agent: "general", agentSource: "built-in", title: "Grandchild" },
			state: { status: "running", task: "Nested follow-up" },
		});

		const navigation = buildTaskNavigationContext(childASession);
		expect(navigation.currentIsTaskSession).toBe(true);
		expect(navigation.rootSessionFile).toBe(parentSession.getSessionFile());
		expect(navigation.currentSessionFile).toBe(childA.sessionFile);
		expect(
			navigation.sessions.map((session) => ({
				title: session.metadata?.title,
				depth: session.depth,
				task: session.state?.task,
			})),
		).toEqual([
			{ title: "Child B", depth: 1, task: "Inspect interactive mode" },
			{ title: "Child A", depth: 1, task: "Analyze auth" },
			{ title: "Grandchild", depth: 2, task: "Nested follow-up" },
		]);
	});

	it("blocks nested task calls inside delegated child sessions by default", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "hirocode-task-nested-"));
		createdDirs.push(root);
		const parentSession = SessionManager.create(root, path.join(root, "sessions"));
		const child = createChildTaskSession(parentSession, {
			cwd: root,
			metadata: {
				agent: "general",
				agentSource: "built-in",
				allowSubagents: false,
			},
		});
		const childSession = SessionManager.open(child.sessionFile, parentSession.getSessionDir());
		const tool = createTaskToolDefinition(root, { getParentActiveToolNames: () => ["read", "bash", "task"] });

		await expect(
			tool.execute(
				"task-tool-nested",
				{
					description: "Nested task",
					prompt: "Try nested delegation",
					subagent_type: "general",
				},
				undefined,
				undefined,
				createToolContext(root, childSession),
			),
		).rejects.toThrow(
			"Nested subagents are disabled for delegated sessions. Set allowSubagents: true in the agent frontmatter to opt in.",
		);
	});

	it("respects fine-grained task permission rules for delegated child sessions", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "hirocode-task-permissions-"));
		createdDirs.push(root);
		const parentSession = SessionManager.create(root, path.join(root, "sessions"));
		const child = createChildTaskSession(parentSession, {
			cwd: root,
			metadata: {
				agent: "general",
				agentSource: "built-in",
				allowSubagents: true,
				taskPermissions: [{ pattern: "explore", action: "deny" }],
			},
		});
		const childSession = SessionManager.open(child.sessionFile, parentSession.getSessionDir());
		const tool = createTaskToolDefinition(root, { getParentActiveToolNames: () => ["read", "bash", "task"] });

		await expect(
			tool.execute(
				"task-tool-deny",
				{
					description: "Denied nested task",
					prompt: "Inspect auth",
					subagent_type: "explore",
				},
				undefined,
				undefined,
				createToolContext(root, childSession),
			),
		).rejects.toThrow("Subagent explore is not allowed by the current task permission policy.");
	});

	it("shows a collapsed preview with expand hint for long task output", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "hirocode-task-render-"));
		createdDirs.push(root);
		const tool = createTaskToolDefinition(root, { getParentActiveToolNames: () => ["read", "bash", "task"] });
		const component = new ToolExecutionComponent(
			"task",
			"tool-render-1",
			{
				description: "Inspect subagent implementation",
				prompt: "Analyze task rendering behavior",
				subagent_type: "explore",
			},
			{},
			tool,
			createFakeTui(),
		);
		component.markExecutionStarted();

		const longText = Array.from({ length: 20 }, (_, index) => `output line ${index + 1}`).join("\n");
		const assistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: longText }],
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		} as AssistantMessage;

		component.updateResult(
			{
				content: [{ type: "text", text: longText }],
				details: {
					agentScope: "user",
					projectAgentsDir: null,
					result: {
						taskId: "task-1",
						parentSessionId: "parent-1",
						sessionId: "task-1",
						sessionFile: path.join(root, "task-1.jsonl"),
						agent: "explore",
						agentSource: "built-in",
						task: "Analyze task rendering behavior",
						exitCode: 0,
						messages: [assistantMessage],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
					},
				},
				isError: false,
			},
			true,
		);

		const collapsed = component.render(100).join("\n");
		expect(collapsed).toContain("output line 20");
		expect(collapsed).toContain("to expand");
		expect(collapsed).not.toContain("output line 5");

		component.setExpanded(true);
		const expanded = component.render(100).join("\n");
		expect(expanded).toContain("output line 1");
		expect(expanded).toContain("output line 20");
	});
});
