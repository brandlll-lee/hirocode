import { spawn } from "node:child_process";
import * as fs from "node:fs";
import type { Message } from "@hirocode/ai";
import { attachJsonlLineReader, serializeJsonLine } from "../../modes/rpc/jsonl.js";
import { MCP_TOOLS_SENTINEL } from "./agent-registry.js";
import { resolveAgentInvocation, resolveEffectiveSubagentModel, writePromptToTempFile } from "./invocation.js";
import { updateTaskSessionState } from "./task-sessions.js";
import type {
	AgentConfig,
	DelegatedTaskApprovalHandler,
	DelegatedTaskResult,
	ParentModelReference,
	TaskSessionReference,
	UsageStats,
} from "./types.js";

const EMPTY_USAGE: UsageStats = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: 0,
	contextTokens: 0,
	turns: 0,
};

const STANDARD_TOOL_NAMES = new Set([
	"read",
	"bash",
	"edit",
	"write",
	"task",
	"todowrite",
	"grep",
	"find",
	"ls",
	"webfetch",
	"websearch",
]);

function resolveMcpSentinel(tools: string[], parentActiveToolNames: string[]): string[] {
	if (!tools.includes(MCP_TOOLS_SENTINEL)) return tools;
	const mcpTools = parentActiveToolNames.filter((t) => !STANDARD_TOOL_NAMES.has(t.toLowerCase()));
	return [...tools.filter((t) => t !== MCP_TOOLS_SENTINEL), ...mcpTools];
}

function getConfiguredTools(agent: AgentConfig, parentActiveToolNames: string[]): string[] | undefined {
	const rawTools = agent.tools && agent.tools.length > 0 ? agent.tools : parentActiveToolNames;
	const withMcp = resolveMcpSentinel(rawTools, parentActiveToolNames);
	const withoutTask = agent.allowSubagents
		? withMcp
		: withMcp.filter((toolName) => {
				const normalized = toolName.toLowerCase();
				return normalized !== "task" && normalized !== "subagent";
			});

	// Always ensure todowrite is available so subagents can track progress
	const configuredTools = withoutTask.includes("todowrite") ? withoutTask : [...withoutTask, "todowrite"];

	return configuredTools.length > 0 ? [...new Set(configuredTools)] : [];
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") {
			continue;
		}
		for (const part of message.content) {
			if (part.type === "text") {
				return part.text;
			}
		}
	}
	return "";
}

export async function runDelegatedTask(options: {
	sessionRef: TaskSessionReference;
	agent: AgentConfig;
	task: string;
	defaultCwd: string;
	cwd?: string;
	parentModel?: ParentModelReference;
	parentActiveToolNames: string[];
	signal?: AbortSignal;
	onUpdate?: (result: DelegatedTaskResult) => void;
	resumed?: boolean;
	approvalHandler?: DelegatedTaskApprovalHandler;
}): Promise<DelegatedTaskResult> {
	const effectiveModel = resolveEffectiveSubagentModel(
		options.agent.model,
		options.agent.reasoningEffort,
		options.parentModel,
	);
	const configuredTools = getConfiguredTools(options.agent, options.parentActiveToolNames);
	let tmpPromptDir: string | undefined;
	let tmpPromptPath: string | undefined;
	const currentResult: DelegatedTaskResult = {
		taskId: options.sessionRef.taskId,
		parentSessionId: options.sessionRef.parentSessionId,
		parentSessionFile: options.sessionRef.parentSessionFile,
		sessionId: options.sessionRef.sessionId,
		sessionFile: options.sessionRef.sessionFile,
		provider: effectiveModel.provider,
		agent: options.agent.name,
		agentSource: options.agent.source,
		task: options.task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { ...EMPTY_USAGE },
		model: effectiveModel.modelId,
		tools: configuredTools,
		systemPrompt: options.agent.systemPrompt,
		resumed: options.resumed,
	};

	const emitUpdate = () => {
		options.onUpdate?.({
			...currentResult,
			messages: [...currentResult.messages],
			usage: { ...currentResult.usage },
		});
	};

	try {
		if (options.agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(options.agent.name, options.agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
		}

		const exitCode = options.approvalHandler
			? await runDelegatedTaskWithRpc({
					options,
					currentResult,
					configuredTools,
					effectiveModel,
					tmpPromptPath,
					emitUpdate,
				})
			: await runDelegatedTaskWithJson({
					options,
					currentResult,
					configuredTools,
					effectiveModel,
					tmpPromptPath,
					emitUpdate,
				});

		currentResult.exitCode = exitCode;
		updateTaskSessionState(currentResult.sessionFile, {
			status:
				currentResult.stopReason === "aborted"
					? "aborted"
					: currentResult.stopReason === "error"
						? "error"
						: exitCode === 0
							? "completed"
							: "failed",
			task: options.task,
			description: options.agent.description,
			errorMessage: currentResult.errorMessage,
		});
		if (options.signal?.aborted) {
			throw new Error("Delegated task was aborted");
		}
		return currentResult;
	} finally {
		if (tmpPromptPath) {
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				// ignore cleanup failures
			}
		}
		if (tmpPromptDir) {
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				// ignore cleanup failures
			}
		}
	}
}

export function getDelegatedTaskOutput(messages: Message[]): string {
	return getFinalOutput(messages);
}

function buildCliArgs(options: {
	mode: "json" | "rpc";
	sessionFile: string;
	modelArg?: string;
	thinkingArg?: string;
	configuredTools?: string[];
	tmpPromptPath?: string;
	task?: string;
}): string[] {
	const args: string[] = ["--mode", options.mode];
	if (options.mode === "json") {
		args.push("-p");
	}
	args.push("--session", options.sessionFile);
	if (options.modelArg) {
		args.push("--model", options.modelArg);
	}
	if (options.thinkingArg) {
		args.push("--thinking", options.thinkingArg);
	}
	if (options.configuredTools && options.configuredTools.length > 0) {
		args.push("--tools", options.configuredTools.join(","));
	}
	if (options.configuredTools && options.configuredTools.length === 0) {
		args.push("--no-tools");
	}
	if (options.tmpPromptPath) {
		args.push("--append-system-prompt", options.tmpPromptPath);
	}
	if (options.mode === "json" && options.task) {
		args.push(`Task: ${options.task}`);
	}
	return args;
}

async function runDelegatedTaskWithJson(options: {
	options: {
		sessionRef: TaskSessionReference;
		agent: AgentConfig;
		task: string;
		defaultCwd: string;
		cwd?: string;
		signal?: AbortSignal;
	};
	currentResult: DelegatedTaskResult;
	configuredTools?: string[];
	effectiveModel: { modelArg?: string; thinkingArg?: string };
	tmpPromptPath?: string;
	emitUpdate: () => void;
}): Promise<number> {
	let wasAborted = false;
	return new Promise<number>((resolve) => {
		const args = buildCliArgs({
			mode: "json",
			sessionFile: options.options.sessionRef.sessionFile,
			modelArg: options.effectiveModel.modelArg,
			thinkingArg: options.effectiveModel.thinkingArg,
			configuredTools: options.configuredTools,
			tmpPromptPath: options.tmpPromptPath,
			task: options.options.task,
		});
		const invocation = resolveAgentInvocation(args);
		const proc = spawn(invocation.command, invocation.args, {
			cwd: options.options.cwd ?? options.options.defaultCwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let buffer = "";

		proc.stdout.on("data", (data) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) {
				processDelegatedEvent(line, options.currentResult, options.emitUpdate);
			}
		});

		proc.stderr.on("data", (data) => {
			options.currentResult.stderr += data.toString();
		});

		proc.on("close", (code) => {
			if (buffer.trim()) {
				processDelegatedEvent(buffer, options.currentResult, options.emitUpdate);
			}
			resolve(wasAborted ? 1 : (code ?? 0));
		});

		proc.on("error", () => {
			resolve(1);
		});

		if (options.options.signal) {
			const killProc = () => {
				wasAborted = true;
				proc.kill("SIGTERM");
				setTimeout(() => {
					if (!proc.killed) {
						proc.kill("SIGKILL");
					}
				}, 5000);
			};
			if (options.options.signal.aborted) {
				killProc();
			} else {
				options.options.signal.addEventListener("abort", killProc, { once: true });
			}
		}
	});
}

async function runDelegatedTaskWithRpc(options: {
	options: {
		sessionRef: TaskSessionReference;
		agent: AgentConfig;
		task: string;
		defaultCwd: string;
		cwd?: string;
		signal?: AbortSignal;
		approvalHandler?: DelegatedTaskApprovalHandler;
	};
	currentResult: DelegatedTaskResult;
	configuredTools?: string[];
	effectiveModel: { modelArg?: string; thinkingArg?: string };
	tmpPromptPath?: string;
	emitUpdate: () => void;
}): Promise<number> {
	const args = buildCliArgs({
		mode: "rpc",
		sessionFile: options.options.sessionRef.sessionFile,
		modelArg: options.effectiveModel.modelArg,
		thinkingArg: options.effectiveModel.thinkingArg,
		configuredTools: options.configuredTools,
		tmpPromptPath: options.tmpPromptPath,
	});
	const invocation = resolveAgentInvocation(args);
	const proc = spawn(invocation.command, invocation.args, {
		cwd: options.options.cwd ?? options.options.defaultCwd,
		shell: false,
		stdio: ["pipe", "pipe", "pipe"],
	});
	let nextRequestId = 0;
	let wasAborted = false;
	let approvalQueue = Promise.resolve();
	const pendingResponses = new Map<
		string,
		{
			resolve: (value: { success: boolean; error?: string }) => void;
			reject: (error: Error) => void;
		}
	>();
	const rejectPendingResponses = (error: Error) => {
		for (const pending of pendingResponses.values()) {
			pending.reject(error);
		}
		pendingResponses.clear();
	};
	const closePromise = new Promise<void>((resolve) => {
		proc.on("close", () => resolve());
	});

	// Resolves true when agent_end is received (agent finished), false if process exits unexpectedly
	let completionResolve!: (done: boolean) => void;
	const completionPromise = new Promise<boolean>((resolve) => {
		completionResolve = resolve;
	});
	proc.on("close", () => completionResolve(false));

	const sendCommand = async (command: Record<string, unknown>): Promise<{ success: boolean; error?: string }> => {
		if (!proc.stdin || proc.killed) {
			throw new Error("Delegated runtime is no longer available.");
		}
		const id = `rpc-${++nextRequestId}`;
		const payload = { ...command, id };
		const response = new Promise<{ success: boolean; error?: string }>((resolve, reject) => {
			pendingResponses.set(id, { resolve, reject });
		});
		proc.stdin.write(serializeJsonLine(payload));
		return response;
	};

	const stopReadingStdout = attachJsonlLineReader(proc.stdout!, (line) => {
		if (!line.trim()) {
			return;
		}
		let event: unknown;
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}
		if (!event || typeof event !== "object") {
			return;
		}
		const typedEvent = event as {
			type?: string;
			id?: string;
			success?: boolean;
			error?: string;
			requestId?: string;
			summary?: string;
			kind?: string;
		};
		if (typedEvent.type === "agent_end") {
			completionResolve(true);
			return;
		}
		if (typedEvent.type === "response" && typeof typedEvent.id === "string") {
			const pending = pendingResponses.get(typedEvent.id);
			if (!pending) {
				return;
			}
			pendingResponses.delete(typedEvent.id);
			pending.resolve({ success: typedEvent.success !== false, error: typedEvent.error });
			return;
		}
		if (
			typedEvent.type === "approval_requested" &&
			typeof typedEvent.requestId === "string" &&
			typeof typedEvent.summary === "string" &&
			typeof typedEvent.kind === "string" &&
			options.options.approvalHandler
		) {
			approvalQueue = approvalQueue.then(async () => {
				const decision = await options.options.approvalHandler?.({
					requestId: typedEvent.requestId!,
					summary: typedEvent.summary!,
					kind: typedEvent.kind!,
					taskId: options.currentResult.taskId,
					sessionId: options.currentResult.sessionId,
					sessionFile: options.currentResult.sessionFile,
					agent: options.currentResult.agent,
				});
				if (proc.killed) {
					return;
				}
				if (decision?.approved === false) {
					await sendCommand({
						type: "reject",
						requestId: typedEvent.requestId,
						reason: decision.reason,
					});
					return;
				}
				await sendCommand({ type: "approve", requestId: typedEvent.requestId });
			});
			return;
		}
		processDelegatedEvent(line, options.currentResult, options.emitUpdate);
	});

	proc.stderr.on("data", (data) => {
		options.currentResult.stderr += data.toString();
	});

	proc.on("error", (error) => {
		rejectPendingResponses(error instanceof Error ? error : new Error(String(error)));
	});

	const shutdown = async () => {
		stopReadingStdout();
		if (proc.stdin && !proc.stdin.destroyed) {
			proc.stdin.end();
		}
		if (!proc.killed) {
			proc.kill("SIGTERM");
			setTimeout(() => {
				if (!proc.killed) {
					proc.kill("SIGKILL");
				}
			}, 5000);
		}
		await closePromise;
	};

	if (options.options.signal) {
		const killProc = () => {
			wasAborted = true;
			rejectPendingResponses(new Error("Delegated task was aborted"));
			if (!proc.killed) {
				proc.kill("SIGTERM");
				setTimeout(() => {
					if (!proc.killed) {
						proc.kill("SIGKILL");
					}
				}, 5000);
			}
		};
		if (options.options.signal.aborted) {
			killProc();
		} else {
			options.options.signal.addEventListener("abort", killProc, { once: true });
		}
	}

	try {
		const promptResponse = await sendCommand({
			type: "prompt",
			message: `Task: ${options.options.task}`,
		});

		if (!promptResponse.success) {
			// prompt 命令本身失败，agent 根本没启动
			options.currentResult.errorMessage = promptResponse.error;
			await shutdown();
			return 1;
		}

		// 等待 agent 实际完成所有 LLM 工作（收到 agent_end），或进程意外退出
		const agentCompleted = await completionPromise;
		await approvalQueue;

		const exitCode =
			!agentCompleted ||
			options.currentResult.stopReason === "error" ||
			options.currentResult.stopReason === "aborted"
				? 1
				: 0;
		await shutdown();
		return wasAborted ? 1 : exitCode;
	} finally {
		await shutdown().catch(() => {});
	}
}

function processDelegatedEvent(line: string, currentResult: DelegatedTaskResult, emitUpdate: () => void): void {
	let event: unknown;
	try {
		event = JSON.parse(line);
	} catch {
		return;
	}

	if (!event || typeof event !== "object") {
		return;
	}

	const typedEvent = event as { type?: string; id?: string; message?: Message };
	if (typedEvent.type === "session" && typeof typedEvent.id === "string") {
		currentResult.sessionId = typedEvent.id;
		return;
	}

	if (typedEvent.type === "message_end" && typedEvent.message) {
		const message = typedEvent.message;
		currentResult.messages.push(message);
		if (message.role === "assistant") {
			const usage = message.usage;
			currentResult.usage.turns += 1;
			currentResult.usage.input += usage.input || 0;
			currentResult.usage.output += usage.output || 0;
			currentResult.usage.cacheRead += usage.cacheRead || 0;
			currentResult.usage.cacheWrite += usage.cacheWrite || 0;
			currentResult.usage.cost += usage.cost?.total || 0;
			currentResult.usage.contextTokens = usage.totalTokens || 0;
			if (!currentResult.model && message.model) {
				currentResult.model = message.model;
			}
			if (!currentResult.provider && typeof message.provider === "string") {
				currentResult.provider = message.provider;
			}
			if (message.stopReason) {
				currentResult.stopReason = message.stopReason;
			}
			if (message.errorMessage) {
				currentResult.errorMessage = message.errorMessage;
			}
		}
		emitUpdate();
		return;
	}

	if (typedEvent.type === "tool_result_end" && typedEvent.message) {
		currentResult.messages.push(typedEvent.message);
		emitUpdate();
	}
}
