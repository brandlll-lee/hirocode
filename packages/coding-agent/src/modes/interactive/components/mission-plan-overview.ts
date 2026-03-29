import type { TUI } from "@hirocode/tui";
import { type Component, getKeybindings, truncateToWidth } from "@hirocode/tui";
import type { MissionPlan } from "../../../core/missions/types.js";
import { theme } from "../theme/theme.js";
import { keyHint, rawKeyHint } from "./keybinding-hints.js";

export type MissionPlanOverviewChoice = "approve" | "iterate" | "clear";

export interface MissionPlanOverviewComponentOptions {
	plan: MissionPlan;
	tui?: TUI;
	onSelect: (choice: MissionPlanOverviewChoice) => void;
	onCancel: () => void;
}

const ACTIONS: Array<{ key: string; label: string; choice: MissionPlanOverviewChoice }> = [
	{ key: "1", label: "[1] Approve and start mission", choice: "approve" },
	{ key: "2", label: "[2] Keep iterating on plan", choice: "iterate" },
	{ key: "3", label: "[3] Clear mission", choice: "clear" },
];

export class MissionPlanOverviewComponent implements Component {
	private selectedIndex = 0;

	constructor(private readonly options: MissionPlanOverviewComponentOptions) {}

	invalidate(): void {}

	render(width: number): string[] {
		const { plan } = this.options;
		const innerWidth = Math.max(20, width - 4);

		const header = [`${theme.bold(theme.fg("accent", "Mission Plan"))}  ${theme.fg("muted", plan.title)}`];

		const summaryLines = wrapText(plan.summary, innerWidth - 2).map((l) => `  ${l}`);

		const milestoneLines: string[] = [];
		for (const milestone of plan.milestones) {
			const featureCount = milestone.featureIds.length;
			milestoneLines.push(
				truncateToWidth(
					`  ${theme.bold(milestone.title)}  ${theme.fg("muted", `(${featureCount} feature${featureCount !== 1 ? "s" : ""})`)}`,
					innerWidth - 2,
				),
			);
			if (milestone.description) {
				milestoneLines.push(truncateToWidth(`    ${theme.fg("muted", milestone.description)}`, innerWidth - 2));
			}
			const features = plan.features.filter((f) => milestone.featureIds.includes(f.id));
			if (features.length > 0) {
				milestoneLines.push(
					truncateToWidth(
						`    ${theme.fg("muted", "Features:")} ${features.map((f) => f.title).join(", ")}`,
						innerWidth - 2,
					),
				);
			}
		}

		const criteriaLines = plan.successCriteria
			.slice(0, 4)
			.map((c) => truncateToWidth(`  ${theme.fg("muted", "•")} ${c}`, innerWidth - 2));
		if (plan.successCriteria.length > 4) {
			criteriaLines.push(`  ${theme.fg("muted", `…and ${plan.successCriteria.length - 4} more`)}`);
		}

		const validationLines = plan.validationPlan
			.slice(0, 4)
			.map((v) => truncateToWidth(`  ${theme.fg("muted", "•")} ${v}`, innerWidth - 2));
		if (plan.validationPlan.length > 4) {
			validationLines.push(`  ${theme.fg("muted", `…and ${plan.validationPlan.length - 4} more`)}`);
		}

		const budget = plan.budgetEstimate;
		const budgetLines = [
			`  ${theme.fg("muted", "Features:")} ${plan.features.length}  ${theme.fg("muted", "Milestones:")} ${plan.milestones.length}`,
			`  ${theme.fg("muted", "Estimated runs:")} ~${budget.estimatedRuns} (floor: ${budget.floorRuns})`,
			truncateToWidth(`  ${theme.fg("muted", budget.reasoning)}`, innerWidth - 2),
		];

		const actionLines = ACTIONS.map((action, idx) => {
			const selected = idx === this.selectedIndex;
			const prefix = selected ? theme.fg("accent", "→ ") : "  ";
			const label = selected ? theme.bold(action.label) : action.label;
			return truncateToWidth(prefix + label, innerWidth);
		});

		const hintLine = `${rawKeyHint("↑↓", "navigate")}  ${keyHint("tui.select.confirm", "select")}  ${rawKeyHint("1-3", "quick pick")}  ${keyHint("tui.select.cancel", "cancel")}`;

		const contentLines = [
			`┌${repeat("─", innerWidth)}┐`,
			...renderSection(header, innerWidth),
			...renderDivider(innerWidth),
			...renderSection([theme.bold(theme.fg("accent", "Summary")), ...summaryLines], innerWidth),
			...(milestoneLines.length > 0
				? [
						...renderDivider(innerWidth),
						...renderSection([theme.bold(theme.fg("accent", "Milestones")), ...milestoneLines], innerWidth),
					]
				: []),
			...(criteriaLines.length > 0
				? [
						...renderDivider(innerWidth),
						...renderSection([theme.bold(theme.fg("accent", "Success Criteria")), ...criteriaLines], innerWidth),
					]
				: []),
			...(validationLines.length > 0
				? [
						...renderDivider(innerWidth),
						...renderSection([theme.bold(theme.fg("accent", "Validation Plan")), ...validationLines], innerWidth),
					]
				: []),
			...renderDivider(innerWidth),
			...renderSection([theme.bold(theme.fg("accent", "Budget")), ...budgetLines], innerWidth),
			...renderDivider(innerWidth),
			...renderSection(actionLines, innerWidth),
			...renderDivider(innerWidth),
			...renderSection([hintLine], innerWidth),
		];

		const targetRows = this.options.tui?.terminal.rows ?? 24;
		const paddingNeeded = Math.max(0, targetRows - contentLines.length - 1);
		const paddingLines = Array(paddingNeeded).fill(`│${repeat(" ", innerWidth + 2)}│`);

		return [...contentLines, ...paddingLines, `└${repeat("─", innerWidth)}┘`];
	}

	handleInput(data: string): void {
		const kb = getKeybindings();

		if (data === "1") {
			this.selectedIndex = 0;
			this.options.onSelect("approve");
			return;
		}
		if (data === "2") {
			this.selectedIndex = 1;
			this.options.onSelect("iterate");
			return;
		}
		if (data === "3") {
			this.selectedIndex = 2;
			this.options.onSelect("clear");
			return;
		}

		if (kb.matches(data, "tui.select.up") || data === "k") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			return;
		}
		if (kb.matches(data, "tui.select.down") || data === "j") {
			this.selectedIndex = Math.min(ACTIONS.length - 1, this.selectedIndex + 1);
			return;
		}
		if (kb.matches(data, "tui.select.confirm") || data === "\n") {
			const action = ACTIONS[this.selectedIndex];
			if (action) this.options.onSelect(action.choice);
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.options.onCancel();
		}
	}
}

function renderSection(lines: string[], width: number): string[] {
	return lines.map((line) => `│ ${padLine(line, width)} │`);
}

function renderDivider(width: number): string[] {
	return [`├${repeat("─", width)}┤`];
}

function padLine(line: string, width: number): string {
	const truncated = truncateToWidth(line, width);
	const visible = stripAnsi(truncated).length;
	return truncated + repeat(" ", Math.max(0, width - visible));
}

function stripAnsi(value: string): string {
	return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function repeat(char: string, n: number): string {
	return n > 0 ? char.repeat(n) : "";
}

function wrapText(text: string, maxWidth: number): string[] {
	if (!text) return [];
	const words = text.split(" ");
	const lines: string[] = [];
	let current = "";
	for (const word of words) {
		if (current.length === 0) {
			current = word;
		} else if (current.length + 1 + word.length <= maxWidth) {
			current += ` ${word}`;
		} else {
			lines.push(current);
			current = word;
		}
	}
	if (current.length > 0) lines.push(current);
	return lines;
}
