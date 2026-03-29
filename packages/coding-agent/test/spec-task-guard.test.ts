import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { SessionManager } from "../src/core/session-manager.js";
import { writeSpecState } from "../src/core/spec/state.js";
import { createTaskToolDefinition } from "../src/core/tools/task.js";

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length > 0) {
		fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
	}
});

describe("spec-mode task guard", () => {
	test("blocks non-read-only subagents during planning", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "hirocode-spec-task-guard-"));
		tempDirs.push(root);
		const sessionManager = SessionManager.create(root, path.join(root, "sessions"));
		writeSpecState(sessionManager, {
			id: "spec-1",
			phase: "planning",
			previousActiveTools: ["read", "bash", "edit", "write", "task"],
		});

		const tool = createTaskToolDefinition(root, { getParentActiveToolNames: () => ["read", "bash", "task"] });
		const result = await tool.execute(
			"task-1",
			{
				description: "Do the work",
				prompt: "Implement the change",
				subagent_type: "general",
			},
			undefined,
			undefined,
			{
				cwd: root,
				hasUI: false,
				ui: { notify: () => {} },
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
			} as never,
		);

		expect(result.content[0]?.type).toBe("text");
		expect((result.content[0] as { type: "text"; text: string }).text).toContain(
			"cannot run during specification mode",
		);
	});
});
