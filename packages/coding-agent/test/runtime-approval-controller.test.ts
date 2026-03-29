import { describe, expect, test } from "vitest";
import { getSessionSafetyServices } from "../src/core/approval/runtime-services.js";
import type { RuntimeProtocolEvent } from "../src/core/protocol/types.js";
import { SessionRuntimeController } from "../src/core/runtime/session-runtime-controller.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";

function createSessionStub() {
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
		sessionId: sessionManager.getSessionId(),
		sessionName: undefined,
		autoCompactionEnabled: true,
		messages: [],
		pendingMessageCount: 0,
		getActiveToolNames: () => ["read", "bash", "task"],
		bindExtensions: async () => {},
		subscribe: () => () => {},
		promptTemplates: [],
		resourceLoader: {
			getSkills: () => ({ skills: [] }),
		},
		extensionRunner: undefined,
	} as never;
	return { session, sessionManager };
}

describe("SessionRuntimeController approvals", () => {
	test("bridges approval requests and approve/reject commands", async () => {
		const fixture = createSessionStub();
		const controller = new SessionRuntimeController({
			session: fixture.session,
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
		});
		const events: RuntimeProtocolEvent[] = [];
		controller.subscribe((event) => events.push(event));

		await controller.start();
		const services = getSessionSafetyServices(fixture.sessionManager);
		expect(services).toBeDefined();

		const pending = services!.approval.request({
			permission: "task",
			pattern: "explore",
			normalizedPattern: "explore",
			level: "high",
			summary: "Approve delegated subagent explore",
			justification: "Delegated subagents can execute tools independently.",
			tags: ["delegation"],
			displayTarget: "explore",
		});

		const requested = events.find(
			(event): event is Extract<RuntimeProtocolEvent, { type: "approval_requested" }> =>
				event.type === "approval_requested",
		);
		expect(requested?.requestId).toBeDefined();
		expect(requested?.kind).toBe("task");

		await controller.execute({ type: "approve", requestId: requested!.requestId });
		const result = await pending;
		expect(result.allowed).toBe(true);

		const resolved = events.find(
			(event): event is Extract<RuntimeProtocolEvent, { type: "approval_resolved" }> =>
				event.type === "approval_resolved",
		);
		expect(resolved).toMatchObject({ approved: true, requestId: requested!.requestId });

		controller.dispose();
	});
});
