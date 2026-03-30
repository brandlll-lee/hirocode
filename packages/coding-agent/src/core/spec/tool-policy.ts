import { assessBashCommand } from "../policy/bash-risk.js";
import type { ReadonlySessionManager } from "../session-manager.js";
import { getSpecPlanningToolNames as getSpecPlanningToolNamesFromMode, SPEC_PLANNING_RECOVERY_HINT } from "./mode.js";
import { isSpecArmedForNextTurn, readLatestSpecState } from "./state.js";

const SPEC_PLANNING_TOOL_NAME_SET = new Set(getSpecPlanningToolNamesFromMode());

export function getSpecPlanningToolNames(): string[] {
	return [...SPEC_PLANNING_TOOL_NAME_SET];
}

export async function getSpecToolBlockReason(options: {
	sessionManager: ReadonlySessionManager;
	toolName: string;
	args: Record<string, unknown>;
	cwd: string;
}): Promise<string | undefined> {
	const specState = readLatestSpecState(options.sessionManager);
	if (!isSpecArmedForNextTurn(specState)) {
		return undefined;
	}

	if (!SPEC_PLANNING_TOOL_NAME_SET.has(options.toolName)) {
		return `Specification mode is read-only. Tool "${options.toolName}" is unavailable until the plan is approved. ${SPEC_PLANNING_RECOVERY_HINT}`;
	}

	if (options.toolName === "bash") {
		const command = typeof options.args.command === "string" ? options.args.command : "";
		const assessment = await assessBashCommand(command, options.cwd);
		if (assessment.hardDeny || assessment.level !== "low" || !assessment.tags.includes("read-only-command")) {
			return `Specification mode only allows read-only shell commands. ${assessment.justification} ${SPEC_PLANNING_RECOVERY_HINT}`;
		}
	}

	return undefined;
}
