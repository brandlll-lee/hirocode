import type { AgentTool } from "@hirocode/agent-core";
import { Text } from "@hirocode/tui";
import { type Static, Type } from "@sinclair/typebox";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import type { ToolDefinition } from "../extensions/types.js";
import { invalidArgText } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

const todoStatusSchema = Type.Union(
	[Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed"), Type.Literal("cancelled")],
	{ description: "Todo status: pending, in_progress, completed, or cancelled" },
);

const todoPrioritySchema = Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")], {
	description: "Todo priority: high, medium, or low",
});

export const todoItemSchema = Type.Object(
	{
		content: Type.String({ minLength: 1, description: "Brief description of the task" }),
		status: todoStatusSchema,
		priority: todoPrioritySchema,
	},
	{ additionalProperties: false },
);

export const todoWriteSchema = Type.Object(
	{
		todos: Type.Array(todoItemSchema, { description: "The complete todo list for the current task" }),
	},
	{ additionalProperties: false },
);

const validateTodoWrite = TypeCompiler.Compile(todoWriteSchema);

export type TodoItem = Static<typeof todoItemSchema>;
export type TodoWriteToolInput = Static<typeof todoWriteSchema>;

export interface TodoWriteToolDetails {
	todos: TodoItem[];
}

type ToolTheme = typeof import("../../modes/interactive/theme/theme.js").theme;

function cloneTodos(todos: TodoItem[]): TodoItem[] {
	return todos.map((todo) => ({ ...todo }));
}

function isTodoStatus(value: unknown): value is TodoItem["status"] {
	return value === "pending" || value === "in_progress" || value === "completed" || value === "cancelled";
}

function isTodoPriority(value: unknown): value is TodoItem["priority"] {
	return value === "high" || value === "medium" || value === "low";
}

export function isTodoWriteToolDetails(value: unknown): value is TodoWriteToolDetails {
	if (!value || typeof value !== "object") {
		return false;
	}

	const todos = (value as { todos?: unknown }).todos;
	return (
		Array.isArray(todos) &&
		todos.every(
			(todo) =>
				todo &&
				typeof todo === "object" &&
				typeof (todo as { content?: unknown }).content === "string" &&
				isTodoStatus((todo as { status?: unknown }).status) &&
				isTodoPriority((todo as { priority?: unknown }).priority),
		)
	);
}

export function cloneTodoWriteDetails(details: TodoWriteToolDetails): TodoWriteToolDetails {
	return { todos: cloneTodos(details.todos) };
}

function getValidationError(input: unknown): string | undefined {
	if (!validateTodoWrite.Check(input)) {
		const error = Array.from(validateTodoWrite.Errors(input))[0];
		if (!error) {
			return "Invalid todowrite arguments.";
		}
		return `Invalid todowrite arguments at ${error.path || "/"}: ${error.message}`;
	}

	const todoInput = input as TodoWriteToolInput;
	const inProgress = todoInput.todos.filter((todo) => todo.status === "in_progress").length;
	if (inProgress > 1) {
		return "Invalid todowrite arguments: at most one todo can be in_progress.";
	}
}

function getSummary(todos: TodoItem[]): string {
	if (todos.length === 0) {
		return "No todos";
	}

	const completed = todos.filter((todo) => todo.status === "completed").length;
	const current =
		todos.find((todo) => todo.status === "in_progress") ?? todos.find((todo) => todo.status === "pending");
	if (!current) {
		return `${completed}/${todos.length} completed`;
	}

	return `${completed}/${todos.length} completed · current: ${current.content}`;
}

function formatTodoLine(todo: TodoItem, theme: ToolTheme): string {
	if (todo.status === "completed") {
		return `${theme.fg("success", "✓")} ${theme.fg("dim", theme.strikethrough(todo.content))}`;
	}

	if (todo.status === "in_progress") {
		return `${theme.fg("accent", "•")} ${theme.fg("text", todo.content)}`;
	}

	if (todo.status === "cancelled") {
		return `${theme.fg("dim", "×")} ${theme.fg("dim", theme.strikethrough(todo.content))}`;
	}

	return `${theme.fg("dim", "○")} ${theme.fg("muted", todo.content)}`;
}

function formatTodoWriteCall(args: { todos?: unknown }, theme: ToolTheme): string {
	const count = Array.isArray(args.todos) ? args.todos.length : undefined;
	return `${theme.fg("toolTitle", theme.bold("todowrite"))} ${count === undefined ? invalidArgText(theme) : theme.fg("accent", `${count} item${count === 1 ? "" : "s"}`)}`;
}

function formatTodoWriteResult(
	result: { content: Array<{ type: string; text?: string }>; details?: TodoWriteToolDetails },
	expanded: boolean,
	theme: ToolTheme,
): string {
	const todos = result.details?.todos;
	if (!todos) {
		const text = result.content[0];
		return text?.type === "text" ? (text.text ?? "") : "";
	}

	if (!expanded) {
		return theme.fg("muted", getSummary(todos));
	}

	if (todos.length === 0) {
		return theme.fg("muted", "No todos");
	}

	const lines = [
		`${theme.fg("muted", `${todos.filter((todo) => todo.status === "completed").length}/${todos.length} completed`)}`,
	];
	for (const todo of todos) {
		lines.push(formatTodoLine(todo, theme));
	}
	return lines.join("\n");
}

export function createTodoWriteToolDefinition(): ToolDefinition<typeof todoWriteSchema, TodoWriteToolDetails> {
	return {
		name: "todowrite",
		label: "todowrite",
		description:
			"Create or replace a structured todo list for the current task. Provide the full list on every call, and include content, status, and priority for each item.",
		promptSnippet: "Create or replace the current structured todo list",
		parameters: todoWriteSchema,
		async execute(_toolCallId, params) {
			const validationError = getValidationError(params);
			if (validationError) {
				throw new Error(validationError);
			}

			const todos = cloneTodos(params.todos);
			return {
				content: [{ type: "text", text: "Updated todo list" }],
				details: { todos },
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatTodoWriteCall(args, theme));
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatTodoWriteResult(result as never, options.expanded, theme));
			return text;
		},
	};
}

export function createTodoWriteTool(): AgentTool<typeof todoWriteSchema> {
	return wrapToolDefinition(createTodoWriteToolDefinition());
}

export const todoWriteToolDefinition = createTodoWriteToolDefinition();
export const todoWriteTool = createTodoWriteTool();
