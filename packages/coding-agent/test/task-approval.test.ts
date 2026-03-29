import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	createSessionSafetyServices,
	registerSessionSafetyServices,
	unregisterSessionSafetyServices,
} from "../src/core/approval/runtime-services.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createTaskToolDefinition } from "../src/core/tools/task.js";

const createdDirs: string[] = [];

afterEach(() => {
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
});
