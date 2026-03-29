import type { MatchedRule, PermissionRule } from "./types.js";
import { Wildcard } from "./wildcard.js";

export function evaluatePermission(
	permission: string,
	pattern: string,
	...rulesets: Array<Array<PermissionRule & { source: MatchedRule["source"] }>>
): MatchedRule | undefined {
	const rules = rulesets.flat();
	for (let index = rules.length - 1; index >= 0; index--) {
		const rule = rules[index];
		if (!rule) {
			continue;
		}
		if (Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern)) {
			return rule;
		}
	}
	return undefined;
}
