import type { ReadonlySessionManager } from "../session-manager.js";
import { readLatestSpecState } from "../spec/state.js";
import { getSpecToolBlockReason } from "../spec/tool-policy.js";

export async function getToolAvailabilityBlockReason(options: {
	sessionManager: ReadonlySessionManager;
	toolName: string;
	args: Record<string, unknown>;
	cwd: string;
}): Promise<string | undefined> {
	const specState = readLatestSpecState(options.sessionManager);
	if (options.toolName === "todowrite" && specState?.phase && specState.phase !== "inactive") {
		return "The todowrite tool is unavailable while specification mode is active. Return to normal execution before updating the todo list.";
	}

	return getSpecToolBlockReason(options);
}
