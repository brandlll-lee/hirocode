import { setKeybindings } from "@hirocode/tui";
import stripAnsi from "strip-ansi";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import type { MissionRecord } from "../src/core/missions/types.js";
import { MissionControlComponent } from "../src/modes/interactive/components/mission-control.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

function createMission(): MissionRecord {
	return {
		id: "mission-1",
		goal: "Build todo app",
		title: "Todo Mission",
		status: "running",
		cwd: "F:/CodeHub/mission_test",
		createdAt: "2026-03-27T10:00:00.000Z",
		updatedAt: "2026-03-27T10:00:00.000Z",
		plan: {
			title: "Todo Mission",
			goal: "Build todo app",
			summary: "Build a minimal todo app",
			features: [
				{
					id: "app-shell",
					title: "App shell",
					description: "Create the initial app shell",
					milestoneId: "foundation-ui",
					dependsOn: [],
					workspacePaths: ["index.html"],
					successCriteria: ["Shell exists"],
				},
				{
					id: "todo-ui",
					title: "Todo UI",
					description: "Create todo interactions",
					milestoneId: "foundation-ui",
					dependsOn: ["app-shell"],
					workspacePaths: ["script.js"],
					successCriteria: ["Todos can be added"],
				},
			],
			milestones: [
				{
					id: "foundation-ui",
					title: "Foundation UI",
					description: "Build the initial UI",
					featureIds: ["app-shell", "todo-ui"],
					successCriteria: ["UI exists"],
				},
			],
			successCriteria: ["App works"],
			validationPlan: [],
			modelStrategy: {},
			budgetEstimate: {
				floorRuns: 1,
				estimatedRuns: 1,
				reasoning: "test",
			},
			markdown: "",
		},
		featureRuns: {
			"app-shell": {
				featureId: "app-shell",
				status: "running",
				agent: "general",
			},
			"todo-ui": {
				featureId: "todo-ui",
				status: "pending",
				agent: "general",
			},
		},
		milestoneStatus: {
			"foundation-ui": "running",
		},
		validationReports: {},
		workers: {},
		currentMilestoneId: "foundation-ui",
		actualCost: 0,
		actualTurns: 0,
	};
}

beforeAll(() => {
	initTheme("dark");
});

beforeEach(() => {
	setKeybindings(new KeybindingsManager());
});

describe("mission control component", () => {
	it("shows inline waiting notice and preserves feature selection", () => {
		const component = new MissionControlComponent({
			getMission: () => createMission(),
			getPendingApprovals: () => 0,
			selectedFeatureId: "todo-ui",
			notice: "Feature todo-ui worker is starting; child session is not ready yet.",
			onSelect: vi.fn(),
			onCancel: vi.fn(),
		});

		const lines = component.render(100);
		const rendered = stripAnsi(lines.join("\n"));

		expect(rendered).toContain("Feature todo-ui worker is starting; child session is not ready yet.");
		expect(rendered).toContain("→ [ ] Todo UI");
	});
});
