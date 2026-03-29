import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentMessage } from "@hirocode/agent-core";
import { getModel } from "@hirocode/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createTestResourceLoader } from "./utilities.js";

describe("AgentSession custom trigger turns", () => {
	let session: AgentSession;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `hirocode-custom-turn-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });

		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
			},
		});
		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir);

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});
	});

	afterEach(() => {
		session.dispose();
		vi.restoreAllMocks();
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("starts a turn from a hidden custom message without appending a user message", async () => {
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue();

		await session.sendCustomMessage(
			{
				customType: "spec-mode-context",
				content: "[EXECUTING APPROVED SPEC]",
				display: false,
			},
			{ triggerTurn: true },
		);

		expect(promptSpy).toHaveBeenCalledTimes(1);

		const firstCall = promptSpy.mock.calls[0]?.[0];
		const turnMessages = (Array.isArray(firstCall) ? firstCall : [firstCall]) as AgentMessage[];

		expect(turnMessages).toHaveLength(1);
		expect(turnMessages[0]).toMatchObject({
			role: "custom",
			customType: "spec-mode-context",
			display: false,
		});
		expect(turnMessages.some((message) => message.role === "user")).toBe(false);
	});
});
