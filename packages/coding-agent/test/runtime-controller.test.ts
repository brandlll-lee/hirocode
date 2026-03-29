import { describe, expect, test } from "vitest";
import type { AgentSession, AgentSessionEvent } from "../src/core/agent-session.js";
import { RUNTIME_SESSION_METADATA_TYPE } from "../src/core/protocol/session-metadata.js";
import type { RuntimeProtocolEvent } from "../src/core/protocol/types.js";
import { SessionRuntimeController } from "../src/core/runtime/session-runtime-controller.js";
import { type CustomEntry, SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";

function createControllerFixture() {
	const events: RuntimeProtocolEvent[] = [];
	let sessionListener: ((event: AgentSessionEvent) => void) | undefined;
	const sessionManager = SessionManager.inMemory();
	const settingsManager = SettingsManager.inMemory({ approvalPolicy: "always-ask", autonomyMode: "normal" });

	const session = {
		sessionManager,
		settingsManager,
		agent: {
			waitForIdle: async () => {},
		},
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
		messages: [],
		pendingMessageCount: 0,
		getActiveToolNames: () => ["read", "bash", "task"],
		bindExtensions: async () => {},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			sessionListener = listener;
			return () => {
				sessionListener = undefined;
			};
		},
		promptTemplates: [],
		resourceLoader: {
			getSkills: () => ({ skills: [] }),
		},
		extensionRunner: undefined,
	} as unknown as AgentSession;

	const controller = new SessionRuntimeController({
		session,
		mode: "rpc",
		clientCapabilities: {
			approvalUi: true,
			missionControl: false,
			mcpManager: false,
			specReview: false,
			widgets: true,
			customUi: false,
			themeControl: false,
		},
		initialMetadata: {
			tags: ["phase-1"],
			activeAgents: ["general"],
		},
	});
	controller.subscribe((event) => events.push(event));

	return {
		controller,
		events,
		get entries() {
			return sessionManager.getEntries().filter((entry): entry is CustomEntry => entry.type === "custom");
		},
		emitSessionEvent: (event: AgentSessionEvent) => sessionListener?.(event),
	};
}

describe("SessionRuntimeController", () => {
	test("emits bootstrap protocol events and persists runtime metadata", async () => {
		const fixture = createControllerFixture();

		await fixture.controller.start();
		const bootstrap = fixture.events.find(
			(event): event is Extract<RuntimeProtocolEvent, { type: "session_state" }> => event.type === "session_state",
		);

		expect(fixture.events[0]?.type).toBe("protocol_ready");
		expect(fixture.events[1]?.type).toBe("session_state");
		expect(bootstrap?.state.metadata.tags).toEqual(["phase-1"]);
		expect(bootstrap?.state.metadata.activeAgents).toEqual(["general"]);

		expect(fixture.entries).toHaveLength(1);
		expect(fixture.entries[0]?.customType).toBe(RUNTIME_SESSION_METADATA_TYPE);
		expect(fixture.entries[0]?.data).toMatchObject({
			protocolVersion: 1,
			metadata: { mode: "rpc", tags: ["phase-1"], activeAgents: ["general"] },
			capabilities: { clientKind: "rpc", approvalUi: true, widgets: true },
		});
	});

	test("decorates task tool lifecycle as subtask events", async () => {
		const fixture = createControllerFixture();

		await fixture.controller.start();

		fixture.emitSessionEvent({
			type: "tool_execution_start",
			toolCallId: "tool-1",
			toolName: "task",
			args: {
				subagent_type: "explore",
				description: "Inspect the repo",
				prompt: "Find all CLI entrypoints",
				task_id: "task-1",
			},
		});

		fixture.emitSessionEvent({
			type: "tool_execution_update",
			toolCallId: "tool-1",
			toolName: "task",
			args: {},
			partialResult: {
				content: [{ type: "text", text: "Scanning package layout" }],
				details: {
					result: {
						taskId: "task-1",
						sessionId: "subagent-1",
						agent: "explore",
						messages: [],
					},
				},
			},
		});

		fixture.emitSessionEvent({
			type: "tool_execution_end",
			toolCallId: "tool-1",
			toolName: "task",
			result: {
				content: [{ type: "text", text: "Done" }],
				details: {
					result: {
						taskId: "task-1",
						sessionId: "subagent-1",
						agent: "explore",
						exitCode: 0,
						messages: [],
						stopReason: "stop",
					},
				},
			},
			isError: false,
		});

		const started = fixture.events.find((event) => event.type === "subtask_started");
		const updated = fixture.events.find((event) => event.type === "subtask_updated");
		const finished = fixture.events.find((event) => event.type === "subtask_finished");

		expect(started).toMatchObject({
			type: "subtask_started",
			toolCallId: "tool-1",
			agent: "explore",
			taskId: "task-1",
			resumed: true,
		});
		expect(updated).toMatchObject({
			type: "subtask_updated",
			toolCallId: "tool-1",
			taskId: "task-1",
			subtaskSessionId: "subagent-1",
			summary: "Scanning package layout",
		});
		expect(finished).toMatchObject({
			type: "subtask_finished",
			toolCallId: "tool-1",
			taskId: "task-1",
			subtaskSessionId: "subagent-1",
			status: "completed",
		});
	});
});
