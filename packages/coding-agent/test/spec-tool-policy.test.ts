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
	it("shares the spec planning tool list with the canonical planning policy", () => {
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

	it("blocks mutating bash commands with recovery guidance during spec planning", async () => {
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
		expect(reason).toContain("Continue exploring");
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

	it("blocks write during spec planning with the spec recovery hint", async () => {
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

		expect(reason).toContain('Tool "write" is unavailable until the plan is approved.');
		expect(reason).toContain("Continue exploring");
	});

	it("does not block tools after a hidden planning state is normalized away", async () => {
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
