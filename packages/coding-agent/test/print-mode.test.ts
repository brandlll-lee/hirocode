import type { AssistantMessage, Message, Usage } from "@hirocode/ai";
import { describe, expect, test } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import { TERMINAL_BENCHMARK_PROFILE } from "../src/core/benchmark-profile.js";
import { runPrintMode } from "../src/modes/print-mode.js";

const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
	},
};

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-5.4",
		usage,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("runPrintMode", () => {
	test("forces a verification prompt in benchmark mode", async () => {
		const prompts: string[] = [];
		const messages: Message[] = [];
		const logs: string[] = [];
		const originalLog = console.log;

		const session = {
			sessionManager: { getHeader: () => undefined },
			state: { messages },
			bindExtensions: async () => {},
			subscribe: () => () => {},
			prompt: async (text: string) => {
				prompts.push(text);
				messages.push({
					role: "user",
					content: text,
					timestamp: Date.now(),
				});
				messages.push(
					createAssistantMessage(
						text.includes("Verification pass") ? "Verified final answer" : "Initial answer before verification",
					),
				);
			},
		} as unknown as AgentSession;

		console.log = ((...args: unknown[]) => {
			logs.push(args.map((value) => String(value)).join(" "));
		}) as typeof console.log;

		try {
			await runPrintMode(session, {
				mode: "text",
				initialMessage: "Do the task",
				runtimeProfile: TERMINAL_BENCHMARK_PROFILE,
			});
		} finally {
			console.log = originalLog;
		}

		expect(prompts).toHaveLength(2);
		expect(prompts[0]).toBe("Do the task");
		expect(prompts[1]).toContain("Verification pass");
		expect(logs.join("")).toContain("Verified final answer");
	});

	test("does not force verification without a runtime profile", async () => {
		const prompts: string[] = [];
		const messages: Message[] = [];
		const logs: string[] = [];
		const originalLog = console.log;

		const session = {
			sessionManager: { getHeader: () => undefined },
			state: { messages },
			bindExtensions: async () => {},
			subscribe: () => () => {},
			prompt: async (text: string) => {
				prompts.push(text);
				messages.push({
					role: "user",
					content: text,
					timestamp: Date.now(),
				});
				messages.push(createAssistantMessage("Single-pass answer"));
			},
		} as unknown as AgentSession;

		console.log = ((...args: unknown[]) => {
			logs.push(args.map((value) => String(value)).join(" "));
		}) as typeof console.log;

		try {
			await runPrintMode(session, {
				mode: "text",
				initialMessage: "Do the task",
			});
		} finally {
			console.log = originalLog;
		}

		expect(prompts).toEqual(["Do the task"]);
		expect(logs.join("")).toContain("Single-pass answer");
	});
});
