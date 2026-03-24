import { spawn } from "node:child_process";
import * as fs from "node:fs";
import type { Message } from "@hirocode/ai";
import { resolveAgentInvocation, resolveEffectiveSubagentModel, writePromptToTempFile } from "./invocation.js";
import { updateTaskSessionState } from "./task-sessions.js";
import type {
	AgentConfig,
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

function getConfiguredTools(agent: AgentConfig, parentActiveToolNames: string[]): string[] | undefined {
	const inheritedTools = agent.tools && agent.tools.length > 0 ? agent.tools : parentActiveToolNames;
	const configuredTools = agent.allowSubagents
		? inheritedTools
		: inheritedTools.filter((toolName) => {
				const normalized = toolName.toLowerCase();
				return normalized !== "task" && normalized !== "subagent";
			});

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
}): Promise<DelegatedTaskResult> {
	const effectiveModel = resolveEffectiveSubagentModel(options.agent.model, options.parentModel);
	const configuredTools = getConfiguredTools(options.agent, options.parentActiveToolNames);
	const args: string[] = ["--mode", "json", "-p", "--session", options.sessionRef.sessionFile];
	if (effectiveModel.modelArg) {
		args.push("--model", effectiveModel.modelArg);
	}
	if (configuredTools && configuredTools.length > 0) {
		args.push("--tools", configuredTools.join(","));
	}
	if (configuredTools && configuredTools.length === 0) {
		args.push("--no-tools");
	}

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
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${options.task}`);
		let wasAborted = false;
		const exitCode = await new Promise<number>((resolve) => {
			const invocation = resolveAgentInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: options.cwd ?? options.defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let buffer = "";

			const processLine = (line: string) => {
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

				const typedEvent = event as { type?: string; id?: string; message?: Message };
				if (typedEvent.type === "session" && typeof typedEvent.id === "string") {
					currentResult.sessionId = typedEvent.id;
					return;
				}

				if (typedEvent.type === "message_end" && typedEvent.message) {
					const message = typedEvent.message;
					currentResult.messages.push(message);
					if (message.role === "assistant") {
						currentResult.usage.turns += 1;
						const usage = message.usage;
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
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) {
					processLine(line);
				}
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) {
					processLine(buffer);
				}
				resolve(code ?? 0);
			});

			proc.on("error", () => {
				resolve(1);
			});

			if (options.signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) {
							proc.kill("SIGKILL");
						}
					}, 5000);
				};
				if (options.signal.aborted) {
					killProc();
				} else {
					options.signal.addEventListener("abort", killProc, { once: true });
				}
			}
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
		if (wasAborted) {
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
