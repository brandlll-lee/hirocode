import type { TUI } from "@hirocode/tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { parseArgs, printHelp } from "../src/cli/args.js";
import { buildSystemPrompt } from "../src/core/system-prompt.js";
import { allTools, codingTools } from "../src/core/tools/index.js";
import { createTodoWriteToolDefinition, type TodoItem } from "../src/core/tools/todo.js";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

function createFakeTui(): TUI {
	return {
		requestRender: () => {},
	} as unknown as TUI;
}

const sampleTodos: TodoItem[] = [
	{ content: "Inspect current tool architecture", status: "completed", priority: "high" },
	{ content: "Implement todowrite core tool", status: "in_progress", priority: "high" },
	{ content: "Add focused tests", status: "pending", priority: "medium" },
];

describe("todowrite tool", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("is available but not enabled by default", () => {
		expect(allTools.todowrite.name).toBe("todowrite");
		expect(codingTools.map((tool) => tool.name)).toEqual(["read", "bash", "edit", "write", "webfetch", "websearch"]);
	});

	test("stores validated todos in details", async () => {
		const tool = createTodoWriteToolDefinition();
		const result = await tool.execute("tool-1", { todos: sampleTodos }, undefined, undefined, {} as never);

		expect(result.content).toEqual([{ type: "text", text: "Updated todo list" }]);
		expect(result.details).toEqual({ todos: sampleTodos });
		expect(result.details.todos).not.toBe(sampleTodos);
	});

	test("accepts empty lists to clear todos", async () => {
		const tool = createTodoWriteToolDefinition();
		const result = await tool.execute("tool-2", { todos: [] }, undefined, undefined, {} as never);

		expect(result.details).toEqual({ todos: [] });
	});

	test("rejects invalid status values", async () => {
		const tool = createTodoWriteToolDefinition();

		await expect(
			tool.execute(
				"tool-3",
				{ todos: [{ content: "Bad status", status: "blocked", priority: "medium" }] } as never,
				undefined,
				undefined,
				{} as never,
			),
		).rejects.toThrow(/\/todos\/0\/status/);
	});

	test("rejects invalid priority values", async () => {
		const tool = createTodoWriteToolDefinition();

		await expect(
			tool.execute(
				"tool-4",
				{ todos: [{ content: "Bad priority", status: "pending", priority: "urgent" }] } as never,
				undefined,
				undefined,
				{} as never,
			),
		).rejects.toThrow(/\/todos\/0\/priority/);
	});

	test("rejects more than one in-progress todo", async () => {
		const tool = createTodoWriteToolDefinition();

		await expect(
			tool.execute(
				"tool-5",
				{
					todos: [
						{ content: "First", status: "in_progress", priority: "high" },
						{ content: "Second", status: "in_progress", priority: "medium" },
					],
				},
				undefined,
				undefined,
				{} as never,
			),
		).rejects.toThrow("at most one todo can be in_progress");
	});

	test("parses --tools with todowrite", () => {
		expect(parseArgs(["--tools", "todowrite"]).tools).toEqual(["todowrite"]);
		expect(parseArgs(["--tools", "read,todowrite"]).tools).toEqual(["read", "todowrite"]);
	});

	test("help output mentions todowrite", () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		printHelp();

		const output = log.mock.calls.map(([value]) => String(value)).join("\n");
		expect(output).toContain("todowrite");
		expect(output).toContain("Create or replace a structured todo list");
	});

	test("system prompt omits todowrite by default and includes it when selected", () => {
		const tool = createTodoWriteToolDefinition();
		const defaultPrompt = buildSystemPrompt({
			toolSnippets: {
				read: "Read file contents",
				bash: "Execute bash commands",
				edit: "Make surgical edits",
				write: "Create or overwrite files",
				webfetch: "Fetch URL contents",
				websearch: "Search the web for current information",
			},
			contextFiles: [],
			skills: [],
		});

		expect(defaultPrompt).not.toContain("todowrite");

		const selectedPrompt = buildSystemPrompt({
			selectedTools: ["todowrite"],
			toolSnippets: { todowrite: tool.promptSnippet ?? "" },
			promptGuidelines: tool.promptGuidelines,
			contextFiles: [],
			skills: [],
		});

		expect(selectedPrompt).toContain("- todowrite: Create or update a structured todo list for multi-step work");
		expect(selectedPrompt).toContain(
			"Use todowrite for non-trivial, multi-step work; skip it for simple one-step tasks.",
		);
	});

	test("renders collapsed and expanded todo results", () => {
		const tool = createTodoWriteToolDefinition();
		const component = new ToolExecutionComponent(
			"todowrite",
			"tool-6",
			{ todos: sampleTodos },
			{},
			tool,
			createFakeTui(),
		);
		component.updateResult(
			{
				content: [{ type: "text", text: "Updated todo list" }],
				details: { todos: sampleTodos },
				isError: false,
			},
			false,
		);

		const collapsed = stripAnsi(component.render(120).join("\n"));
		expect(collapsed).toContain("todowrite");
		expect(collapsed).toContain("3 items");
		expect(collapsed).toContain("1/3 completed · current: Implement todowrite core tool");
		expect(collapsed).not.toContain("Add focused tests");

		component.setExpanded(true);
		const expanded = stripAnsi(component.render(120).join("\n"));
		expect(expanded).toContain("1/3 completed");
		expect(expanded).toContain("Inspect current tool architecture");
		expect(expanded).toContain("Implement todowrite core tool");
		expect(expanded).toContain("Add focused tests");
	});
});
