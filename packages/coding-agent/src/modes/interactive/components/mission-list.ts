import { type Component, getKeybindings, truncateToWidth } from "@hirocode/tui";
import type { MissionRecord } from "../../../core/missions/types.js";
import { theme } from "../theme/theme.js";
import { keyHint, rawKeyHint } from "./keybinding-hints.js";

export interface MissionListComponentOptions {
	getMissions: () => MissionRecord[];
	onSelect: (mission: MissionRecord) => void;
	onCancel: () => void;
}

export class MissionListComponent implements Component {
	private selectedIndex = 0;

	constructor(private readonly options: MissionListComponentOptions) {}

	invalidate(): void {}

	render(width: number): string[] {
		const missions = this.options.getMissions();
		this.selectedIndex = Math.min(Math.max(this.selectedIndex, 0), Math.max(missions.length - 1, 0));
		const innerWidth = Math.max(20, width - 4);
		const selected = missions[this.selectedIndex];

		const lines = [
			`┌${repeat("─", innerWidth)}┐`,
			...renderSection(
				[`${theme.bold(theme.fg("accent", "Saved Missions"))}  ${theme.fg("muted", `${missions.length} total`)}`],
				innerWidth,
			),
			...renderDivider(innerWidth),
			...renderSection(this.renderMissionRows(missions, innerWidth), innerWidth),
			...renderDivider(innerWidth),
			...renderSection(this.renderDetail(selected, innerWidth), innerWidth),
			...renderDivider(innerWidth),
			...renderSection(
				[
					`${rawKeyHint("↑↓", "navigate")}  ${keyHint("tui.select.confirm", "load")}  ${keyHint("tui.select.cancel", "close")}`,
				],
				innerWidth,
			),
			`└${repeat("─", innerWidth)}┘`,
		];

		return lines;
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		const missions = this.options.getMissions();

		if (missions.length === 0) {
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
			this.selectedIndex = Math.min(missions.length - 1, this.selectedIndex + 1);
			return;
		}
		if (kb.matches(data, "tui.select.confirm") || data === "\n") {
			const mission = missions[this.selectedIndex];
			if (mission) {
				this.options.onSelect(mission);
			}
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.options.onCancel();
		}
	}

	private renderMissionRows(missions: MissionRecord[], width: number): string[] {
		if (missions.length === 0) {
			return [theme.fg("muted", "No missions saved yet.")];
		}
		return missions.map((mission, index) => {
			const selected = index === this.selectedIndex;
			const prefix = selected ? theme.fg("accent", "→ ") : "  ";
			const statusColor = getStatusColor(mission.status);
			const statusLabel = theme.fg(statusColor, `[${mission.status}]`);
			const featureCount = mission.plan ? `${mission.plan.features.length}f` : "--";
			const milestoneCount = mission.plan ? `${mission.plan.milestones.length}m` : "--";
			const age = formatAge(mission.updatedAt);
			const meta = theme.fg("muted", `${featureCount} ${milestoneCount} ${age}`);
			const row = `${prefix}${statusLabel} ${mission.title}  ${meta}`;
			return truncateToWidth(row, width);
		});
	}

	private renderDetail(mission: MissionRecord | undefined, width: number): string[] {
		if (!mission) {
			return [theme.fg("muted", "Select a mission to view details")];
		}
		const lines = [
			theme.bold(theme.fg("accent", mission.id.slice(0, 8))) + theme.fg("muted", `  ${mission.status}`),
			truncateToWidth(`${theme.fg("muted", "Goal:")} ${mission.goal}`, width),
		];
		if (mission.currentMilestoneId) {
			lines.push(`${theme.fg("muted", "Milestone:")} ${mission.currentMilestoneId}`);
		}
		if (mission.plan) {
			lines.push(
				`${theme.fg("muted", "Plan:")} ${mission.plan.features.length} features / ${mission.plan.milestones.length} milestones`,
			);
		}
		if (mission.actualCost > 0 || mission.actualTurns > 0) {
			lines.push(
				`${theme.fg("muted", "Cost:")} $${mission.actualCost.toFixed(4)}  ${theme.fg("muted", "Turns:")} ${mission.actualTurns}`,
			);
		}
		return lines;
	}
}

function getStatusColor(status: MissionRecord["status"]): Parameters<typeof theme.fg>[0] {
	if (status === "completed") return "success";
	if (status === "running") return "accent";
	if (status === "paused") return "warning";
	if (status === "failed" || status === "aborted") return "error";
	return "muted";
}

function formatAge(iso: string): string {
	const ms = Date.now() - new Date(iso).getTime();
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
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
