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

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "@sinclair/typebox";
import type { AgentToolResult } from "../../../../agent/src/index.js";
import { type Api, type Message, type Model, StringEnum } from "../../../../ai/src/index.js";
import { Container, Loader, Markdown, Spacer, Text } from "../../../../tui/src/index.js";
import type { ExtensionAPI, ToolDefinition } from "../../../src/core/extensions/types.js";
import type { SessionEntry } from "../../../src/core/session-manager.js";
import { withFileMutationQueue } from "../../../src/core/tools/file-mutation-queue.js";
import { getMarkdownTheme } from "../../../src/modes/interactive/theme/theme.js";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.js";
import {
	createTaskReference,
	findStoredTaskReferenceInBranch,
	findStoredTaskReferenceOnDisk,
	formatTaskReferenceLines,
	formatTaskToolOutput,
	initializeTaskSession,
	isSubagentSessionFile,
	persistTaskReference,
	type StoredTaskReference,
} from "./task-persistence.js";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const PRIMARY_CLI_NAME = "hirocode";
const NPX_BINARY = process.platform === "win32" ? "npx.cmd" : "npx";
const TSX_CLI_RELATIVE_PATH = path.join("node_modules", "tsx", "dist", "cli.mjs");
const SUBAGENT_RECORD_ENTRY_TYPE = "subagent-record";

type RenderTheme = Parameters<NonNullable<ToolDefinition["renderCall"]>>[1];
type RenderResultOptions = Parameters<NonNullable<ToolDefinition["renderResult"]>>[1];
type ParentModelReference = Pick<Model<Api>, "provider" | "id">;

export function formatModelReference(provider: string | undefined, modelId: string | undefined): string | undefined {
	if (!modelId) {
		return undefined;
	}

	if (!provider) {
		return modelId;
	}

	return `${provider}/${modelId}`;
}

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

export function resolveEffectiveSubagentModel(
	agentModel: string | undefined,
	parentModel: ParentModelReference | undefined,
	storedTask?: Pick<StoredTaskReference, "provider" | "model">,
): { provider?: string; modelId?: string; modelArg?: string } {
	if (storedTask?.model) {
		return {
			provider: storedTask.provider,
			modelId: storedTask.model,
			modelArg: formatModelReference(storedTask.provider, storedTask.model) ?? storedTask.model,
		};
	}

	if (agentModel) {
		const slashIndex = agentModel.indexOf("/");
		if (slashIndex !== -1) {
			const provider = agentModel.slice(0, slashIndex).trim();
			const modelId = agentModel.slice(slashIndex + 1).trim();
			return {
				provider: provider || undefined,
				modelId: modelId || agentModel,
				modelArg: agentModel,
			};
		}

		return { modelId: agentModel, modelArg: agentModel };
	}

	if (parentModel) {
		return {
			provider: parentModel.provider,
			modelId: parentModel.id,
			modelArg: `${parentModel.provider}/${parentModel.id}`,
		};
	}

	return {};
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
	agentSource: "user" | "project" | "unknown";
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

interface TaskAliasParams {
	description: string;
	prompt: string;
	subagent_type: string;
	task_id?: string;
	command?: string;
	cwd?: string;
	agentScope?: AgentScope;
	confirmProjectAgents?: boolean;
}

interface SubagentRecord {
	toolName: "subagent" | "task";
	mode: SubagentDetails["mode"];
	taskId: string;
	sessionId?: string;
	sessionFile: string;
	metadataFile: string;
	parentSessionId: string;
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	status: "running" | "completed" | "failed" | "error" | "aborted";
	step?: number;
}

function isSubagentRecord(value: unknown): value is SubagentRecord {
	if (!value || typeof value !== "object") {
		return false;
	}

	const record = value as SubagentRecord;
	return (
		typeof record.toolName === "string" &&
		typeof record.mode === "string" &&
		typeof record.taskId === "string" &&
		typeof record.sessionFile === "string" &&
		typeof record.metadataFile === "string" &&
		typeof record.parentSessionId === "string" &&
		typeof record.agent === "string" &&
		typeof record.task === "string" &&
		typeof record.status === "string"
	);
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

function getSubagentStatus(result: SingleResult): SubagentRecord["status"] {
	if (result.stopReason === "aborted") {
		return "aborted";
	}

	if (result.stopReason === "error") {
		return "error";
	}

	return result.exitCode === 0 ? "completed" : "failed";
}

function createSubagentRecord(
	toolName: SubagentRecord["toolName"],
	mode: SubagentRecord["mode"],
	result: SingleResult,
	status: SubagentRecord["status"] = getSubagentStatus(result),
): SubagentRecord | undefined {
	if (!result.taskId || !result.sessionFile || !result.metadataFile || !result.parentSessionId) {
		return undefined;
	}

	return {
		toolName,
		mode,
		taskId: result.taskId,
		sessionId: result.sessionId,
		sessionFile: result.sessionFile,
		metadataFile: result.metadataFile,
		parentSessionId: result.parentSessionId,
		agent: result.agent,
		agentSource: result.agentSource,
		task: result.task,
		status,
		step: result.step,
	};
}

function getSubagentRecordKey(record: Pick<SubagentRecord, "taskId" | "sessionId">): string {
	return record.sessionId ?? record.taskId;
}

function getSubagentStatusWeight(status: SubagentRecord["status"]): number {
	switch (status) {
		case "running":
			return 0;
		case "completed":
			return 1;
		case "aborted":
			return 2;
		case "error":
			return 3;
		case "failed":
			return 4;
	}
}

function sortSubagentRecords(records: Array<{ entryId: string; record: SubagentRecord }>): Array<{
	entryId: string;
	record: SubagentRecord;
}> {
	return [...records].sort(
		(left, right) => getSubagentStatusWeight(left.record.status) - getSubagentStatusWeight(right.record.status),
	);
}

function findLatestSubagentRecord(
	entries: SessionEntry[],
	match: Pick<SubagentRecord, "taskId" | "sessionId">,
): SubagentRecord | undefined {
	const key = getSubagentRecordKey(match);
	return getLatestSubagentRecords(entries).find(({ record }) => getSubagentRecordKey(record) === key)?.record;
}

function getSubagentTreeLabel(toolName: string, details: SubagentDetails): string | undefined {
	if (details.results.length === 0) {
		return undefined;
	}

	if (details.mode === "single" && details.results.length === 1) {
		return `${toolName}:${details.results[0].agent}`;
	}

	return `${toolName}:${details.mode}-${details.results.length}`;
}

function getLatestSubagentRecords(entries: SessionEntry[]): Array<{ entryId: string; record: SubagentRecord }> {
	const latest = new Map<string, { entryId: string; record: SubagentRecord }>();

	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "custom" || entry.customType !== SUBAGENT_RECORD_ENTRY_TYPE || !isSubagentRecord(entry.data)) {
			continue;
		}

		const key = entry.data.sessionId ?? entry.data.taskId;
		if (!latest.has(key)) {
			latest.set(key, { entryId: entry.id, record: entry.data });
		}
	}

	return Array.from(latest.values());
}

function matchesSubagentRecord(record: SubagentRecord, query: string): boolean {
	const normalized = query.trim().toLowerCase();
	if (!normalized) {
		return true;
	}

	return [record.agent, record.task, record.taskId, record.sessionId, record.status]
		.filter((value): value is string => Boolean(value))
		.some((value) => value.toLowerCase().includes(normalized));
}

function formatSubagentRecord(record: SubagentRecord): string {
	const icon =
		record.status === "running"
			? "⏳"
			: record.status === "completed"
				? "✓"
				: record.status === "aborted"
					? "⏹"
					: "✗";
	const scope = `${record.agent} (${record.agentSource})`;
	const preview = record.task.length > 70 ? `${record.task.slice(0, 70)}...` : record.task;
	return `${icon} ${scope} - ${preview}`;
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

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "hirocode-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function isTypeScriptEntrypoint(filePath: string): boolean {
	const ext = path.extname(filePath).toLowerCase();
	return ext === ".ts" || ext === ".mts" || ext === ".cts";
}

function findLocalTsxCliEntrypoint(startDir: string): string | undefined {
	let currentDir = startDir;
	while (true) {
		const candidate = path.join(currentDir, TSX_CLI_RELATIVE_PATH);
		if (fs.existsSync(candidate)) {
			return candidate;
		}

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) {
			return undefined;
		}
		currentDir = parentDir;
	}
}

export function resolveAgentInvocation(
	args: string[],
	options?: { currentScript?: string; execPath?: string },
): { command: string; args: string[] } {
	const currentScript = options?.currentScript ?? process.argv[1];
	const execPath = options?.execPath ?? process.execPath;
	const execName = path.basename(execPath).toLowerCase();
	const isNodeRuntime = /^(node)(\.exe)?$/.test(execName);
	const isBunRuntime = /^(bun)(\.exe)?$/.test(execName);

	if (currentScript && fs.existsSync(currentScript)) {
		if (isNodeRuntime && isTypeScriptEntrypoint(currentScript)) {
			const localTsxCli = findLocalTsxCliEntrypoint(path.dirname(currentScript));
			if (localTsxCli) {
				return { command: execPath, args: [localTsxCli, currentScript, ...args] };
			}
			return { command: NPX_BINARY, args: ["tsx", currentScript, ...args] };
		}

		return { command: execPath, args: [currentScript, ...args] };
	}

	if (!isNodeRuntime && !isBunRuntime) {
		return { command: execPath, args };
	}

	return { command: PRIMARY_CLI_NAME, args };
}

function getAgentInvocation(args: string[]): { command: string; args: string[] } {
	return resolveAgentInvocation(args);
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;
type OnStartCallback = (result: SingleResult) => void;

async function runSingleAgent(
	parentSessionId: string,
	parentSessionFile: string | undefined,
	defaultCwd: string,
	agents: AgentConfig[],
	parentModel: ParentModelReference | undefined,
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onStart: OnStartCallback | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	storedTask?: StoredTaskReference,
): Promise<SingleResult> {
	const discoveredAgent = agents.find((candidate) => candidate.name === agentName);
	const agent = storedTask
		? {
				name: storedTask.agent,
				source: storedTask.agentSource,
				allowSubagents: storedTask.allowSubagents,
				model: storedTask.model,
				tools: storedTask.tools,
				systemPrompt: storedTask.systemPrompt ?? "",
			}
		: discoveredAgent;

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

	const effectiveModel = resolveEffectiveSubagentModel(discoveredAgent?.model, parentModel, storedTask);

	const taskRef =
		storedTask ??
		createTaskReference(parentSessionId, {
			agent: agent.name,
			agentSource: agent.source,
			allowSubagents: agent.allowSubagents,
			provider: effectiveModel.provider,
			model: effectiveModel.modelId,
			tools: agent.tools,
			systemPrompt: agent.systemPrompt,
		});
	initializeTaskSession(taskRef, cwd ?? defaultCwd, parentSessionFile);
	persistTaskReference(taskRef);

	const args: string[] = ["--mode", "json", "-p", "--session", taskRef.sessionFile];
	const configuredTools = agent.allowSubagents
		? agent.tools
		: agent.tools?.filter((toolName) => {
				const normalized = toolName.toLowerCase();
				return normalized !== "task" && normalized !== "subagent";
			});
	if (effectiveModel.modelArg) args.push("--model", effectiveModel.modelArg);
	if (configuredTools && configuredTools.length > 0) args.push("--tools", configuredTools.join(","));
	if (configuredTools && configuredTools.length === 0) args.push("--no-tools");

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		taskId: taskRef.taskId,
		parentSessionId: taskRef.parentSessionId,
		sessionId: taskRef.sessionId,
		sessionFile: taskRef.sessionFile,
		metadataFile: taskRef.metadataFile,
		provider: effectiveModel.provider,
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: effectiveModel.modelId,
		tools: configuredTools,
		systemPrompt: agent.systemPrompt,
		resumed: Boolean(storedTask),
		step,
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};
	onStart?.(currentResult);

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);
		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getAgentInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "session") {
					currentResult.sessionId = typeof event.id === "string" ? event.id : currentResult.sessionId;
					persistTaskReference({
						...taskRef,
						provider: currentResult.provider,
						model: currentResult.model,
						sessionId: currentResult.sessionId,
					});
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (!currentResult.provider && typeof msg.provider === "string")
							currentResult.provider = msg.provider;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", () => {
				resolve(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		persistTaskReference({
			...taskRef,
			provider: currentResult.provider,
			model: currentResult.model,
			sessionId: currentResult.sessionId,
		});
		if (wasAborted) throw new Error("Subagent was aborted");
		return currentResult;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
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

const TaskToolParams = Type.Object({
	description: Type.String({ description: "A short description of the delegated task" }),
	prompt: Type.String({ description: "The task for the subagent to perform" }),
	subagent_type: Type.String({ description: "The name of the subagent to invoke" }),
	task_id: Type.Optional(
		Type.String({
			description:
				"Resume a delegated task created by this extension. Pass a prior task_id to continue the same child session.",
		}),
	),
	command: Type.Optional(Type.String({ description: "Optional command that triggered this task" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the subagent process" })),
});

function normalizeTaskAliasParams(params: TaskAliasParams): DelegationParams {
	return {
		agent: params.subagent_type,
		task: params.prompt,
		cwd: params.cwd,
		agentScope: params.agentScope,
		confirmProjectAgents: params.confirmProjectAgents,
	};
}

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
	storedTask?: StoredTaskReference,
	onTaskStart?: (mode: SubagentDetails["mode"], result: SingleResult) => void,
): Promise<AgentToolResult<SubagentDetails>> {
	const parentSessionId = ctx.sessionManager.getSessionId();
	const parentSessionFile = ctx.sessionManager.getSessionFile();
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

	if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI && !storedTask) {
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
				parentSessionFile,
				ctx.cwd,
				agents,
				parentModel,
				step.agent,
				taskWithContext,
				step.cwd,
				i + 1,
				signal,
				(partialResult) => onTaskStart?.("chain", partialResult),
				chainUpdate,
				makeDetails("chain"),
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
				parentSessionFile,
				ctx.cwd,
				agents,
				parentModel,
				task.agent,
				task.task,
				task.cwd,
				undefined,
				signal,
				(partialResult) => onTaskStart?.("parallel", partialResult),
				(partial) => {
					if (partial.details?.results[0]) {
						allResults[index] = partial.details.results[0];
						emitParallelUpdate();
					}
				},
				makeDetails("parallel"),
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
		if (storedTask?.agentSource === "project" && confirmProjectAgents && ctx.hasUI) {
			const ok = await ctx.ui.confirm(
				"Resume project-local agent?",
				`Agent: ${storedTask.agent}\nSource: ${storedTask.sessionFile}\n\nThis task was created from a project-local agent. Only continue for trusted repositories.`,
			);
			if (!ok) {
				return {
					content: [{ type: "text", text: "Canceled: project-local agent resume not approved." }],
					details: makeDetails("single")([]),
				};
			}
		}

		const result = await runSingleAgent(
			parentSessionId,
			parentSessionFile,
			ctx.cwd,
			agents,
			parentModel,
			params.agent,
			params.task,
			params.cwd,
			undefined,
			signal,
			(partialResult) => onTaskStart?.("single", partialResult),
			onUpdate,
			makeDetails("single"),
			storedTask,
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

function registerSubagentCommands(pi: ExtensionAPI): void {
	pi.registerCommand("subagents", {
		description: "View or open delegated subagent sessions from this branch",
		handler: async (args, ctx) => {
			const records = sortSubagentRecords(getLatestSubagentRecords(ctx.sessionManager.getBranch())).filter(
				({ record }) => matchesSubagentRecord(record, args),
			);

			if (records.length === 0) {
				ctx.ui.notify(
					args.trim() ? `No subagents matched: ${args.trim()}` : "No delegated subagents in this branch",
					"info",
				);
				return;
			}

			const openRecord = async (record: SubagentRecord) => {
				if (!fs.existsSync(record.sessionFile)) {
					ctx.ui.notify(`Session file not found: ${record.sessionFile}`, "error");
					return;
				}
				await ctx.switchSession(record.sessionFile);
			};

			const switchToRecord = async (record: SubagentRecord) => {
				const latestRecord = findLatestSubagentRecord(ctx.sessionManager.getBranch(), record) ?? record;
				if (latestRecord.status === "running" && ctx.hasUI) {
					const choice = await ctx.ui.select("Open running subagent session?", [
						"Wait until idle (Recommended)",
						"Open now and interrupt current work",
					]);
					if (!choice) {
						return;
					}
					if (choice.startsWith("Wait until idle")) {
						ctx.ui.notify("Waiting for the current turn to finish before opening the child session...", "info");
						await ctx.waitForIdle();
					}
				}

				await openRecord(latestRecord);
			};

			if (records.length === 1 || !ctx.hasUI) {
				await switchToRecord(records[0].record);
				return;
			}

			const options = records.map(({ record }) => formatSubagentRecord(record));
			const selected = await ctx.ui.select("Subagent Sessions", options);
			if (!selected) {
				return;
			}

			const selectedRecord = records.find(({ record }) => formatSubagentRecord(record) === selected);
			if (!selectedRecord) {
				return;
			}

			await switchToRecord(selectedRecord.record);
		},
	});
}

function registerSubagentSessionTracking(pi: ExtensionAPI): void {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "subagent" && event.toolName !== "task") {
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
		if (event.toolName !== "subagent" && event.toolName !== "task") {
			return;
		}

		const details = event.details as SubagentDetails | undefined;
		if (!details || details.results.length === 0) {
			return;
		}

		const leaf = ctx.sessionManager.getLeafEntry();
		for (const result of details.results) {
			const record = createSubagentRecord(event.toolName, details.mode, result);
			if (record) {
				pi.appendEntry(SUBAGENT_RECORD_ENTRY_TYPE, record);
			}
		}

		if (!leaf) {
			return;
		}

		const currentLabel = ctx.sessionManager.getLabel(leaf.id);
		if (currentLabel && !currentLabel.startsWith("subagent") && !currentLabel.startsWith("task")) {
			return;
		}

		const label = getSubagentTreeLabel(event.toolName, details);
		if (label) {
			pi.setLabel(leaf.id, label);
		}
	});
}

export function registerSubagentTools(pi: ExtensionAPI): void {
	registerSubagentCommands(pi);
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
			return executeDelegationTool(params, signal, onUpdate, ctx, undefined, (mode, result) => {
				const record = createSubagentRecord("subagent", mode, result, "running");
				if (record) {
					pi.appendEntry(SUBAGENT_RECORD_ENTRY_TYPE, record);
				}
			});
		},
		renderCall(args, theme, context) {
			return renderDelegationCallComponent("subagent", args, theme, context);
		},
		renderResult(result, options, theme) {
			return renderDelegationResult(result, options, theme);
		},
	};
	pi.registerTool(subagentTool);

	const taskTool: ToolDefinition<typeof TaskToolParams, SubagentDetails> = {
		name: "task",
		label: "Task",
		description:
			"Task-tool-compatible alias for delegating one focused task to a specialized hirocode subagent with isolated context.",
		promptSnippet: "Delegate one focused task to a specialized subagent",
		promptGuidelines: ["Use task for a single delegated unit of work with one subagent_type.", ...sharedGuidelines],
		surfaceStyle: "boxed",
		surfaceBackground: "toolPendingBg",
		parameters: TaskToolParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const storedTask = params.task_id
				? (findStoredTaskReferenceInBranch(ctx.sessionManager.getBranch(), params.task_id) ??
					findStoredTaskReferenceOnDisk(params.task_id, ctx.sessionManager.getSessionId()))
				: undefined;

			if (params.task_id) {
				if (!storedTask) {
					return {
						content: [
							{
								type: "text",
								text: `Unknown task_id ${params.task_id}. Resume only works for task runs created by this extension.`,
							},
						],
						details: {
							mode: "single",
							agentScope: params.agentScope ?? "user",
							projectAgentsDir: null,
							results: [],
						},
					};
				}

				if (storedTask.agent !== params.subagent_type) {
					return {
						content: [
							{
								type: "text",
								text: `task_id ${params.task_id} belongs to subagent ${storedTask.agent}, but this request asked for ${params.subagent_type}. Resume the original subagent or start a fresh task.`,
							},
						],
						details: {
							mode: "single",
							agentScope: params.agentScope ?? "user",
							projectAgentsDir: null,
							results: [],
						},
					};
				}
			}

			const result = await executeDelegationTool(
				normalizeTaskAliasParams(params),
				signal,
				onUpdate,
				ctx,
				storedTask,
				(mode, singleResult) => {
					const record = createSubagentRecord("task", mode, singleResult, "running");
					if (record) {
						pi.appendEntry(SUBAGENT_RECORD_ENTRY_TYPE, record);
					}
				},
			);
			const single = result.details.results[0];
			if (!single?.taskId) {
				return result;
			}

			const summary =
				single.errorMessage ||
				getFinalOutput(single.messages) ||
				(result.content[0]?.type === "text" ? result.content[0].text : "(no output)");
			return {
				content: [
					{
						type: "text",
						text: formatTaskToolOutput({ taskId: single.taskId, sessionId: single.sessionId }, summary),
					},
				],
				details: result.details,
			};
		},
		renderCall(args, theme, context) {
			let text = formatDelegationCallText(
				"task",
				{
					agent: args.subagent_type,
					task: args.prompt,
					cwd: args.cwd,
					agentScope: args.agentScope,
				},
				theme,
			);
			if (args.task_id) {
				text += `\n  ${theme.fg("muted", "resume ")}${theme.fg("dim", args.task_id)}`;
			}
			return renderDelegationCallComponent(
				"task",
				{
					agent: args.subagent_type,
					task: args.prompt,
					cwd: args.cwd,
					agentScope: args.agentScope,
				},
				theme,
				context,
				text,
			);
		},
		renderResult(result, options, theme) {
			return renderDelegationResult(result, options, theme);
		},
	};
	pi.registerTool(taskTool);
}

export default function (pi: ExtensionAPI) {
	registerSubagentTools(pi);
}
