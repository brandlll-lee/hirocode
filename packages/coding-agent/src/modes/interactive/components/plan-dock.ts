import { type Component, truncateToWidth } from "@hirocode/tui";
import stripAnsi from "strip-ansi";
import type { TodoItem } from "../../../core/tools/todo.js";
import { theme } from "../theme/theme.js";
import { keyText } from "./keybinding-hints.js";

const COLLAPSED_VISIBLE_ITEMS = 6;

export class PlanDockComponent implements Component {
	private todos: TodoItem[];
	private expanded = false;

	constructor(todos: TodoItem[]) {
		this.todos = cloneTodos(todos);
	}

	setTodos(todos: TodoItem[]): void {
		this.todos = cloneTodos(todos);
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (this.todos.length === 0) {
			return [];
		}

		const completedCount = this.todos.filter((todo) => todo.status === "completed").length;
		const visibleTodos = this.expanded ? this.todos : this.todos.slice(0, COLLAPSED_VISIBLE_ITEMS);
		const hiddenCount = this.todos.length - visibleTodos.length;
		const borderPrefix = `${theme.fg("borderMuted", "┃")} `;
		const contentWidth = Math.max(12, width - visibleWidth(borderPrefix));

		const lines = [
			truncateToWidth(
				`  ${theme.bold(theme.fg("text", "Plan"))}${theme.fg("muted", ` · ${completedCount}/${this.todos.length}`)}`,
				Math.max(12, width),
			),
			...visibleTodos.map((todo) => `${borderPrefix}${truncateToWidth(formatTodoLine(todo), contentWidth)}`),
		];

		if (hiddenCount > 0) {
			const expandKey = keyText("app.tools.expand") || "Ctrl+O";
			const moreLine = theme.fg("muted", `... ${hiddenCount} more, `) + theme.fg("dim", `${expandKey} to view all`);
			lines.push(`${borderPrefix}${truncateToWidth(moreLine, contentWidth)}`);
		}

		return lines;
	}
}

function cloneTodos(todos: TodoItem[]): TodoItem[] {
	return todos.map((todo) => ({ ...todo }));
}

function formatTodoLine(todo: TodoItem): string {
	if (todo.status === "completed") {
		return `${theme.fg("success", "✓")} ${theme.fg("dim", theme.strikethrough(todo.content))}`;
	}

	if (todo.status === "in_progress") {
		return `${theme.fg("accent", "●")} ${theme.bold(theme.fg("text", todo.content))}`;
	}

	if (todo.status === "cancelled") {
		return `${theme.fg("dim", "✕")} ${theme.fg("dim", theme.strikethrough(todo.content))}`;
	}

	return `${theme.fg("muted", "○")} ${theme.fg("text", todo.content)}`;
}

function visibleWidth(text: string): number {
	return stripAnsi(text).length;
}
