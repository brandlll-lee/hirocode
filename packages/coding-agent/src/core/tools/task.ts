import { Container, Loader, Spacer, Text, truncateToWidth } from "@hirocode/tui";
import { Type } from "@sinclair/typebox";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.js";
import { truncateToVisualLines } from "../../modes/interactive/components/visual-truncate.js";
import type { ThemeColor } from "../../modes/interactive/theme/theme.js";
import type { ToolDefinition } from "../extensions/types.js";
import { discoverAgents, formatAgentList } from "../subagents/agent-registry.js";
import { formatModelReference } from "../subagents/invocation.js";
import { evaluateTaskPermissions } from "../subagents/permissions.js";
import { getDelegatedTaskOutput, runDelegatedTask } from "../subagents/task-runner.js";
import {
	createChildTaskSession,
	findTaskSession,
	formatTaskToolOutput,
	readCurrentTaskSessionMetadata,
} from "../subagents/task-sessions.js";
import type {
	AgentConfig,
	AgentScope,
	DelegatedTaskResult,
	ParentModelReference,
	TaskSessionMetadata,
} from "../subagents/types.js";

const AgentScopeSchema = Type.Union([Type.Literal("user"), Type.Literal("project"), Type.Literal("both")], {
	description: 'Which configured custom agent directories to use alongside built-in agents. Default: "user".',
	default: "user",
});

export const taskToolSchema = Type.Object({
	description: Type.String({ description: "A short description of the delegated task" }),
	prompt: Type.String({ description: "The task for the subagent to perform" }),
	subagent_type: Type.String({ description: "The name of the subagent to invoke" }),
	task_id: Type.Optional(
		Type.String({
			description: "Resume a delegated task by reusing the same child session instead of creating a fresh one.",
		}),
	),
	command: Type.Optional(Type.String({ description: "Optional command that triggered this task" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({
			description: "Prompt before running project-local agents in interactive mode. Default: true.",
			default: true,
		}),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the delegated child session" })),
});

export interface TaskToolInput {
	description: string;
	prompt: string;
	subagent_type: string;
	task_id?: string;
	command?: string;
	agentScope?: AgentScope;
	confirmProjectAgents?: boolean;
	cwd?: string;
}

export interface TaskToolDetails {
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	result?: DelegatedTaskResult;
}

const TASK_PREVIEW_LINES = 10;

type TaskResultRenderState = {
	cachedWidth: number | undefined;
	cachedLines: string[] | undefined;
	cachedSkipped: number | undefined;
};

class TaskResultRenderComponent extends Container {
	state: TaskResultRenderState = {
		cachedWidth: undefined,
		cachedLines: undefined,
		cachedSkipped: undefined,
	};
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(result: DelegatedTaskResult): string {
	const parts: string[] = [];
	if (result.usage.turns) parts.push(`${result.usage.turns} turn${result.usage.turns > 1 ? "s" : ""}`);
	if (result.usage.input) parts.push(`↑${formatTokens(result.usage.input)}`);
	if (result.usage.output) parts.push(`↓${formatTokens(result.usage.output)}`);
	if (result.usage.cacheRead) parts.push(`R${formatTokens(result.usage.cacheRead)}`);
	if (result.usage.cacheWrite) parts.push(`W${formatTokens(result.usage.cacheWrite)}`);
	if (result.usage.cost) parts.push(`$${result.usage.cost.toFixed(4)}`);
	if (result.usage.contextTokens > 0) parts.push(`ctx:${formatTokens(result.usage.contextTokens)}`);
	const modelReference = formatModelReference(result.provider, result.model);
	if (modelReference) parts.push(modelReference);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: ThemeColor, text: string) => string,
): string {
	const argsString = JSON.stringify(args);
	const preview = argsString.length > 80 ? `${argsString.slice(0, 80)}...` : argsString;
	return themeFg("muted", "→ ") + themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
}

function getDisplayItems(
	messages: DelegatedTaskResult["messages"],
): Array<{ type: "text"; text: string } | { type: "tool"; name: string; args: Record<string, unknown> }> {
	const items: Array<{ type: "text"; text: string } | { type: "tool"; name: string; args: Record<string, unknown> }> =
		[];
	for (const message of messages) {
		if (message.role !== "assistant") {
			continue;
		}
		for (const part of message.content) {
			if (part.type === "text") {
				items.push({ type: "text", text: part.text });
			} else if (part.type === "toolCall") {
				items.push({ type: "tool", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

function renderCallText(
	args: TaskToolInput,
	scope: AgentScope,
	theme: Parameters<NonNullable<ToolDefinition<typeof taskToolSchema>["renderCall"]>>[1],
): string {
	const preview = args.prompt.length > 60 ? `${args.prompt.slice(0, 60)}...` : args.prompt;
	let text =
		theme.fg("toolTitle", theme.bold("task ")) +
		theme.fg("accent", args.subagent_type) +
		theme.fg("muted", ` [${scope}]`);
	text += `\n  ${theme.fg("dim", preview)}`;
	if (args.task_id) {
		text += `\n  ${theme.fg("muted", "resume ")}${theme.fg("dim", args.task_id)}`;
	}
	return text;
}

function renderTaskCall(
	args: TaskToolInput,
	theme: Parameters<NonNullable<ToolDefinition<typeof taskToolSchema>["renderCall"]>>[1],
	context: Parameters<NonNullable<ToolDefinition<typeof taskToolSchema>["renderCall"]>>[2],
) {
	const scope = args.agentScope ?? "user";
	const text = renderCallText(args, scope, theme);
	const isRunning = context.executionStarted && context.isPartial;
	const statusColor = context.isError ? "error" : "success";

	if (isRunning) {
		const existingLoader = context.lastComponent instanceof Loader ? context.lastComponent : undefined;
		if (existingLoader) {
			existingLoader.setMessage(text);
			return existingLoader;
		}
		return new Loader(
			context.ui,
			(spinner) => theme.fg("accent", spinner),
			(message) => message,
			text,
			{ leadingBlankLine: false, paddingX: 0 },
		);
	}

	if (context.lastComponent instanceof Loader) {
		context.lastComponent.stop();
		context.lastComponent.setText(`${theme.fg(statusColor, "●")} ${text}`);
		return context.lastComponent;
	}

	if (context.executionStarted) {
		return new Text(`${theme.fg(statusColor, "●")} ${text}`, 0, 0);
	}

	return new Text(text, 0, 0);
}

function renderTaskResult(
	result: { content: Array<{ type: string; text?: string }>; details?: TaskToolDetails },
	options: { expanded: boolean },
	theme: Parameters<NonNullable<ToolDefinition<typeof taskToolSchema>["renderResult"]>>[2],
	context: Parameters<NonNullable<ToolDefinition<typeof taskToolSchema>["renderResult"]>>[3],
) {
	const delegated = result.details?.result;
	if (!delegated) {
		const text = result.content[0];
		return new Text(text?.type === "text" ? (text.text ?? "") : "(no output)", 0, 0);
	}

	const isError = delegated.exitCode !== 0 || delegated.stopReason === "error" || delegated.stopReason === "aborted";
	const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
	const displayItems = getDisplayItems(delegated.messages);
	const usageText = formatUsageStats(delegated);
	const collapsedTextLines: string[] = [];
	let header = `${icon} ${theme.fg("toolTitle", theme.bold(delegated.agent))}${theme.fg("muted", ` (${delegated.agentSource})`)}`;
	if (isError && delegated.stopReason) header += ` ${theme.fg("error", `[${delegated.stopReason}]`)}`;
	collapsedTextLines.push(header);

	if (options.expanded) {
		const container = new Container();
		container.addChild(new Text(header, 0, 0));
		if (isError && delegated.errorMessage) {
			container.addChild(new Text(theme.fg("error", `Error: ${delegated.errorMessage}`), 0, 0));
		}
		container.addChild(new Text(theme.fg("dim", delegated.task), 0, 0));
		container.addChild(new Text(theme.fg("muted", "Task ID: ") + theme.fg("dim", delegated.taskId), 0, 0));
		if (displayItems.length === 0) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
		} else {
			container.addChild(new Spacer(1));
			for (const item of displayItems) {
				if (item.type === "text") {
					container.addChild(new Text(theme.fg("toolOutput", item.text), 0, 0));
				} else {
					container.addChild(new Text(formatToolCall(item.name, item.args, theme.fg.bind(theme)), 0, 0));
				}
			}
		}
		if (usageText) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("dim", usageText), 0, 0));
		}
		return container;
	}

	if (isError && delegated.errorMessage) {
		collapsedTextLines.push(theme.fg("error", `Error: ${delegated.errorMessage}`));
	} else if (displayItems.length === 0) {
		collapsedTextLines.push(theme.fg("muted", "(no output)"));
	} else {
		for (const item of displayItems) {
			collapsedTextLines.push(
				item.type === "text"
					? theme.fg("toolOutput", item.text)
					: formatToolCall(item.name, item.args, theme.fg.bind(theme)),
			);
		}
	}
	if (usageText) {
		collapsedTextLines.push(theme.fg("dim", usageText));
	}

	const component =
		context.lastComponent instanceof TaskResultRenderComponent
			? context.lastComponent
			: new TaskResultRenderComponent();
	const state = component.state;
	component.clear();
	component.addChild({
		render: (width: number) => {
			if (state.cachedLines === undefined || state.cachedWidth !== width) {
				const preview = truncateToVisualLines(collapsedTextLines.join("\n"), TASK_PREVIEW_LINES, width, 0);
				state.cachedLines = preview.visualLines;
				state.cachedSkipped = preview.skippedCount;
				state.cachedWidth = width;
			}

			if (state.cachedSkipped && state.cachedSkipped > 0) {
				const hint = `${theme.fg("muted", `... (${state.cachedSkipped} earlier lines,`)} ${keyHint("app.tools.expand", "to expand")})`;
				return [...(state.cachedLines ?? []), truncateToWidth(hint, width, "...")];
			}

			return state.cachedLines ?? [];
		},
		invalidate: () => {
			state.cachedWidth = undefined;
			state.cachedLines = undefined;
			state.cachedSkipped = undefined;
		},
	});
	return component;
}

function resolveAgentForExecution(
	requestedAgent: AgentConfig | undefined,
	locatedMetadata: TaskSessionMetadata | undefined,
): AgentConfig | undefined {
	if (requestedAgent) {
		return requestedAgent;
	}
	if (!locatedMetadata) {
		return undefined;
	}
	return {
		name: locatedMetadata.agent,
		description: locatedMetadata.agent,
		tools: locatedMetadata.tools,
		model: locatedMetadata.model,
		allowSubagents: locatedMetadata.allowSubagents,
		systemPrompt: locatedMetadata.systemPrompt ?? "",
		source: locatedMetadata.agentSource,
	};
}

export interface TaskToolOptions {
	getParentActiveToolNames?: () => string[];
}

export function createTaskToolDefinition(
	_cwd: string,
	options?: TaskToolOptions,
): ToolDefinition<typeof taskToolSchema, TaskToolDetails> {
	return {
		name: "task",
		label: "task",
		description:
			"Delegate one focused task to a specialized built-in or configured hirocode subagent using an isolated child session.",
		promptSnippet: "Delegate one focused task to a specialized subagent",
		promptGuidelines: [
			"Use task for focused delegated work that benefits from isolated context rather than for trivial one-step tasks.",
			"Prefer built-in general or explore agents when no project-specific custom agent is a better fit.",
			"Resume prior delegated work by passing task_id together with the original subagent_type.",
		],
		surfaceStyle: "boxed",
		surfaceBackground: "toolPendingBg",
		parameters: taskToolSchema,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (!ctx) {
				throw new Error("Task tool requires an active session context.");
			}

			const parentTaskMetadata = readCurrentTaskSessionMetadata(ctx.sessionManager);

			const agentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const requestedAgent = discovery.agents.find((agent) => agent.name === params.subagent_type);
			const locatedTask = params.task_id ? findTaskSession(ctx.sessionManager, params.task_id) : undefined;

			if (params.task_id && !locatedTask) {
				return {
					content: [
						{
							type: "text",
							text: `Unknown task_id ${params.task_id}. Resume only works for existing delegated child sessions.`,
						},
					],
					details: { agentScope, projectAgentsDir: discovery.projectAgentsDir },
				};
			}

			if (locatedTask?.metadata?.agent && locatedTask.metadata.agent !== params.subagent_type) {
				return {
					content: [
						{
							type: "text",
							text: `task_id ${params.task_id} belongs to subagent ${locatedTask.metadata.agent}, but this request asked for ${params.subagent_type}. Resume the original subagent or start a fresh task.`,
						},
					],
					details: { agentScope, projectAgentsDir: discovery.projectAgentsDir },
				};
			}

			const agent = resolveAgentForExecution(requestedAgent, locatedTask?.metadata);
			if (!agent) {
				const { text: available } = formatAgentList(discovery.agents, 12);
				return {
					content: [
						{ type: "text", text: `Unknown agent: "${params.subagent_type}". Available agents: ${available}.` },
					],
					details: { agentScope, projectAgentsDir: discovery.projectAgentsDir },
				};
			}

			if (parentTaskMetadata) {
				if (
					!parentTaskMetadata.allowSubagents &&
					(!parentTaskMetadata.taskPermissions || parentTaskMetadata.taskPermissions.length === 0)
				) {
					throw new Error(
						"Nested subagents are disabled for delegated sessions. Set allowSubagents: true in the agent frontmatter to opt in.",
					);
				}

				if (parentTaskMetadata.taskPermissions && parentTaskMetadata.taskPermissions.length > 0) {
					const permission = evaluateTaskPermissions(agent.name, parentTaskMetadata.taskPermissions);
					if (permission.action === "deny") {
						throw new Error(`Subagent ${agent.name} is not allowed by the current task permission policy.`);
					}
					if (permission.action === "ask") {
						if (!ctx.hasUI) {
							throw new Error(`Subagent ${agent.name} requires interactive approval before it can run.`);
						}
						const approved = await ctx.ui.confirm(
							"Allow delegated subagent?",
							`Current delegated session requested subagent ${agent.name}. Rule: ${permission.rule?.pattern ?? "default ask"}`,
						);
						if (!approved) {
							return {
								content: [{ type: "text", text: `Canceled: subagent ${agent.name} was not approved.` }],
								details: { agentScope, projectAgentsDir: discovery.projectAgentsDir },
							};
						}
					}
				}
			}

			if (agent.source === "project" && (params.confirmProjectAgents ?? true) && ctx.hasUI && !locatedTask) {
				const ok = await ctx.ui.confirm(
					"Run project-local agent?",
					`Agent: ${agent.name}\nSource: ${discovery.projectAgentsDir ?? "(unknown)"}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
				);
				if (!ok) {
					return {
						content: [{ type: "text", text: "Canceled: project-local agent not approved." }],
						details: { agentScope, projectAgentsDir: discovery.projectAgentsDir },
					};
				}
			}

			const taskSession =
				locatedTask?.reference ??
				createChildTaskSession(ctx.sessionManager, {
					cwd: params.cwd ?? ctx.cwd,
					metadata: {
						agent: agent.name,
						agentSource: agent.source,
						allowSubagents: agent.allowSubagents,
						taskPermissions: agent.taskPermissions,
						title: `${params.description} (@${agent.name} subagent)`,
						model: agent.model,
						tools: agent.tools,
						systemPrompt: agent.systemPrompt,
					},
					state: {
						status: "running",
						task: params.prompt,
						description: params.description,
					},
				});

			const parentModel: ParentModelReference | undefined = ctx.model
				? { provider: ctx.model.provider, id: ctx.model.id }
				: undefined;
			const parentActiveToolNames = options?.getParentActiveToolNames?.() ?? [];
			const delegated = await runDelegatedTask({
				sessionRef: taskSession,
				agent,
				task: params.prompt,
				defaultCwd: ctx.cwd,
				cwd: params.cwd,
				parentModel,
				parentActiveToolNames,
				signal,
				resumed: Boolean(locatedTask),
				onUpdate: (partialResult) => {
					onUpdate?.({
						content: [{ type: "text", text: getDelegatedTaskOutput(partialResult.messages) || "(running...)" }],
						details: {
							agentScope,
							projectAgentsDir: discovery.projectAgentsDir,
							result: partialResult,
						},
					});
				},
			});

			const summary = delegated.errorMessage || getDelegatedTaskOutput(delegated.messages) || "(no output)";
			return {
				content: [{ type: "text", text: formatTaskToolOutput(taskSession, summary) }],
				details: {
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					result: delegated,
				},
			};
		},
		renderCall: renderTaskCall,
		renderResult: renderTaskResult,
	};
}

export function createTaskTool(_cwd: string, options?: TaskToolOptions) {
	return {
		name: "task",
		label: "task",
		description: createTaskToolDefinition(_cwd, options).description,
		parameters: taskToolSchema,
		execute: (toolCallId: string, params: TaskToolInput, signal?: AbortSignal, onUpdate?: unknown, ctx?: unknown) =>
			createTaskToolDefinition(_cwd, options).execute(toolCallId, params, signal, onUpdate as never, ctx as never),
	};
}

export const taskToolDefinition = createTaskToolDefinition(process.cwd());
export const taskTool = createTaskTool(process.cwd());
