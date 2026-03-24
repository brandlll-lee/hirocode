import type { TaskPermissionAction, TaskPermissionRule } from "./types.js";

function patternToRegExp(pattern: string): RegExp {
	const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, "\\$&").replace(/\*/g, ".*");
	return new RegExp(`^${escaped}$`, "i");
}

export function matchesTaskPermissionPattern(pattern: string, agentName: string): boolean {
	if (pattern === "*") {
		return true;
	}
	return patternToRegExp(pattern).test(agentName);
}

export function evaluateTaskPermissions(
	agentName: string,
	rules: TaskPermissionRule[] | undefined,
): { action: TaskPermissionAction; rule?: TaskPermissionRule } {
	if (!rules || rules.length === 0) {
		return { action: "ask" };
	}

	let matchedRule: TaskPermissionRule | undefined;
	for (const rule of rules) {
		if (matchesTaskPermissionPattern(rule.pattern, agentName)) {
			matchedRule = rule;
		}
	}

	return matchedRule ? { action: matchedRule.action, rule: matchedRule } : { action: "ask" };
}
