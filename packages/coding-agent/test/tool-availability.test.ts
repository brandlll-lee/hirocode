import { describe, expect, it } from "vitest";
import { getToolAvailabilityBlockReason } from "../src/core/policy/tool-availability.js";
import { SessionManager } from "../src/core/session-manager.js";
import { createSpecState, writeSpecState } from "../src/core/spec/state.js";

describe("tool availability", () => {
	it("allows todowrite when specification mode is inactive", async () => {
		const sessionManager = SessionManager.inMemory();

		const reason = await getToolAvailabilityBlockReason({
			sessionManager,
			toolName: "todowrite",
			args: { todos: [] },
			cwd: process.cwd(),
		});

		expect(reason).toBeUndefined();
	});

	it.each(["planning", "approved", "executing"] as const)(
		"blocks todowrite while specification mode is %s",
		async (phase) => {
			const sessionManager = SessionManager.inMemory();
			writeSpecState(sessionManager, createSpecState({ phase, maskEnabled: true }));

			const reason = await getToolAvailabilityBlockReason({
				sessionManager,
				toolName: "todowrite",
				args: { todos: [] },
				cwd: process.cwd(),
			});

			expect(reason).toContain("todowrite tool is unavailable while specification mode is active");
		},
	);

	it("delegates non-todo checks to the existing spec planning policy", async () => {
		const sessionManager = SessionManager.inMemory();
		writeSpecState(sessionManager, createSpecState({ phase: "planning", maskEnabled: true }));

		const reason = await getToolAvailabilityBlockReason({
			sessionManager,
			toolName: "write",
			args: { path: "foo.ts", content: "x" },
			cwd: process.cwd(),
		});

		expect(reason).toContain('Tool "write" is unavailable until the plan is approved.');
	});
});
