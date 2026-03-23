export interface RuntimeProfile {
	id: string;
	name: string;
	appendSystemPrompt?: string;
	suppressInteractivePrompts: boolean;
	autoForkCrossProjectSession: boolean;
	forceVerification: boolean;
	verificationPrompt?: string;
}

export const TERMINAL_BENCHMARK_PROFILE: RuntimeProfile = {
	id: "terminal-bench-v1",
	name: "Terminal Bench",
	suppressInteractivePrompts: true,
	autoForkCrossProjectSession: true,
	forceVerification: true,
	appendSystemPrompt: `# Benchmark Mode

You are running in strict non-interactive benchmark mode.

- Do not ask the user clarifying questions.
- Do not ask for confirmation or permission.
- Assume reasonable defaults when requirements are ambiguous, and continue.
- Prefer action over discussion. Keep explanations brief and focused on the task.
- If the task requires multiple steps, keep a short plan mentally and execute it methodically.
- Before finishing, verify that the requested outcome is actually complete.
- Use command output, file contents, and other tool evidence to verify completion.
- Do not stop after partial implementation if tests, inspection, or task verification are still missing.
- If a file read or command output is truncated, fetch the missing context before making assumptions.
- If one approach fails, recover quickly, choose the next reasonable approach, and continue.`,
	verificationPrompt: `Verification pass. Re-read the original task, inspect the work completed so far, and verify whether the requested outcome is actually complete.

- If anything is missing, continue working immediately instead of stopping.
- If verification requires commands, file reads, or other tools, use them now.
- Do not ask the user for clarification or confirmation.
- Only finish once you can briefly state what was verified and what evidence supports completion.`,
};

export function getRuntimeProfile(benchmarkMode?: boolean): RuntimeProfile | undefined {
	if (!benchmarkMode) {
		return undefined;
	}

	return TERMINAL_BENCHMARK_PROFILE;
}

export function mergeAppendSystemPrompt(
	base: string | undefined,
	profile: RuntimeProfile | undefined,
): string | undefined {
	if (!profile?.appendSystemPrompt) {
		return base;
	}

	if (!base?.trim()) {
		return profile.appendSystemPrompt;
	}

	return `${base}\n\n${profile.appendSystemPrompt}`;
}
