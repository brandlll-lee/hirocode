import type { ApprovalPolicy, AutonomyMode } from "./types.js";

export const INTERACTIVE_AUTONOMY_PRESET_VALUES = ["manual", "auto-low", "auto-medium", "auto-high"] as const;

export type StandardInteractiveAutonomyPreset = (typeof INTERACTIVE_AUTONOMY_PRESET_VALUES)[number];
export type InteractiveAutonomyPreset = StandardInteractiveAutonomyPreset | "custom";

export function deriveInteractiveAutonomyPreset(
	approvalPolicy: ApprovalPolicy,
	autonomyMode: AutonomyMode,
): InteractiveAutonomyPreset {
	if (approvalPolicy === "always-ask" && autonomyMode === "normal") {
		return "manual";
	}
	if (approvalPolicy === "policy-driven" && autonomyMode !== "normal") {
		return autonomyMode;
	}
	return "custom";
}

export function resolveInteractiveAutonomyPreset(preset: StandardInteractiveAutonomyPreset): {
	approvalPolicy: ApprovalPolicy;
	autonomyMode: AutonomyMode;
} {
	if (preset === "manual") {
		return { approvalPolicy: "always-ask", autonomyMode: "normal" };
	}
	return { approvalPolicy: "policy-driven", autonomyMode: preset };
}

export function cycleInteractiveAutonomyPreset(preset: InteractiveAutonomyPreset): StandardInteractiveAutonomyPreset {
	if (preset === "manual") {
		return "auto-low";
	}
	if (preset === "auto-low") {
		return "auto-medium";
	}
	if (preset === "auto-medium") {
		return "auto-high";
	}
	if (preset === "auto-high") {
		return "manual";
	}
	return "manual";
}

export function describeInteractiveAutonomyPreset(preset: InteractiveAutonomyPreset): {
	label: string;
	description: string;
} {
	if (preset === "manual") {
		return { label: "Auto (Off)", description: "all actions require approval" };
	}
	if (preset === "auto-low") {
		return { label: "Auto (Low)", description: "edits and read-only commands" };
	}
	if (preset === "auto-medium") {
		return { label: "Auto (Med)", description: "reversible commands" };
	}
	if (preset === "auto-high") {
		return { label: "Auto (High)", description: "all non-blocked commands" };
	}
	return { label: "Auto (Custom)", description: "advanced approval fallback is active" };
}
