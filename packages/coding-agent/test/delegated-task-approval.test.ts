import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const { spawnMock, updateTaskSessionStateMock } = vi.hoisted(() => ({
	spawnMock: vi.fn(),
	updateTaskSessionStateMock: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		spawn: spawnMock,
	};
});

vi.mock("../src/core/subagents/invocation.js", () => ({
	resolveAgentInvocation: (args: string[]) => ({ command: "hirocode", args }),
	resolveEffectiveSubagentModel: () => ({
		provider: "openai",
		modelId: "gpt-5.4",
		modelArg: "openai/gpt-5.4",
	}),
	writePromptToTempFile: vi.fn(),
}));

vi.mock("../src/core/subagents/task-sessions.js", () => ({
	updateTaskSessionState: updateTaskSessionStateMock,
}));

import { runDelegatedTask } from "../src/core/subagents/task-runner.js";

afterEach(() => {
	spawnMock.mockReset();
	updateTaskSessionStateMock.mockReset();
});

describe("delegated task approval bridge", () => {
	it("routes delegated approvals through the provided handler", async () => {
		spawnMock.mockImplementation((_command: string, args: string[]) => createRpcProcess(args));

		const approvalHandler = vi.fn().mockResolvedValue({ approved: true });
		const result = await runDelegatedTask({
			sessionRef: {
				taskId: "task-1",
				parentSessionId: "parent-1",
				sessionId: "session-1",
				sessionFile: "child.jsonl",
			},
			agent: {
				name: "general",
				description: "General worker",
				source: "built-in",
				systemPrompt: "",
			},
			task: "Implement feature",
			defaultCwd: "F:/CodeHub/leehub/hirocode",
			parentActiveToolNames: ["read", "bash"],
			approvalHandler,
		});

		expect(spawnMock).toHaveBeenCalledWith(
			"hirocode",
			expect.arrayContaining(["--mode", "rpc", "--session", "child.jsonl"]),
			expect.anything(),
		);
		expect(approvalHandler).toHaveBeenCalledWith(
			expect.objectContaining({
				requestId: "req-1",
				summary: "Run npm test",
				kind: "bash",
				taskId: "task-1",
				sessionFile: "child.jsonl",
				agent: "general",
			}),
		);
		expect(result.exitCode).toBe(0);
		expect(result.messages).toHaveLength(1);
		expect(updateTaskSessionStateMock).toHaveBeenCalledWith(
			"child.jsonl",
			expect.objectContaining({ status: "completed" }),
		);
	});
});

function createRpcProcess(args: string[]) {
	expect(args).toContain("rpc");

	const stdout = new PassThrough();
	const stderr = new PassThrough();
	const stdin = new PassThrough();
	const proc = new EventEmitter() as EventEmitter & {
		stdout: PassThrough;
		stderr: PassThrough;
		stdin: PassThrough;
		killed: boolean;
		kill: (signal?: string) => boolean;
	};

	let promptResponseId: string | undefined;
	let inputBuffer = "";

	proc.stdout = stdout;
	proc.stderr = stderr;
	proc.stdin = stdin;
	proc.killed = false;
	proc.kill = () => {
		if (!proc.killed) {
			proc.killed = true;
			setTimeout(() => proc.emit("close", 0), 0);
		}
		return true;
	};

	stdin.on("data", (chunk) => {
		inputBuffer += chunk.toString();
		const lines = inputBuffer.split("\n");
		inputBuffer = lines.pop() || "";
		for (const line of lines) {
			if (!line.trim()) {
				continue;
			}
			const command = JSON.parse(line) as {
				id?: string;
				type: string;
				requestId?: string;
			};
			if (command.type === "prompt") {
				promptResponseId = command.id;
				stdout.write(
					`${JSON.stringify({
						type: "approval_requested",
						requestId: "req-1",
						summary: "Run npm test",
						kind: "bash",
					})}\n`,
				);
				continue;
			}
			if (command.type === "approve") {
				stdout.write(
					`${JSON.stringify({
						id: command.id,
						protocolVersion: 1,
						type: "response",
						command: "approve",
						success: true,
					})}\n`,
				);
				stdout.write(
					`${JSON.stringify({
						type: "message_end",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "done" }],
							usage: {
								input: 1,
								output: 1,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 2,
								cost: { total: 0.1 },
							},
							stopReason: "end_turn",
							model: "gpt-5.4",
							provider: "openai",
						},
					})}\n`,
				);
				// agent_end signals the parent that all LLM work is complete
				stdout.write(`${JSON.stringify({ type: "agent_end", messages: [] })}\n`);
				stdout.write(
					`${JSON.stringify({
						id: promptResponseId,
						protocolVersion: 1,
						type: "response",
						command: "prompt",
						success: true,
					})}\n`,
				);
			}
		}
	});

	return proc;
}
