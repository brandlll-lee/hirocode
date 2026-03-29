/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `hirocode` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import * as os from "node:os";
import { Type } from "@sinclair/typebox";
import type { AgentToolResult } from "../../../../agent/src/index.js";
import { type Api, type Message, type Model, StringEnum } from "../../../../ai/src/index.js";
import { Container, Loader, Markdown, Spacer, Text } from "../../../../tui/src/index.js";
import type { ExtensionAPI, ToolDefinition } from "../../../src/core/extensions/types.js";
import { formatModelReference, resolveEffectiveSubagentModel } from "../../../src/core/subagents/invocation.js";
import { codingTools } from "../../../src/core/tools/index.js";
import { createTaskToolDefinition } from "../../../src/core/tools/task.js";
import { getMarkdownTheme } from "../../../src/modes/interactive/theme/theme.js";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.js";
import { findStoredTaskReferenceOnDisk, formatTaskReferenceLines, isSubagentSessionFile } from "./task-persistence.js";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;

type RenderTheme = Parameters<NonNullable<ToolDefinition["renderCall"]>>[1];
type RenderResultOptions = Parameters<NonNullable<ToolDefinition["renderResult"]>>[1];
type ParentModelReference = Pick<Model<Api>, "provider" | "id">;

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	provider?: string,
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	const modelReference = formatModelReference(provider, model);
	if (modelReference) parts.push(modelReference);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface SingleResult {
	taskId?: string;
	parentSessionId?: string;
	sessionId?: string;
	sessionFile?: string;
	metadataFile?: string;
	provider?: string;
	agent: string;
	agentSource: "built-in" | "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	tools?: string[];
	systemPrompt?: string;
	resumed?: boolean;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

interface DelegationTaskItem {
	agent: string;
	task: string;
	cwd?: string;
}

interface DelegationParams {
	agent?: string;
	task?: string;
	tasks?: DelegationTaskItem[];
	chain?: DelegationTaskItem[];
	agentScope?: AgentScope;
	confirmProjectAgents?: boolean;
	cwd?: string;
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

function formatReferenceHeader(result: SingleResult): string | undefined {
	if (!result.taskId) {
		return undefined;
	}

	return formatTaskReferenceLines({ taskId: result.taskId, sessionId: result.sessionId }).join("\n");
}

function getSubagentTreeLabel(details: SubagentDetails): string | undefined {
	if (details.results.length === 0) {
		return undefined;
	}

	if (details.mode === "single" && details.results.length === 1) {
		return `subagent:${details.results[0].agent}`;
	}

	return `subagent:${details.mode}-${details.results.length}`;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

async function runSingleAgent(
	parentSessionId: string,
	defaultCwd: string,
	agents: AgentConfig[],
	parentModel: ParentModelReference | undefined,
	agentScope: AgentScope,
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	toolContext: Parameters<ToolDefinition["execute"]>[4],
): Promise<SingleResult> {
	const discoveredAgent = agents.find((candidate) => candidate.name === agentName);
	const agent = discoveredAgent;

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
		};
	}

	const effectiveModel = resolveEffectiveSubagentModel(
		discoveredAgent?.model,
		discoveredAgent?.reasoningEffort,
		parentModel,
	);
	const taskTool = createTaskToolDefinition(defaultCwd, {
		getParentActiveToolNames: () => codingTools.map((tool) => tool.name),
	});

	const taskResult = await taskTool.execute(
		`subagent-${step ?? 0}-${agentName}`,
		{
			description: `${agentName} delegated task`,
			prompt: task,
			subagent_type: agentName,
			cwd,
			agentScope,
			confirmProjectAgents: false,
		},
		signal,
		(partial) => {
			const delegated = partial.details?.result;
			if (!delegated || !onUpdate) {
				return;
			}
			const partialResult: SingleResult = {
				...delegated,
				metadataFile: delegated.sessionFile,
				step,
			};
			onUpdate({
				content: partial.content,
				details: makeDetails([partialResult]),
			});
		},
		toolContext,
	);

	const delegated = taskResult.details?.result;
	if (!delegated) {
		const text = taskResult.content[0]?.type === "text" ? taskResult.content[0].text : "(no output)";
		return {
			parentSessionId,
			provider: effectiveModel.provider,
			agent: agentName,
			agentSource: agent.source,
			task,
			exitCode: 1,
			messages: [],
			stderr: text ?? "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			model: effectiveModel.modelId,
			tools: agent.tools,
			systemPrompt: agent.systemPrompt,
			resumed: false,
			step,
		};
	}

	const currentResult: SingleResult = {
		...delegated,
		metadataFile: delegated.sessionFile,
		step,
	};
	return currentResult;
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
});

function formatDelegationCallText(title: string, args: DelegationParams, theme: RenderTheme): string {
	const scope: AgentScope = args.agentScope ?? "user";
	if (args.chain && args.chain.length > 0) {
		let text =
			theme.fg("toolTitle", theme.bold(`${title} `)) +
			theme.fg("accent", `chain (${args.chain.length} steps)`) +
			theme.fg("muted", ` [${scope}]`);
		for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
			const step = args.chain[i];
			const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
			const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
			text +=
				"\n  " +
				theme.fg("muted", `${i + 1}.`) +
				" " +
				theme.fg("accent", step.agent) +
				theme.fg("dim", ` ${preview}`);
		}
		if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
		return text;
	}

	if (args.tasks && args.tasks.length > 0) {
		let text =
			theme.fg("toolTitle", theme.bold(`${title} `)) +
			theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
			theme.fg("muted", ` [${scope}]`);
		for (const task of args.tasks.slice(0, 3)) {
			const preview = task.task.length > 40 ? `${task.task.slice(0, 40)}...` : task.task;
			text += `\n  ${theme.fg("accent", task.agent)}${theme.fg("dim", ` ${preview}`)}`;
		}
		if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
		return text;
	}

	const agentName = args.agent || "...";
	const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
	let text =
		theme.fg("toolTitle", theme.bold(`${title} `)) + theme.fg("accent", agentName) + theme.fg("muted", ` [${scope}]`);
	text += `\n  ${theme.fg("dim", preview)}`;
	return text;
}

function renderDelegationCallComponent(
	title: string,
	args: DelegationParams,
	theme: RenderTheme,
	context: Parameters<NonNullable<ToolDefinition["renderCall"]>>[2],
	text = formatDelegationCallText(title, args, theme),
) {
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
			{
				leadingBlankLine: false,
				paddingX: 0,
			},
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

function renderDelegationResult(
	result: AgentToolResult<SubagentDetails>,
	{ expanded }: RenderResultOptions,
	theme: RenderTheme,
) {
	const details = result.details as SubagentDetails | undefined;
	if (!details || details.results.length === 0) {
		const text = result.content[0];
		return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
	}

	const mdTheme = getMarkdownTheme();

	const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
		const toShow = limit ? items.slice(-limit) : items;
		const skipped = limit && items.length > limit ? items.length - limit : 0;
		let text = "";
		if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
		for (const item of toShow) {
			if (item.type === "text") {
				const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
				text += `${theme.fg("toolOutput", preview)}\n`;
			} else {
				text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
			}
		}
		return text.trimEnd();
	};

	if (details.mode === "single" && details.results.length === 1) {
		const r = details.results[0];
		const isError = r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
		const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
		const displayItems = getDisplayItems(r.messages);
		const finalOutput = getFinalOutput(r.messages);

		if (expanded) {
			const container = new Container();
			let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
			if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
			container.addChild(new Text(header, 0, 0));
			if (isError && r.errorMessage) {
				container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
			}
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
			container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
			if (r.taskId) {
				let idLine = theme.fg("muted", "Task ID: ") + theme.fg("dim", r.taskId);
				if (r.sessionId && r.sessionId !== r.taskId) idLine += theme.fg("muted", `  Session: ${r.sessionId}`);
				container.addChild(new Text(idLine, 0, 0));
			}
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
			if (displayItems.length === 0 && !finalOutput) {
				container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
			} else {
				for (const item of displayItems) {
					if (item.type === "toolCall") {
						container.addChild(
							new Text(
								theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
								0,
								0,
							),
						);
					}
				}
				if (finalOutput) {
					container.addChild(new Spacer(1));
					container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
				}
			}
			const usageStr = formatUsageStats(r.usage, r.provider, r.model);
			if (usageStr) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
			}
			return container;
		}

		let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
		if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
		if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
		else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
		else {
			text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
			if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
		}
		const usageStr = formatUsageStats(r.usage, r.provider, r.model);
		if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
		return new Text(text, 0, 0);
	}

	const aggregateUsage = (results: SingleResult[]) => {
		const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
		for (const r of results) {
			total.input += r.usage.input;
			total.output += r.usage.output;
			total.cacheRead += r.usage.cacheRead;
			total.cacheWrite += r.usage.cacheWrite;
			total.cost += r.usage.cost;
			total.turns += r.usage.turns;
		}
		return total;
	};

	if (details.mode === "chain") {
		const successCount = details.results.filter((r) => r.exitCode === 0).length;
		const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

		if (expanded) {
			const container = new Container();
			container.addChild(
				new Text(
					icon +
						" " +
						theme.fg("toolTitle", theme.bold("chain ")) +
						theme.fg("accent", `${successCount}/${details.results.length} steps`),
					0,
					0,
				),
			);

			for (const r of details.results) {
				const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				container.addChild(new Spacer(1));
				container.addChild(
					new Text(`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
				);
				container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
				if (r.taskId) {
					let idLine = theme.fg("muted", "Task ID: ") + theme.fg("dim", r.taskId);
					if (r.sessionId && r.sessionId !== r.taskId) idLine += theme.fg("muted", `  Session: ${r.sessionId}`);
					container.addChild(new Text(idLine, 0, 0));
				}

				for (const item of displayItems) {
					if (item.type === "toolCall") {
						container.addChild(
							new Text(
								theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
								0,
								0,
							),
						);
					}
				}

				if (finalOutput) {
					container.addChild(new Spacer(1));
					container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
				}

				const stepUsage = formatUsageStats(r.usage, r.provider, r.model);
				if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
			}

			const usageStr = formatUsageStats(aggregateUsage(details.results));
			if (usageStr) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
			}
			return container;
		}

		let text =
			icon +
			" " +
			theme.fg("toolTitle", theme.bold("chain ")) +
			theme.fg("accent", `${successCount}/${details.results.length} steps`);
		for (const r of details.results) {
			const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
			const displayItems = getDisplayItems(r.messages);
			text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
			if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
			else text += `\n${renderDisplayItems(displayItems, 5)}`;
		}
		const usageStr = formatUsageStats(aggregateUsage(details.results));
		if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
		text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
		return new Text(text, 0, 0);
	}

	if (details.mode === "parallel") {
		const running = details.results.filter((r) => r.exitCode === -1).length;
		const successCount = details.results.filter((r) => r.exitCode === 0).length;
		const failCount = details.results.filter((r) => r.exitCode > 0).length;
		const isRunning = running > 0;
		const icon = isRunning
			? theme.fg("warning", "⏳")
			: failCount > 0
				? theme.fg("warning", "◐")
				: theme.fg("success", "✓");
		const status = isRunning
			? `${successCount + failCount}/${details.results.length} done, ${running} running`
			: `${successCount}/${details.results.length} tasks`;

		if (expanded && !isRunning) {
			const container = new Container();
			container.addChild(
				new Text(`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`, 0, 0),
			);

			for (const r of details.results) {
				const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				container.addChild(new Spacer(1));
				container.addChild(new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0));
				container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
				if (r.taskId) {
					let idLine = theme.fg("muted", "Task ID: ") + theme.fg("dim", r.taskId);
					if (r.sessionId && r.sessionId !== r.taskId) idLine += theme.fg("muted", `  Session: ${r.sessionId}`);
					container.addChild(new Text(idLine, 0, 0));
				}

				for (const item of displayItems) {
					if (item.type === "toolCall") {
						container.addChild(
							new Text(
								theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
								0,
								0,
							),
						);
					}
				}

				if (finalOutput) {
					container.addChild(new Spacer(1));
					container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
				}

				const taskUsage = formatUsageStats(r.usage, r.provider, r.model);
				if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
			}

			const usageStr = formatUsageStats(aggregateUsage(details.results));
			if (usageStr) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
			}
			return container;
		}

		let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
		for (const r of details.results) {
			const rIcon =
				r.exitCode === -1
					? theme.fg("warning", "⏳")
					: r.exitCode === 0
						? theme.fg("success", "✓")
						: theme.fg("error", "✗");
			const displayItems = getDisplayItems(r.messages);
			text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
			if (displayItems.length === 0) {
				text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
			} else {
				text += `\n${renderDisplayItems(displayItems, 5)}`;
			}
		}
		if (!isRunning) {
			const usageStr = formatUsageStats(aggregateUsage(details.results));
			if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
		}
		if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
		return new Text(text, 0, 0);
	}

	const text = result.content[0];
	return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
}

async function executeDelegationTool(
	params: DelegationParams,
	signal: AbortSignal | undefined,
	onUpdate: ((partial: AgentToolResult<SubagentDetails>) => void) | undefined,
	ctx: Parameters<ToolDefinition["execute"]>[4],
): Promise<AgentToolResult<SubagentDetails>> {
	const parentSessionId = ctx.sessionManager.getSessionId();
	const parentModel = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
	const agentScope: AgentScope = params.agentScope ?? "user";
	const discovery = discoverAgents(ctx.cwd, agentScope);
	const agents = discovery.agents;
	const confirmProjectAgents = params.confirmProjectAgents ?? true;

	const hasChain = (params.chain?.length ?? 0) > 0;
	const hasTasks = (params.tasks?.length ?? 0) > 0;
	const hasSingle = Boolean(params.agent && params.task);
	const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

	const makeDetails =
		(mode: "single" | "parallel" | "chain") =>
		(results: SingleResult[]): SubagentDetails => ({
			mode,
			agentScope,
			projectAgentsDir: discovery.projectAgentsDir,
			results,
		});

	if (modeCount !== 1) {
		const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
		return {
			content: [
				{ type: "text", text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}` },
			],
			details: makeDetails("single")([]),
		};
	}

	if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
		const requestedAgentNames = new Set<string>();
		if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
		if (params.tasks) for (const task of params.tasks) requestedAgentNames.add(task.agent);
		if (params.agent) requestedAgentNames.add(params.agent);

		const projectAgentsRequested = Array.from(requestedAgentNames)
			.map((name) => agents.find((a) => a.name === name))
			.filter((agent): agent is AgentConfig => agent?.source === "project");

		if (projectAgentsRequested.length > 0) {
			const names = projectAgentsRequested.map((agent) => agent.name).join(", ");
			const dir = discovery.projectAgentsDir ?? "(unknown)";
			const ok = await ctx.ui.confirm(
				"Run project-local agents?",
				`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
			);
			if (!ok) {
				return {
					content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
					details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
				};
			}
		}
	}

	if (params.chain && params.chain.length > 0) {
		const results: SingleResult[] = [];
		let previousOutput = "";

		for (let i = 0; i < params.chain.length; i++) {
			const step = params.chain[i];
			const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);
			const chainUpdate = onUpdate
				? (partial: AgentToolResult<SubagentDetails>) => {
						const currentResult = partial.details?.results[0];
						if (currentResult) {
							onUpdate({
								content: partial.content,
								details: makeDetails("chain")([...results, currentResult]),
							});
						}
					}
				: undefined;

			const result = await runSingleAgent(
				parentSessionId,
				ctx.cwd,
				agents,
				parentModel,
				agentScope,
				step.agent,
				taskWithContext,
				step.cwd,
				i + 1,
				signal,
				chainUpdate,
				makeDetails("chain"),
				ctx,
			);
			results.push(result);

			const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
			if (isError) {
				const errorMsg = result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
				const refHeader = formatReferenceHeader(result);
				return {
					content: [
						{
							type: "text",
							text: `${refHeader ? `${refHeader}\n\n` : ""}Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}`,
						},
					],
					details: makeDetails("chain")(results),
				};
			}
			previousOutput = getFinalOutput(result.messages);
		}

		const lastResult = results[results.length - 1];
		const refLines = results
			.map((result) => {
				const refHeader = formatReferenceHeader(result);
				return refHeader ? `step ${result.step ?? "?"} ${result.agent}:\n${refHeader}` : undefined;
			})
			.filter((line): line is string => Boolean(line));
		const finalOutput = getFinalOutput(lastResult.messages) || "(no output)";
		return {
			content: [
				{
					type: "text",
					text: `${refLines.length > 0 ? `${refLines.join("\n\n")}\n\n` : ""}${finalOutput}`,
				},
			],
			details: makeDetails("chain")(results),
		};
	}

	if (params.tasks && params.tasks.length > 0) {
		if (params.tasks.length > MAX_PARALLEL_TASKS) {
			return {
				content: [
					{
						type: "text",
						text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
					},
				],
				details: makeDetails("parallel")([]),
			};
		}

		const allResults: SingleResult[] = new Array(params.tasks.length);
		for (let i = 0; i < params.tasks.length; i++) {
			allResults[i] = {
				agent: params.tasks[i].agent,
				agentSource: "unknown",
				task: params.tasks[i].task,
				exitCode: -1,
				messages: [],
				stderr: "",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			};
		}

		const emitParallelUpdate = () => {
			if (onUpdate) {
				const running = allResults.filter((result) => result.exitCode === -1).length;
				const done = allResults.filter((result) => result.exitCode !== -1).length;
				onUpdate({
					content: [{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` }],
					details: makeDetails("parallel")([...allResults]),
				});
			}
		};

		const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (task, index) => {
			const result = await runSingleAgent(
				parentSessionId,
				ctx.cwd,
				agents,
				parentModel,
				agentScope,
				task.agent,
				task.task,
				task.cwd,
				undefined,
				signal,
				(partial) => {
					if (partial.details?.results[0]) {
						allResults[index] = partial.details.results[0];
						emitParallelUpdate();
					}
				},
				makeDetails("parallel"),
				ctx,
			);
			allResults[index] = result;
			emitParallelUpdate();
			return result;
		});

		const successCount = results.filter((result) => result.exitCode === 0).length;
		const summaries = results.map((result) => {
			const output = getFinalOutput(result.messages);
			const preview = output.slice(0, 100) + (output.length > 100 ? "..." : "");
			const refHeader = formatReferenceHeader(result);
			const status = `[${result.agent}] ${result.exitCode === 0 ? "completed" : "failed"}: ${preview || "(no output)"}`;
			return refHeader ? `${status}\n${refHeader}` : status;
		});
		return {
			content: [
				{
					type: "text",
					text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}`,
				},
			],
			details: makeDetails("parallel")(results),
		};
	}

	if (params.agent && params.task) {
		const result = await runSingleAgent(
			parentSessionId,
			ctx.cwd,
			agents,
			parentModel,
			agentScope,
			params.agent,
			params.task,
			params.cwd,
			undefined,
			signal,
			onUpdate,
			makeDetails("single"),
			ctx,
		);
		const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
		const refHeader = formatReferenceHeader(result);
		if (isError) {
			const errorMsg = result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
			return {
				content: [
					{
						type: "text",
						text: `${refHeader ? `${refHeader}\n\n` : ""}Agent ${result.stopReason || "failed"}: ${errorMsg}`,
					},
				],
				details: makeDetails("single")([result]),
			};
		}
		return {
			content: [
				{
					type: "text",
					text: `${refHeader ? `${refHeader}\n\n` : ""}${getFinalOutput(result.messages) || "(no output)"}`,
				},
			],
			details: makeDetails("single")([result]),
		};
	}

	const available = agents.map((agent) => `${agent.name} (${agent.source})`).join(", ") || "none";
	return {
		content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
		details: makeDetails("single")([]),
	};
}

function registerSubagentSessionTracking(pi: ExtensionAPI): void {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "subagent") {
			return;
		}

		if (!isSubagentSessionFile(ctx.sessionManager.getSessionFile())) {
			return;
		}

		const storedTask = findStoredTaskReferenceOnDisk(ctx.sessionManager.getSessionId());
		if (storedTask?.allowSubagents) {
			return;
		}

		return {
			block: true,
			reason:
				"Nested subagents are disabled for delegated sessions. Set allowSubagents: true in the agent frontmatter to opt in.",
		};
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "subagent") {
			return;
		}

		const details = event.details as SubagentDetails | undefined;
		if (!details || details.results.length === 0) {
			return;
		}

		const leaf = ctx.sessionManager.getLeafEntry();
		if (!leaf) {
			return;
		}

		const currentLabel = ctx.sessionManager.getLabel(leaf.id);
		if (currentLabel && !currentLabel.startsWith("subagent")) {
			return;
		}

		const label = getSubagentTreeLabel(details);
		if (label) {
			pi.setLabel(leaf.id, label);
		}
	});
}

export function registerSubagentTools(pi: ExtensionAPI): void {
	registerSubagentSessionTracking(pi);

	const sharedGuidelines = [
		"Use delegated subagents for focused work that benefits from isolated context, not for trivial one-step tasks.",
		"Use parallel tasks only for independent work, and chains only when later steps depend on earlier output.",
		"Prefer user-scoped agents by default. Enable project-scoped agents only in repositories you trust.",
	];

	const subagentTool: ToolDefinition<typeof SubagentParams, SubagentDetails> = {
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized hirocode subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			'Default agent scope is "user" (from ~/.hirocode/agent/agents).',
			'To enable project-local agents in .hirocode/agents, set agentScope: "both" (or "project").',
		].join(" "),
		promptSnippet: "Delegate isolated work to a specialized subagent",
		promptGuidelines: sharedGuidelines,
		surfaceStyle: "boxed",
		surfaceBackground: "toolPendingBg",
		parameters: SubagentParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			return executeDelegationTool(params, signal, onUpdate, ctx);
		},
		renderCall(args, theme, context) {
			return renderDelegationCallComponent("subagent", args, theme, context);
		},
		renderResult(result, options, theme) {
			return renderDelegationResult(result, options, theme);
		},
	};
	pi.registerTool(subagentTool);
}

export default function (pi: ExtensionAPI) {
	registerSubagentTools(pi);
}
