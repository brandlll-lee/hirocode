import { type Component, getKeybindings, truncateToWidth } from "@hirocode/tui";
import type { MissionFeatureRun, MissionRecord } from "../../../core/missions/types.js";
import { theme } from "../theme/theme.js";
import { keyHint, rawKeyHint } from "./keybinding-hints.js";

export type MissionControlAction =
	| { type: "status" }
	| { type: "toggle-pause" }
	| { type: "retry" }
	| { type: "open-feature"; featureId: string }
	| { type: "abort" }
	| { type: "clear" };

type MissionControlRow =
	| { kind: "heading"; label: string }
	| { kind: "action"; label: string; action: MissionControlAction }
	| { kind: "feature"; label: string; featureId: string };

export interface MissionControlComponentOptions {
	getMission: () => MissionRecord | undefined;
	getPendingApprovals: () => number;
	selectedFeatureId?: string;
	notice?: string;
	onSelect: (action: MissionControlAction) => void;
	onCancel: () => void;
}

export class MissionControlComponent implements Component {
	private selectedIndex = 0;
	private initialSelectionApplied = false;

	constructor(private readonly options: MissionControlComponentOptions) {}

	invalidate(): void {}

	render(width: number): string[] {
		const mission = this.options.getMission();
		const rows = this.buildRows(mission);
		this.applyInitialSelection(rows);
		this.selectedIndex = clampIndex(this.selectedIndex, rows);
		const innerWidth = Math.max(20, width - 4);
		const selectedFeature = mission ? this.getSelectedFeature(mission, rows) : undefined;
		const lines = [
			`┌${repeat("─", innerWidth)}┐`,
			...renderSection(
				[
					`${theme.bold(theme.fg("accent", "Mission Control"))}${mission ? ` ${theme.fg("muted", mission.title)}` : ""}`,
					mission
						? `${theme.fg("muted", "Status:")} ${mission.status}${mission.currentMilestoneId ? `  ${theme.fg("muted", "Milestone:")} ${mission.currentMilestoneId}` : ""}`
						: theme.fg("muted", "No active mission"),
					mission
						? `${theme.fg("muted", "Cost:")} $${mission.actualCost.toFixed(4)}  ${theme.fg("muted", "Turns:")} ${mission.actualTurns}  ${theme.fg("muted", "Approvals:")} ${this.options.getPendingApprovals()}`
						: "",
				],
				innerWidth,
			),
			...renderDivider(innerWidth),
			...renderSection(this.renderRows(rows, innerWidth), innerWidth),
			...renderDivider(innerWidth),
			...renderSection(this.renderFeatureDetails(selectedFeature, innerWidth), innerWidth),
			...(this.options.notice
				? [...renderDivider(innerWidth), ...renderSection([theme.fg("warning", this.options.notice)], innerWidth)]
				: []),
			...renderDivider(innerWidth),
			...renderSection(
				[
					`${rawKeyHint("↑↓", "navigate")}  ${keyHint("tui.select.confirm", "select")}  ${keyHint("tui.select.cancel", "close")}`,
				],
				innerWidth,
			),
			`└${repeat("─", innerWidth)}┘`,
		];

		return lines;
	}

	private applyInitialSelection(rows: MissionControlRow[]): void {
		if (this.initialSelectionApplied || !this.options.selectedFeatureId) {
			return;
		}
		const actionableRows = rows.filter((row) => row.kind !== "heading");
		const selectedIndex = actionableRows.findIndex(
			(row) => row.kind === "feature" && row.featureId === this.options.selectedFeatureId,
		);
		if (selectedIndex >= 0) {
			this.selectedIndex = selectedIndex;
		}
		this.initialSelectionApplied = true;
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		const rows = this.buildRows(this.options.getMission()).filter((row) => row.kind !== "heading");
		if (rows.length === 0) {
			if (kb.matches(data, "tui.select.cancel")) {
				this.options.onCancel();
			}
			return;
		}

		if (kb.matches(data, "tui.select.up") || data === "k") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			return;
		}
		if (kb.matches(data, "tui.select.down") || data === "j") {
			this.selectedIndex = Math.min(rows.length - 1, this.selectedIndex + 1);
			return;
		}
		if (kb.matches(data, "tui.select.confirm") || data === "\n") {
			const row = rows[this.selectedIndex];
			if (!row) return;
			if (row.kind === "feature") {
				this.options.onSelect({ type: "open-feature", featureId: row.featureId });
				return;
			}
			this.options.onSelect(row.action);
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.options.onCancel();
		}
	}

	private buildRows(mission: MissionRecord | undefined): MissionControlRow[] {
		if (!mission) {
			return [
				{ kind: "heading", label: "Actions" },
				{ kind: "action", label: "Close", action: { type: "clear" } },
			];
		}

		const rows: MissionControlRow[] = [
			{ kind: "heading", label: "Actions" },
			{ kind: "action", label: "Show status", action: { type: "status" } },
			{
				kind: "action",
				label: mission.status === "running" ? "Pause mission" : "Resume mission",
				action: { type: "toggle-pause" },
			},
			{ kind: "action", label: "Retry failed work", action: { type: "retry" } },
			{ kind: "action", label: "Abort mission", action: { type: "abort" } },
			{ kind: "action", label: "Clear mission context", action: { type: "clear" } },
			{ kind: "heading", label: "Features" },
		];

		for (const feature of mission.plan?.features ?? []) {
			const run = mission.featureRuns[feature.id];
			rows.push({
				kind: "feature",
				featureId: feature.id,
				label: `${formatFeatureStatus(run)} ${feature.title}${run?.mergeStatus ? ` (${run.mergeStatus})` : ""}`,
			});
		}
		return rows;
	}

	private renderRows(rows: MissionControlRow[], width: number): string[] {
		let actionableIndex = 0;
		return rows.map((row) => {
			if (row.kind === "heading") {
				return theme.bold(theme.fg("accent", row.label));
			}
			const selected = actionableIndex === this.selectedIndex;
			actionableIndex += 1;
			const prefix = selected ? theme.fg("accent", "→ ") : "  ";
			return truncateToWidth(prefix + row.label, width);
		});
	}

	private renderFeatureDetails(feature: MissionFeatureRun | undefined, width: number): string[] {
		if (!feature) {
			return [theme.fg("muted", "Select a feature or action")];
		}
		const mission = this.options.getMission();
		const milestoneId = mission?.plan?.features.find((f) => f.id === feature.featureId)?.milestoneId;
		const validationReport = milestoneId ? mission?.validationReports[milestoneId] : undefined;
		const failedChecks =
			validationReport?.status === "failed" ? validationReport.structuredChecks.filter((c) => c.exitCode !== 0) : [];
		const lines = [
			theme.bold(theme.fg("accent", `Feature ${feature.featureId}`)),
			`${theme.fg("muted", "Status:")} ${feature.status}${feature.mergeStatus ? `  ${theme.fg("muted", "Merge:")} ${feature.mergeStatus}` : ""}`,
			feature.agent ? `${theme.fg("muted", "Agent:")} ${feature.agent}` : "",
			feature.worktreePath
				? truncateToWidth(`${theme.fg("muted", "Worktree:")} ${feature.worktreePath}`, width)
				: "",
			feature.branch ? `${theme.fg("muted", "Branch:")} ${feature.branch}` : "",
			feature.lastError ? truncateToWidth(`${theme.fg("error", "Error:")} ${feature.lastError}`, width) : "",
			feature.reviewSummary
				? truncateToWidth(`${theme.fg("muted", "Review:")} ${feature.reviewSummary}`, width)
				: "",
			feature.mergeSummary
				? truncateToWidth(`${theme.fg("muted", "Merge summary:")} ${feature.mergeSummary}`, width)
				: "",
		];
		if (failedChecks.length > 0) {
			lines.push(theme.fg("error", "Validation failed:"));
			for (const check of failedChecks) {
				lines.push(truncateToWidth(`  ${theme.fg("muted", check.command)}: exit ${check.exitCode}`, width));
				const firstLine = check.output.split("\n")[0] ?? "";
				if (firstLine) {
					lines.push(truncateToWidth(`  ${firstLine}`, width));
				}
			}
		}
		return lines.filter(Boolean);
	}

	private getSelectedFeature(mission: MissionRecord, rows: MissionControlRow[]): MissionFeatureRun | undefined {
		const actionableRows = rows.filter((row) => row.kind !== "heading");
		const row = actionableRows[this.selectedIndex];
		if (!row || row.kind !== "feature") {
			return undefined;
		}
		return mission.featureRuns[row.featureId];
	}
}

function formatFeatureStatus(run: MissionFeatureRun | undefined): string {
	const status = run?.status ?? "pending";
	if (status === "completed") return theme.fg("success", "[ok]");
	if (status === "running") return theme.fg("accent", "[..]");
	if (status === "failed" || status === "blocked") return theme.fg("error", "[x]");
	return theme.fg("muted", "[ ]");
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

function repeat(value: string, count: number): string {
	return count > 0 ? value.repeat(count) : "";
}

function clampIndex(index: number, rows: MissionControlRow[]): number {
	const actionable = rows.filter((row) => row.kind !== "heading").length;
	if (actionable === 0) return 0;
	return Math.min(Math.max(index, 0), actionable - 1);
}
