import { describe, expect, it } from "vitest";
import {
	cycleInteractiveAutonomyPreset,
	deriveInteractiveAutonomyPreset,
	describeInteractiveAutonomyPreset,
	resolveInteractiveAutonomyPreset,
} from "../src/core/policy/interactive-autonomy.js";

describe("interactive autonomy preset", () => {
	it("derives the standard interactive presets from settings", () => {
		expect(deriveInteractiveAutonomyPreset("always-ask", "normal")).toBe("manual");
		expect(deriveInteractiveAutonomyPreset("policy-driven", "auto-low")).toBe("auto-low");
		expect(deriveInteractiveAutonomyPreset("policy-driven", "auto-medium")).toBe("auto-medium");
		expect(deriveInteractiveAutonomyPreset("policy-driven", "auto-high")).toBe("auto-high");
	});

	it("marks non-standard combinations as custom", () => {
		expect(deriveInteractiveAutonomyPreset("policy-driven", "normal")).toBe("custom");
		expect(deriveInteractiveAutonomyPreset("always-ask", "auto-low")).toBe("custom");
		expect(deriveInteractiveAutonomyPreset("headless-reject", "auto-high")).toBe("custom");
	});

	it("resolves presets back to the underlying settings", () => {
		expect(resolveInteractiveAutonomyPreset("manual")).toEqual({
			approvalPolicy: "always-ask",
			autonomyMode: "normal",
		});
		expect(resolveInteractiveAutonomyPreset("auto-medium")).toEqual({
			approvalPolicy: "policy-driven",
			autonomyMode: "auto-medium",
		});
	});

	it("cycles presets safely, including custom state", () => {
		expect(cycleInteractiveAutonomyPreset("manual")).toBe("auto-low");
		expect(cycleInteractiveAutonomyPreset("auto-low")).toBe("auto-medium");
		expect(cycleInteractiveAutonomyPreset("auto-medium")).toBe("auto-high");
		expect(cycleInteractiveAutonomyPreset("auto-high")).toBe("manual");
		expect(cycleInteractiveAutonomyPreset("custom")).toBe("manual");
	});

	it("describes custom mode for the banner", () => {
		expect(describeInteractiveAutonomyPreset("custom")).toEqual({
			label: "Auto (Custom)",
			description: "advanced approval fallback is active",
		});
	});
});
