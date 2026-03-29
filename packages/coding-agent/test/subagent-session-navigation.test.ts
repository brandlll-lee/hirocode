import { describe, expect, it } from "vitest";
import { resolveChildSessionOpenMode } from "../src/core/subagents/session-navigation.js";

describe("subagent session navigation", () => {
	it("uses detached view while the active session is streaming", () => {
		expect(
			resolveChildSessionOpenMode({
				isStreaming: true,
				activeSessionFile: "parent.jsonl",
				targetSessionFile: "child.jsonl",
			}),
		).toBe("detached");
	});

	it("attaches when the active session is idle", () => {
		expect(
			resolveChildSessionOpenMode({
				isStreaming: false,
				activeSessionFile: "parent.jsonl",
				targetSessionFile: "child.jsonl",
			}),
		).toBe("attach");
	});
});
