import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.js";
import { createSpecState, writeSpecState } from "../src/core/spec/state.js";
import { getSpecPlanningToolNames, getSpecToolBlockReason } from "../src/core/spec/tool-policy.js";

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length > 0) {
		rmSync(tempDirs.pop()!, { recursive: true, force: true });
	}
});

describe("getSpecToolBlockReason", () => {
	it("shares the spec planning tool list with interactive mode expectations", () => {
		expect(getSpecPlanningToolNames()).toEqual([
			"read",
			"bash",
			"grep",
			"find",
			"ls",
			"webfetch",
			"websearch",
			"task",
			"ask",
		]);
	});

	it("allows read-only bash commands during spec planning", async () => {
		const root = join(tmpdir(), `hirocode-spec-tool-policy-${Date.now()}`);
		tempDirs.push(root);
		mkdirSync(root, { recursive: true });
		const sessionManager = SessionManager.inMemory();
		writeSpecState(sessionManager, createSpecState({ phase: "planning", maskEnabled: true }));

		const reason = await getSpecToolBlockReason({
			sessionManager,
			toolName: "bash",
			args: { command: "git status --short --branch" },
			cwd: root,
		});

		expect(reason).toBeUndefined();
	});

	it("still blocks mutating bash commands during spec planning", async () => {
		const root = join(tmpdir(), `hirocode-spec-tool-policy-${Date.now()}-mutating`);
		tempDirs.push(root);
		mkdirSync(root, { recursive: true });
		const sessionManager = SessionManager.inMemory();
		writeSpecState(sessionManager, createSpecState({ phase: "planning", maskEnabled: true }));

		const reason = await getSpecToolBlockReason({
			sessionManager,
			toolName: "bash",
			args: { command: "npm install lodash" },
			cwd: root,
		});

		expect(reason).toContain("Specification mode only allows read-only shell commands.");
	});

	it("allows ask during spec planning", async () => {
		const root = join(tmpdir(), `hirocode-spec-tool-policy-${Date.now()}-ask`);
		tempDirs.push(root);
		mkdirSync(root, { recursive: true });
		const sessionManager = SessionManager.inMemory();
		writeSpecState(sessionManager, createSpecState({ phase: "planning", maskEnabled: true }));

		const reason = await getSpecToolBlockReason({
			sessionManager,
			toolName: "ask",
			args: {
				questions: [
					{
						question: "Which layout should we prioritize?",
						options: [{ label: "Landing page" }, { label: "Dashboard" }],
					},
				],
			},
			cwd: root,
		});

		expect(reason).toBeUndefined();
	});

	it("still blocks write during spec planning", async () => {
		const root = join(tmpdir(), `hirocode-spec-tool-policy-${Date.now()}-write`);
		tempDirs.push(root);
		mkdirSync(root, { recursive: true });
		const sessionManager = SessionManager.inMemory();
		writeSpecState(sessionManager, createSpecState({ phase: "planning", maskEnabled: true }));

		const reason = await getSpecToolBlockReason({
			sessionManager,
			toolName: "write",
			args: { filePath: "LOVE_HIROCODE.md", content: "LOVE-HIROCODE-LOVE" },
			cwd: root,
		});

		expect(reason).toBe('Specification mode is read-only. Tool "write" is unavailable until the plan is approved.');
	});

	it("does not block tools when spec planning is hidden", async () => {
		const root = join(tmpdir(), `hirocode-spec-tool-policy-${Date.now()}-masked`);
		tempDirs.push(root);
		mkdirSync(root, { recursive: true });
		const sessionManager = SessionManager.inMemory();
		writeSpecState(sessionManager, createSpecState({ phase: "planning", maskEnabled: false }));

		const reason = await getSpecToolBlockReason({
			sessionManager,
			toolName: "write",
			args: { filePath: "LOVE_HIROCODE.md", content: "LOVE-HIROCODE-LOVE" },
			cwd: root,
		});

		expect(reason).toBeUndefined();
	});
});
