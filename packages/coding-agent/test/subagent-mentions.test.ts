import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentMessage } from "@hirocode/agent-core";
import { getModel } from "@hirocode/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession, extractExplicitSubagentNames } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createTestResourceLoader } from "./utilities.js";

describe("subagent mentions", () => {
	let session: AgentSession;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `hirocode-subagent-mentions-${Date.now()}`);
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
			initialActiveToolNames: ["read", "bash", "edit", "write", "webfetch", "websearch", "task", "todowrite"],
		});
	});

	afterEach(() => {
		session.dispose();
		vi.restoreAllMocks();
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("includes available subagents in the base system prompt when task is active", () => {
		expect(session.systemPrompt).toContain("# Available Subagents");
		expect(session.systemPrompt).toContain("- web (built-in):");
		expect(session.systemPrompt).toContain("- explore (built-in):");
	});

	it("injects a system note for explicit @agent requests without changing the user text", async () => {
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue();
		const setSystemPromptSpy = vi.spyOn(session.agent, "setSystemPrompt");

		await session.prompt("Please use @web to inspect the docs.");

		expect(promptSpy).toHaveBeenCalledTimes(1);
		const promptArg = promptSpy.mock.calls[0]?.[0];
		const turnMessages = (Array.isArray(promptArg) ? promptArg : [promptArg]) as unknown as AgentMessage[];
		const firstMessage = turnMessages[0];
		expect(firstMessage?.role).toBe("user");
		if (!firstMessage || firstMessage.role !== "user") {
			throw new Error("Expected first prompt message to be a user message.");
		}
		expect((firstMessage.content[0] as { type: "text"; text: string }).text).toBe(
			"Please use @web to inspect the docs.",
		);
		expect(setSystemPromptSpy).toHaveBeenCalled();
		expect(setSystemPromptSpy.mock.lastCall?.[0]).toContain(
			"The user explicitly requested the following subagent(s): web.",
		);
	});

	it("ignores unknown names, email addresses, and paths when parsing explicit agent references", () => {
		expect(
			extractExplicitSubagentNames("mail foo@bar.com about @hirocode/docs, @missing, and @web please", [
				"explore",
				"web",
			]),
		).toEqual(["web"]);
	});
});
