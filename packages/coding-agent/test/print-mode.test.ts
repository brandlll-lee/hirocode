import type { AssistantMessage, Message, Usage } from "@hirocode/ai";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AgentSession, AgentSessionEvent } from "../src/core/agent-session.js";
import { TERMINAL_BENCHMARK_PROFILE } from "../src/core/benchmark-profile.js";
import { type CustomEntry, SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
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

function createSessionStub(responseForPrompt: (text: string) => string) {
	const prompts: string[] = [];
	const messages: Message[] = [];
	const emittedEvents: AgentSessionEvent[] = [];
	let listener: ((event: AgentSessionEvent) => void) | undefined;
	const sessionManager = SessionManager.inMemory();
	const settingsManager = SettingsManager.inMemory({ approvalPolicy: "always-ask", autonomyMode: "normal" });

	const session = {
		sessionManager,
		settingsManager,
		agent: {
			waitForIdle: async () => {},
		},
		state: { messages },
		messages,
		model: undefined,
		thinkingLevel: "medium",
		isStreaming: false,
		isCompacting: false,
		steeringMode: "all",
		followUpMode: "all",
		sessionFile: "session.jsonl",
		sessionId: "session-1",
		sessionName: undefined,
		autoCompactionEnabled: true,
		pendingMessageCount: 0,
		getActiveToolNames: () => ["read", "bash", "task"],
		bindExtensions: async () => {},
		subscribe: (next: (event: AgentSessionEvent) => void) => {
			listener = next;
			return () => {
				listener = undefined;
			};
		},
		prompt: async (text: string) => {
			prompts.push(text);
			const userMessage = {
				role: "user" as const,
				content: text,
				timestamp: Date.now(),
			};
			const assistantMessage = createAssistantMessage(responseForPrompt(text));
			messages.push(userMessage, assistantMessage);
			const events: AgentSessionEvent[] = [
				{ type: "message_start", message: userMessage },
				{ type: "message_end", message: userMessage },
				{ type: "message_start", message: assistantMessage },
				{ type: "message_end", message: assistantMessage },
				{ type: "agent_end", messages: [userMessage, assistantMessage] },
			];
			for (const event of events) {
				emittedEvents.push(event);
				listener?.(event);
			}
		},
	} as unknown as AgentSession;

	return {
		session,
		prompts,
		messages,
		emittedEvents,
		get customEntries() {
			return sessionManager.getEntries().filter((entry): entry is CustomEntry => entry.type === "custom");
		},
	};
}

describe("runPrintMode", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("forces a verification prompt in benchmark mode", async () => {
		const logs: string[] = [];
		const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			logs.push(args.map((value) => String(value)).join(" "));
		});
		const { session, prompts } = createSessionStub((text) =>
			text.includes("Verification pass") ? "Verified final answer" : "Initial answer before verification",
		);

		await runPrintMode(session, {
			mode: "text",
			initialMessage: "Do the task",
			runtimeProfile: TERMINAL_BENCHMARK_PROFILE,
		});

		expect(log).toHaveBeenCalled();
		expect(prompts).toHaveLength(2);
		expect(prompts[0]).toBe("Do the task");
		expect(prompts[1]).toContain("Verification pass");
		expect(logs.join("")).toContain("Verified final answer");
	});

	test("does not force verification without a runtime profile", async () => {
		const logs: string[] = [];
		const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			logs.push(args.map((value) => String(value)).join(" "));
		});
		const { session, prompts } = createSessionStub(() => "Single-pass answer");

		await runPrintMode(session, {
			mode: "text",
			initialMessage: "Do the task",
		});

		expect(log).toHaveBeenCalled();
		expect(prompts).toEqual(["Do the task"]);
		expect(logs.join("")).toContain("Single-pass answer");
	});

	test("streams protocol bootstrap and runtime events in json mode", async () => {
		const lines: string[] = [];
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			lines.push(args.map((value) => String(value)).join(" "));
		});
		const { session } = createSessionStub(() => "JSON mode answer");

		await runPrintMode(session, {
			mode: "json",
			initialMessage: "Describe the runtime",
		});

		const parsed = lines.map((line) => JSON.parse(line));
		const ready = parsed.find((entry) => entry.type === "protocol_ready");
		const bootstrap = parsed.find((entry) => entry.type === "session_state");
		const assistantEnd = parsed.find((entry) => entry.type === "message_end" && entry.message?.role === "assistant");

		expect(ready.protocolVersion).toBe(1);
		expect(ready.runtimeMode).toBe("json");
		expect(ready.supportedCommands).toContain("prompt");
		expect(bootstrap.state.metadata.mode).toBe("json");
		expect(bootstrap.state.capabilities.clientKind).toBe("json");
		expect(assistantEnd.protocolVersion).toBe(1);
		expect(assistantEnd.runtimeMode).toBe("json");
	});
});
