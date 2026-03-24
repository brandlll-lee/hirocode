import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	findStoredTaskReferenceOnDisk,
	formatTaskReferenceLines,
	isSubagentSessionFile,
} from "../examples/extensions/subagent/task-persistence.js";

const AGENT_DIR_ENV = "HIROCODE_CODING_AGENT_DIR";
const originalAgentDir = process.env[AGENT_DIR_ENV];

afterEach(() => {
	if (originalAgentDir === undefined) delete process.env[AGENT_DIR_ENV];
	else process.env[AGENT_DIR_ENV] = originalAgentDir;
});

describe("subagent task persistence", () => {
	it("reloads legacy task references from disk metadata", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "hirocode-subagent-persist-"));
		process.env[AGENT_DIR_ENV] = cwd;
		const taskDir = path.join(cwd, "subagents", "parent-session");
		const sessionFile = path.join(taskDir, "task-task-a.jsonl");
		const metadataFile = path.join(taskDir, "task-task-a.json");
		fs.mkdirSync(taskDir, { recursive: true });
		fs.writeFileSync(sessionFile, '{"type":"session","id":"task-a"}\n', "utf-8");
		fs.writeFileSync(
			metadataFile,
			`${JSON.stringify(
				{
					taskId: "task-a",
					parentSessionId: "parent-session",
					agent: "scout",
					agentSource: "user",
					allowSubagents: false,
					provider: "openai",
					model: "gpt-5.4",
					tools: ["read", "grep"],
					systemPrompt: "Scout the codebase.",
					sessionFile,
					metadataFile,
					sessionId: "child-session",
				},
				null,
				2,
			)}\n`,
			"utf-8",
		);

		const loaded = findStoredTaskReferenceOnDisk("task-a", "parent-session");
		expect(loaded).toEqual({
			taskId: "task-a",
			parentSessionId: "parent-session",
			agent: "scout",
			agentSource: "user",
			allowSubagents: false,
			provider: "openai",
			model: "gpt-5.4",
			tools: ["read", "grep"],
			systemPrompt: "Scout the codebase.",
			sessionFile,
			metadataFile,
			sessionId: "child-session",
		});
		expect(findStoredTaskReferenceOnDisk("child-session", "parent-session")).toEqual({
			sessionId: "child-session",
			taskId: "task-a",
			parentSessionId: "parent-session",
			agent: "scout",
			agentSource: "user",
			allowSubagents: false,
			provider: "openai",
			model: "gpt-5.4",
			tools: ["read", "grep"],
			systemPrompt: "Scout the codebase.",
			sessionFile,
			metadataFile,
		});
	});

	it("detects legacy subagent session files", () => {
		const root = path.join(os.tmpdir(), "hirocode-subagent-legacy-root");
		process.env[AGENT_DIR_ENV] = root;
		const legacyFile = path.join(root, "subagents", "parent-session", "task-1.jsonl");
		expect(isSubagentSessionFile(legacyFile)).toBe(true);
		expect(isSubagentSessionFile(path.join(root, "sessions", "session.jsonl"))).toBe(false);
	});

	it("formats task references with task and subagent ids", () => {
		expect(formatTaskReferenceLines({ taskId: "task-1", sessionId: "subagent-1" })).toEqual([
			"task_id: task-1",
			"subagent_id: subagent-1",
		]);
	});
});
