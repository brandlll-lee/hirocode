import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { SessionManager } from "../src/core/session-manager.js";
import { writeSpecState } from "../src/core/spec/state.js";
import { getDelegatedTaskOutput, runDelegatedTask } from "../src/core/subagents/task-runner.js";
import { createTaskToolDefinition } from "../src/core/tools/task.js";

const tempDirs: string[] = [];

vi.mock("../src/core/subagents/task-runner.js", () => ({
	runDelegatedTask: vi.fn(async () => ({
		taskId: "task-1",
		parentSessionId: "parent-1",
		sessionId: "child-1",
		sessionFile: "/tmp/child-1.jsonl",
		agent: "explore",
		agentSource: "built-in",
		task: "Investigate the change",
		exitCode: 0,
		messages: [{ role: "assistant", content: [{ type: "text", text: "delegated work complete" }] }],
		stderr: "",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			contextTokens: 0,
			turns: 1,
		},
	})),
	getDelegatedTaskOutput: vi.fn(() => "delegated work complete"),
}));

afterEach(() => {
	while (tempDirs.length > 0) {
		fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
	}
	vi.clearAllMocks();
});

function createToolContext(root: string, sessionManager: SessionManager, hasUI: boolean) {
	return {
		cwd: root,
		hasUI,
		ui: {
			notify: () => {},
			confirm: async () => true,
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

describe("spec-mode task guard", () => {
	test("blocks execution subagents during planning and points to the allowed read-only agents", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "hirocode-spec-task-guard-"));
		tempDirs.push(root);
		const sessionManager = SessionManager.create(root, path.join(root, "sessions"));
		writeSpecState(sessionManager, {
			id: "spec-1",
			phase: "planning",
			previousActiveTools: ["read", "bash", "edit", "write", "task"],
		});

		const tool = createTaskToolDefinition(root, { getParentActiveToolNames: () => ["read", "bash", "task"] });
		const result = await tool.execute(
			"task-1",
			{
				description: "Do the work",
				prompt: "Implement the change",
				subagent_type: "general",
			},
			undefined,
			undefined,
			createToolContext(root, sessionManager, false),
		);

		expect(result.content[0]?.type).toBe("text");
		expect((result.content[0] as { type: "text"; text: string }).text).toContain(
			"Allowed read-only agents: planner, explore, reviewer",
		);
		expect(vi.mocked(runDelegatedTask)).not.toHaveBeenCalled();
	});

	test("allows the read-only explore agent during planning", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "hirocode-spec-task-guard-inactive-"));
		tempDirs.push(root);
		const sessionManager = SessionManager.create(root, path.join(root, "sessions"));
		writeSpecState(sessionManager, {
			id: "spec-legacy-hidden",
			phase: "planning",
			request: "Plan the next change",
			previousActiveTools: ["read", "bash", "edit", "write", "task"],
		});

		const tool = createTaskToolDefinition(root, { getParentActiveToolNames: () => ["read", "bash", "task"] });
		const result = await tool.execute(
			"task-2",
			{
				description: "Investigate the current behavior",
				prompt: "Trace the current implementation",
				subagent_type: "explore",
			},
			undefined,
			undefined,
			createToolContext(root, sessionManager, true),
		);

		expect(result.content[0]?.type).toBe("text");
		expect((result.content[0] as { type: "text"; text: string }).text).not.toContain(
			"cannot run during specification mode",
		);
		expect(vi.mocked(runDelegatedTask)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(getDelegatedTaskOutput)).toHaveBeenCalled();
	});
});
