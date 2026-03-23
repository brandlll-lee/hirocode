import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createTaskReference,
	extractStoredTaskReferences,
	findStoredTaskReferenceInBranch,
	findStoredTaskReferenceOnDisk,
	formatTaskToolOutput,
	initializeTaskSession,
	persistTaskReference,
} from "../examples/extensions/subagent/task-persistence.js";

const AGENT_DIR_ENV = "HIROCODE_CODING_AGENT_DIR";
const originalAgentDir = process.env[AGENT_DIR_ENV];

afterEach(() => {
	if (originalAgentDir === undefined) delete process.env[AGENT_DIR_ENV];
	else process.env[AGENT_DIR_ENV] = originalAgentDir;
});

describe("subagent task persistence", () => {
	it("creates and reloads task references from disk metadata", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "hirocode-subagent-persist-"));
		process.env[AGENT_DIR_ENV] = cwd;

		const reference = createTaskReference("parent-session", {
			agent: "scout",
			agentSource: "user",
			allowSubagents: false,
			provider: "openai",
			model: "gpt-5.4",
			tools: ["read", "grep"],
			systemPrompt: "Scout the codebase.",
		});

		expect(reference.sessionId).toBe(reference.taskId);
		initializeTaskSession(reference, cwd, "/tmp/parent.jsonl");
		const header = JSON.parse(fs.readFileSync(reference.sessionFile, "utf-8").trim()) as {
			id: string;
			cwd: string;
			parentSession?: string;
		};
		expect(header).toMatchObject({
			id: reference.taskId,
			cwd,
			parentSession: "/tmp/parent.jsonl",
		});

		persistTaskReference({ ...reference, sessionId: "child-session" });

		const loaded = findStoredTaskReferenceOnDisk(reference.taskId, "parent-session");
		expect(loaded).toEqual({ ...reference, sessionId: "child-session" });
		expect(findStoredTaskReferenceOnDisk("child-session", "parent-session")).toEqual({
			...reference,
			sessionId: "child-session",
		});
	});

	it("extracts task references from stored tool result details and branch history", () => {
		const details = {
			mode: "parallel",
			results: [
				{
					taskId: "task-a",
					parentSessionId: "parent-1",
					agent: "planner",
					agentSource: "project",
					sessionFile: "/tmp/task-a.jsonl",
					metadataFile: "/tmp/task-a.json",
					sessionId: "child-a",
					provider: "openai",
					model: "gpt-5.4",
				},
			],
		};

		expect(extractStoredTaskReferences(details)).toEqual([
			{
				taskId: "task-a",
				parentSessionId: "parent-1",
				agent: "planner",
				agentSource: "project",
				sessionFile: "/tmp/task-a.jsonl",
				metadataFile: "/tmp/task-a.json",
				sessionId: "child-a",
				provider: "openai",
				model: "gpt-5.4",
			},
		]);

		const branch = [
			{ type: "custom" },
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "task",
					details,
				},
			},
		];

		expect(findStoredTaskReferenceInBranch(branch, "task-a")?.sessionId).toBe("child-a");
	});

	it("formats Task tool output with task and subagent ids", () => {
		expect(formatTaskToolOutput({ taskId: "task-1", sessionId: "subagent-1" }, "done")).toBe(
			"task_id: task-1\nsubagent_id: subagent-1\n\n<task_result>\ndone\n</task_result>",
		);
	});
});
