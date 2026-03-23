import { describe, expect, test } from "vitest";
import {
	getRuntimeProfile,
	mergeAppendSystemPrompt,
	TERMINAL_BENCHMARK_PROFILE,
} from "../src/core/benchmark-profile.js";

describe("benchmark profile", () => {
	test("returns the terminal benchmark profile when enabled", () => {
		expect(getRuntimeProfile(true)).toEqual(TERMINAL_BENCHMARK_PROFILE);
		expect(getRuntimeProfile(false)).toBeUndefined();
		expect(TERMINAL_BENCHMARK_PROFILE.forceVerification).toBe(true);
		expect(TERMINAL_BENCHMARK_PROFILE.verificationPrompt).toContain("Verification pass");
	});

	test("merges benchmark prompt text after existing append prompt", () => {
		const merged = mergeAppendSystemPrompt("Project-specific addition", TERMINAL_BENCHMARK_PROFILE);
		expect(merged).toContain("Project-specific addition");
		expect(merged).toContain("# Benchmark Mode");
		expect(merged?.indexOf("Project-specific addition")).toBeLessThan(merged?.indexOf("# Benchmark Mode") ?? 0);
	});

	test("uses benchmark prompt text when no base prompt exists", () => {
		expect(mergeAppendSystemPrompt(undefined, TERMINAL_BENCHMARK_PROFILE)).toBe(
			TERMINAL_BENCHMARK_PROFILE.appendSystemPrompt,
		);
	});
});
