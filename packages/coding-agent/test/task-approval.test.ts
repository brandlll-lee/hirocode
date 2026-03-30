import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
	createSessionSafetyServices,
	registerSessionSafetyServices,
	unregisterSessionSafetyServices,
} from "../src/core/approval/runtime-services.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createChildTaskSession } from "../src/core/subagents/task-sessions.js";

const { runDelegatedTaskMock } = vi.hoisted(() => ({
	runDelegatedTaskMock: vi.fn(),
}));

vi.mock("../src/core/subagents/task-runner.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/subagents/task-runner.js")>();
	return {
		...actual,
		runDelegatedTask: runDelegatedTaskMock,
	};
});

import { createTaskToolDefinition } from "../src/core/tools/task.js";

const createdDirs: string[] = [];

afterEach(() => {
	runDelegatedTaskMock.mockReset();
	while (createdDirs.length > 0) {
		fs.rmSync(createdDirs.pop()!, { recursive: true, force: true });
	}
});

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

function createDelegatedResult(options: {
	taskId: string;
	parentSessionId: string;
	sessionFile: string;
	agent: string;
	task: string;
	exitCode: number;
	errorMessage?: string;
}) {
	return {
		taskId: options.taskId,
		parentSessionId: options.parentSessionId,
		sessionId: options.taskId,
		sessionFile: options.sessionFile,
		agent: options.agent,
		agentSource: "built-in" as const,
		task: options.task,
		exitCode: options.exitCode,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		errorMessage: options.errorMessage,
	};
}

describe("task tool approvals", () => {
	test("uses the approval manager for delegated subagents", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "hirocode-task-approval-"));
		createdDirs.push(root);
		const sessionManager = SessionManager.create(root, path.join(root, "sessions"));
		const settingsManager = SettingsManager.inMemory({ approvalPolicy: "always-ask", autonomyMode: "normal" });
		const services = createSessionSafetyServices({
			sessionManager,
			settingsManager,
			approvalMode: "interactive",
		});
		registerSessionSafetyServices(sessionManager, services);

		const tool = createTaskToolDefinition(root, { getParentActiveToolNames: () => ["read", "bash", "task"] });
		const execution = tool.execute(
			"task-approval-1",
			{
				description: "Inspect auth",
				prompt: "Find auth code",
				subagent_type: "explore",
			},
			undefined,
			undefined,
			createToolContext(root, sessionManager),
		);

		const pending = services.approval.getPendingRequests()[0];
		expect(pending?.subject.permission).toBe("task");
		expect(pending?.subject.pattern).toBe("explore");

		services.approval.resolve({
			requestId: pending!.id,
			action: "deny",
			scope: "once",
			reason: "Rejected in test",
		});

		const result = await execution;
		expect(result.content[0]?.type).toBe("text");
		expect((result.content[0] as { type: "text"; text: string }).text).toContain("was not approved");

		unregisterSessionSafetyServices(sessionManager);
		await services.dispose();
	});

	test("bridges delegated child approvals through the parent approval manager", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "hirocode-task-delegated-approval-"));
		createdDirs.push(root);
		const sessionManager = SessionManager.create(root, path.join(root, "sessions"));
		const settingsManager = SettingsManager.inMemory({ approvalPolicy: "always-ask", autonomyMode: "normal" });
		const services = createSessionSafetyServices({
			sessionManager,
			settingsManager,
			approvalMode: "interactive",
		});
		registerSessionSafetyServices(sessionManager, services);

		runDelegatedTaskMock.mockImplementation(async (options) => {
			const decision = await options.approvalHandler?.({
				requestId: "child-approval-1",
				summary: "Run npm test",
				kind: "bash",
				taskId: options.sessionRef.taskId,
				sessionId: options.sessionRef.sessionId,
				sessionFile: options.sessionRef.sessionFile,
				agent: options.agent.name,
			});
			return createDelegatedResult({
				taskId: options.sessionRef.taskId,
				parentSessionId: options.sessionRef.parentSessionId,
				sessionFile: options.sessionRef.sessionFile,
				agent: options.agent.name,
				task: options.task,
				exitCode: decision?.approved === false ? 1 : 0,
				errorMessage: decision?.approved === false ? decision.reason : undefined,
			});
		});

		const tool = createTaskToolDefinition(root, { getParentActiveToolNames: () => ["read", "bash", "task"] });
		const execution = tool.execute(
			"task-approval-bridge-1",
			{
				description: "Inspect auth",
				prompt: "Find auth code",
				subagent_type: "explore",
			},
			undefined,
			undefined,
			createToolContext(root, sessionManager),
		);

		const initialApproval = services.approval.getPendingRequests()[0];
		expect(initialApproval?.subject.permission).toBe("task");
		services.approval.resolve({
			requestId: initialApproval!.id,
			action: "allow",
			scope: "once",
		});

		for (let attempt = 0; attempt < 20; attempt += 1) {
			if (services.approval.getPendingRequests().length === 1) {
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 10));
		}

		const childApproval = services.approval.getPendingRequests()[0];
		expect(childApproval?.subject.permission).toBe("bash");
		expect(childApproval?.subject.tags).toContain("child-approval");
		expect(childApproval?.subject.tags).toContain("explicit-approval-required");
		expect(childApproval?.subject.displayTarget).toBe("Run npm test");

		services.approval.resolve({
			requestId: childApproval!.id,
			action: "deny",
			scope: "once",
			reason: "Rejected child approval",
		});

		const result = await execution;
		expect(runDelegatedTaskMock).toHaveBeenCalledOnce();
		expect(result.content[0]?.type).toBe("text");
		expect((result.content[0] as { type: "text"; text: string }).text).toContain("Rejected child approval");

		unregisterSessionSafetyServices(sessionManager);
		await services.dispose();
	});

	test("fails fast when delegated child approvals cannot be reviewed by the parent runtime", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "hirocode-task-headless-delegated-approval-"));
		createdDirs.push(root);
		const sessionManager = SessionManager.create(root, path.join(root, "sessions"));
		const existingTask = createChildTaskSession(sessionManager, {
			cwd: root,
			metadata: {
				agent: "explore",
				agentSource: "built-in",
			},
		});

		runDelegatedTaskMock.mockImplementation(async (options) => {
			expect(options.approvalHandler).toBeDefined();
			const decision = await options.approvalHandler?.({
				requestId: "child-approval-headless",
				summary: "Fetch external docs",
				kind: "webfetch",
				taskId: options.sessionRef.taskId,
				sessionId: options.sessionRef.sessionId,
				sessionFile: options.sessionRef.sessionFile,
				agent: options.agent.name,
			});
			return createDelegatedResult({
				taskId: options.sessionRef.taskId,
				parentSessionId: options.sessionRef.parentSessionId,
				sessionFile: options.sessionRef.sessionFile,
				agent: options.agent.name,
				task: options.task,
				exitCode: 1,
				errorMessage: decision?.reason,
			});
		});

		const tool = createTaskToolDefinition(root, { getParentActiveToolNames: () => ["read", "bash", "task"] });
		const result = await tool.execute(
			"task-approval-headless-1",
			{
				description: "Resume web lookup",
				prompt: "Continue reading docs",
				subagent_type: "explore",
				task_id: existingTask.taskId,
			},
			undefined,
			undefined,
			createToolContext(root, sessionManager),
		);

		expect(runDelegatedTaskMock).toHaveBeenCalledOnce();
		expect(result.content[0]?.type).toBe("text");
		expect((result.content[0] as { type: "text"; text: string }).text).toContain(
			"parent runtime cannot review delegated approvals",
		);
	});
});
