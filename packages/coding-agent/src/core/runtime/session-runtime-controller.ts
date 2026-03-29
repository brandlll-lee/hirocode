import type { AgentMessage } from "@hirocode/agent-core";
import type { AgentSession, AgentSessionEvent, ExtensionBindings } from "../agent-session.js";
import {
	createSessionSafetyServices,
	registerSessionSafetyServices,
	type SessionSafetyServices,
	unregisterSessionSafetyServices,
} from "../approval/runtime-services.js";
import type { ExtensionErrorListener, ExtensionUIContext, InputSource, ShutdownHandler } from "../extensions/index.js";
import {
	normalizeRuntimeClientCapabilities,
	normalizeRuntimeSessionMetadata,
	writeRuntimeSessionMetadata,
} from "../protocol/session-metadata.js";
import { createRuntimeSessionSnapshot } from "../protocol/session-state.js";
import type {
	RuntimeClientCapabilities,
	RuntimeCommandResult,
	RuntimeControlCommand,
	RuntimeDecoratedSessionEvent,
	RuntimeEventEnvelope,
	RuntimeEventListener,
	RuntimeProtocolEvent,
	RuntimeSessionMetadata,
	RuntimeSessionSnapshot,
	RuntimeSlashCommand,
	RuntimeSubtaskFinishedEvent,
	RuntimeSubtaskStartedEvent,
	RuntimeSubtaskUpdatedEvent,
} from "../protocol/types.js";
import { RUNTIME_PROTOCOL_VERSION } from "../protocol/types.js";
import type { SessionManager } from "../session-manager.js";
import type { DelegatedTaskResult } from "../subagents/types.js";

export interface SessionRuntimeControllerOptions {
	session: AgentSession;
	mode: RuntimeClientCapabilities["clientKind"];
	clientCapabilities: Partial<RuntimeClientCapabilities>;
	initialMetadata?: Partial<RuntimeSessionMetadata>;
	uiContext?: ExtensionUIContext;
	onExtensionError?: ExtensionErrorListener;
	shutdownHandler?: ShutdownHandler;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function toNullableText(value: string | undefined): string | null {
	return value ?? null;
}

function assertNever(value: never): never {
	throw new Error(`Unhandled runtime command: ${JSON.stringify(value)}`);
}

function buildRuntimeSlashCommands(session: AgentSession): RuntimeSlashCommand[] {
	const commands: RuntimeSlashCommand[] = [];

	for (const { command, extensionPath } of session.extensionRunner?.getRegisteredCommandsWithPaths() ?? []) {
		commands.push({
			name: command.name,
			description: command.description,
			source: "extension",
			path: extensionPath,
		});
	}

	for (const template of session.promptTemplates) {
		commands.push({
			name: template.name,
			description: template.description,
			source: "prompt",
			location: template.source as RuntimeSlashCommand["location"],
			path: template.filePath,
		});
	}

	for (const skill of session.resourceLoader.getSkills().skills) {
		commands.push({
			name: `skill:${skill.name}`,
			description: skill.description,
			source: "skill",
			location: skill.source as RuntimeSlashCommand["location"],
			path: skill.filePath,
		});
	}

	return commands;
}

function getSupportedCommands(): RuntimeControlCommand["type"][] {
	return [
		"prompt",
		"steer",
		"follow_up",
		"interrupt",
		"approve",
		"reject",
		"new_session",
		"get_state",
		"switch_model",
		"cycle_model",
		"get_available_models",
		"set_thinking_level",
		"cycle_thinking_level",
		"set_steering_mode",
		"set_follow_up_mode",
		"compact",
		"set_auto_compaction",
		"set_auto_retry",
		"abort_retry",
		"bash",
		"abort_bash",
		"get_session_stats",
		"export_html",
		"switch_session",
		"fork",
		"get_fork_messages",
		"get_last_assistant_text",
		"set_session_name",
		"get_messages",
		"get_commands",
		"reload",
		"set_client_capabilities",
		"update_metadata",
	];
}

function getReservedCommands(): Array<"spawn_task"> {
	return ["spawn_task"];
}

export class SessionRuntimeController {
	private readonly session: AgentSession;
	private metadata: RuntimeSessionMetadata;
	private capabilities: RuntimeClientCapabilities;
	private listeners: RuntimeEventListener[] = [];
	private unsubscribeSession?: () => void;
	private unsubscribeApproval?: () => void;
	private started = false;
	private safetyServices?: SessionSafetyServices;

	private readonly uiContext?: ExtensionUIContext;
	private readonly onExtensionError?: ExtensionErrorListener;
	private readonly shutdownHandler?: ShutdownHandler;

	constructor(options: SessionRuntimeControllerOptions) {
		this.session = options.session;
		this.uiContext = options.uiContext;
		this.onExtensionError = options.onExtensionError;
		this.shutdownHandler = options.shutdownHandler;
		this.capabilities = normalizeRuntimeClientCapabilities({
			clientKind: options.mode,
			...options.clientCapabilities,
		});
		this.metadata = normalizeRuntimeSessionMetadata({
			mode: options.mode,
			...options.initialMetadata,
		});
	}

	get agentSession(): AgentSession {
		return this.session;
	}

	subscribe(listener: RuntimeEventListener): () => void {
		this.listeners.push(listener);
		return () => {
			const index = this.listeners.indexOf(listener);
			if (index !== -1) {
				this.listeners.splice(index, 1);
			}
		};
	}

	async start(): Promise<void> {
		if (this.started) {
			return;
		}

		this.safetyServices = createSessionSafetyServices({
			sessionManager: this.session.sessionManager,
			settingsManager: this.session.settingsManager,
			approvalMode: this.capabilities.approvalUi ? "external" : "disabled",
		});
		registerSessionSafetyServices(this.session.sessionManager, this.safetyServices);
		this.unsubscribeApproval = this.safetyServices.approval.subscribe((event) => {
			if (event.type === "requested") {
				this.emit({
					...this.createEnvelope(),
					type: "approval_requested",
					requestId: event.request.id,
					summary: event.request.subject.summary,
					kind: event.request.subject.permission,
				});
				return;
			}
			this.emit({
				...this.createEnvelope(),
				type: "approval_resolved",
				requestId: event.request.id,
				approved: event.result.allowed,
				reason: event.result.reason,
			});
			this.emitSessionState("command");
		});

		const bindings: ExtensionBindings = {
			uiContext: this.uiContext,
			commandContextActions: this.createCommandContextActions(),
			shutdownHandler: this.shutdownHandler,
			onError: this.onExtensionError,
		};

		await this.session.bindExtensions(bindings);
		this.unsubscribeSession = this.session.subscribe((event) => {
			this.handleSessionEvent(event);
		});
		this.started = true;
		this.persistMetadata();
		this.emit({
			...this.createEnvelope(),
			type: "protocol_ready",
			capabilities: structuredClone(this.capabilities),
			supportedCommands: getSupportedCommands(),
			reservedCommands: getReservedCommands(),
		});
		this.emitSessionState("bootstrap");
	}

	dispose(): void {
		this.unsubscribeApproval?.();
		this.unsubscribeApproval = undefined;
		this.unsubscribeSession?.();
		this.unsubscribeSession = undefined;
		if (this.safetyServices) {
			unregisterSessionSafetyServices(this.session.sessionManager);
			void this.safetyServices.dispose();
			this.safetyServices = undefined;
		}
		this.listeners = [];
	}

	getState(): RuntimeSessionSnapshot {
		return createRuntimeSessionSnapshot(this.session, this.metadata, this.capabilities);
	}

	async execute<T extends RuntimeControlCommand>(command: T): Promise<RuntimeCommandResult<T["type"]>> {
		switch (command.type) {
			case "prompt": {
				const completion = this.session.prompt(command.message, {
					images: command.images,
					streamingBehavior: command.streamingBehavior,
					expandPromptTemplates: command.expandPromptTemplates,
					source: command.source ?? this.defaultInputSource(),
				});
				const tracked = completion.then(() => {
					this.emitSessionState("command");
				});
				if (command.waitForCompletion ?? true) {
					await tracked;
				}
				return { completion: tracked } as RuntimeCommandResult<T["type"]>;
			}

			case "steer": {
				await this.session.steer(command.message, command.images);
				this.emitSessionState("command");
				return undefined as RuntimeCommandResult<T["type"]>;
			}

			case "follow_up": {
				await this.session.followUp(command.message, command.images);
				this.emitSessionState("command");
				return undefined as RuntimeCommandResult<T["type"]>;
			}

			case "interrupt": {
				await this.session.abort();
				this.emitSessionState("command");
				return undefined as RuntimeCommandResult<T["type"]>;
			}

			case "approve":
			case "reject": {
				if (!this.safetyServices) {
					throw new Error("Approval service is not available for this runtime.");
				}
				this.safetyServices.approval.resolve({
					requestId: command.requestId,
					action: command.type === "approve" ? "allow" : "deny",
					scope: "once",
					reason: command.type === "reject" ? command.reason : undefined,
				});
				return undefined as RuntimeCommandResult<T["type"]>;
			}

			case "spawn_task": {
				throw new Error(`Runtime command "${command.type}" is reserved for a future phase.`);
			}

			case "new_session": {
				const previousSessionFile = this.session.sessionFile;
				const previousSessionId = this.session.sessionId;
				const cancelled = !(await this.session.newSession({
					parentSession: command.parentSession,
					setup: command.setup,
				}));
				if (!cancelled) {
					this.persistMetadata();
					this.emitSessionTransition("new_session", previousSessionFile, previousSessionId, false);
					this.emitSessionState("command");
				}
				return { cancelled } as RuntimeCommandResult<T["type"]>;
			}

			case "get_state": {
				return this.getState() as RuntimeCommandResult<T["type"]>;
			}

			case "switch_model": {
				const models = await this.session.modelRegistry.getAvailable();
				const model = models.find((item) => item.provider === command.provider && item.id === command.modelId);
				if (!model) {
					throw new Error(`Model not found: ${command.provider}/${command.modelId}`);
				}
				await this.session.setModel(model);
				this.emitSessionState("command");
				return model as RuntimeCommandResult<T["type"]>;
			}

			case "cycle_model": {
				const result = await this.session.cycleModel(command.direction ?? "forward");
				this.emitSessionState("command");
				return (result ?? null) as RuntimeCommandResult<T["type"]>;
			}

			case "get_available_models": {
				const models = await this.session.modelRegistry.getAvailable();
				return models as RuntimeCommandResult<T["type"]>;
			}

			case "set_thinking_level": {
				this.session.setThinkingLevel(command.level);
				this.emitSessionState("command");
				return undefined as RuntimeCommandResult<T["type"]>;
			}

			case "cycle_thinking_level": {
				const level = this.session.cycleThinkingLevel();
				this.emitSessionState("command");
				return (level ? { level } : null) as RuntimeCommandResult<T["type"]>;
			}

			case "set_steering_mode": {
				this.session.setSteeringMode(command.mode);
				this.emitSessionState("command");
				return undefined as RuntimeCommandResult<T["type"]>;
			}

			case "set_follow_up_mode": {
				this.session.setFollowUpMode(command.mode);
				this.emitSessionState("command");
				return undefined as RuntimeCommandResult<T["type"]>;
			}

			case "compact": {
				const result = await this.session.compact(command.customInstructions);
				this.emitSessionState("command");
				return result as RuntimeCommandResult<T["type"]>;
			}

			case "set_auto_compaction": {
				this.session.setAutoCompactionEnabled(command.enabled);
				this.emitSessionState("command");
				return undefined as RuntimeCommandResult<T["type"]>;
			}

			case "set_auto_retry": {
				this.session.setAutoRetryEnabled(command.enabled);
				this.emitSessionState("command");
				return undefined as RuntimeCommandResult<T["type"]>;
			}

			case "abort_retry": {
				this.session.abortRetry();
				this.emitSessionState("command");
				return undefined as RuntimeCommandResult<T["type"]>;
			}

			case "bash": {
				const result = await this.session.executeBash(command.command);
				this.emitSessionState("command");
				return result as RuntimeCommandResult<T["type"]>;
			}

			case "abort_bash": {
				this.session.abortBash();
				this.emitSessionState("command");
				return undefined as RuntimeCommandResult<T["type"]>;
			}

			case "get_session_stats": {
				return this.session.getSessionStats() as RuntimeCommandResult<T["type"]>;
			}

			case "export_html": {
				const path = await this.session.exportToHtml(command.outputPath);
				return { path } as RuntimeCommandResult<T["type"]>;
			}

			case "switch_session": {
				const previousSessionFile = this.session.sessionFile;
				const previousSessionId = this.session.sessionId;
				const cancelled = !(await this.session.switchSession(command.sessionPath));
				if (!cancelled) {
					this.persistMetadata();
					this.emitSessionTransition("switch_session", previousSessionFile, previousSessionId, false);
					this.emitSessionState("command");
				}
				return { cancelled } as RuntimeCommandResult<T["type"]>;
			}

			case "fork": {
				const previousSessionFile = this.session.sessionFile;
				const previousSessionId = this.session.sessionId;
				const result = await this.session.fork(command.entryId);
				if (!result.cancelled) {
					this.persistMetadata();
					this.emitSessionTransition("fork", previousSessionFile, previousSessionId, false);
					this.emitSessionState("command");
				}
				return { text: result.selectedText, cancelled: result.cancelled } as RuntimeCommandResult<T["type"]>;
			}

			case "get_fork_messages": {
				return this.session.getUserMessagesForForking() as RuntimeCommandResult<T["type"]>;
			}

			case "get_last_assistant_text": {
				return { text: toNullableText(this.session.getLastAssistantText()) } as RuntimeCommandResult<T["type"]>;
			}

			case "set_session_name": {
				const name = command.name.trim();
				if (!name) {
					throw new Error("Session name cannot be empty");
				}
				this.session.setSessionName(name);
				this.emitSessionState("command");
				return undefined as RuntimeCommandResult<T["type"]>;
			}

			case "get_messages": {
				return { messages: this.session.messages as AgentMessage[] } as RuntimeCommandResult<T["type"]>;
			}

			case "get_commands": {
				return { commands: buildRuntimeSlashCommands(this.session) } as RuntimeCommandResult<T["type"]>;
			}

			case "reload": {
				const previousSessionFile = this.session.sessionFile;
				const previousSessionId = this.session.sessionId;
				await this.session.reload();
				this.persistMetadata();
				this.emitSessionTransition("reload", previousSessionFile, previousSessionId, false);
				this.emitSessionState("command");
				return undefined as RuntimeCommandResult<T["type"]>;
			}

			case "set_client_capabilities": {
				this.capabilities = normalizeRuntimeClientCapabilities({
					...this.capabilities,
					...command.capabilities,
					clientKind: command.capabilities.clientKind ?? this.capabilities.clientKind,
				});
				this.safetyServices?.approval.setMode(this.capabilities.approvalUi ? "external" : "disabled");
				this.persistMetadata();
				this.emitSessionState("capabilities");
				return this.getState() as RuntimeCommandResult<T["type"]>;
			}

			case "update_metadata": {
				this.metadata = normalizeRuntimeSessionMetadata({ ...this.metadata, ...command.metadata });
				this.persistMetadata();
				this.emitSessionState("metadata");
				return this.getState() as RuntimeCommandResult<T["type"]>;
			}
		}

		return assertNever(command as never);
	}

	private createCommandContextActions() {
		return {
			waitForIdle: () => this.session.agent.waitForIdle(),
			newSession: async (options?: {
				parentSession?: string;
				setup?: (sessionManager: SessionManager) => Promise<void>;
			}) => {
				const result = await this.execute({
					type: "new_session",
					parentSession: options?.parentSession,
					setup: options?.setup,
				});
				return { cancelled: result.cancelled };
			},
			fork: async (entryId: string) => {
				const result = await this.execute({ type: "fork", entryId });
				return { cancelled: result.cancelled };
			},
			navigateTree: async (
				targetId: string,
				options?: {
					summarize?: boolean;
					customInstructions?: string;
					replaceInstructions?: boolean;
					label?: string;
				},
			) => {
				const result = await this.session.navigateTree(targetId, options);
				if (!result.cancelled) {
					this.emitSessionState("command");
				}
				return { cancelled: result.cancelled };
			},
			switchSession: async (sessionPath: string) => {
				const result = await this.execute({ type: "switch_session", sessionPath });
				return { cancelled: result.cancelled };
			},
			reload: async () => {
				await this.execute({ type: "reload" });
			},
		};
	}

	private defaultInputSource(): InputSource {
		return this.capabilities.clientKind === "rpc" ? "rpc" : "interactive";
	}

	private persistMetadata(): void {
		writeRuntimeSessionMetadata(this.session.sessionManager, this.metadata, this.capabilities);
	}

	private createEnvelope(): RuntimeEventEnvelope {
		return {
			protocolVersion: RUNTIME_PROTOCOL_VERSION,
			emittedAt: new Date().toISOString(),
			runtimeMode: this.metadata.mode,
			sessionId: this.session.sessionId,
			sessionFile: this.session.sessionFile,
			metadata: structuredClone(this.metadata),
		};
	}

	private emit(event: RuntimeProtocolEvent): void {
		for (const listener of this.listeners) {
			listener(event);
		}
	}

	private emitSessionState(reason: "bootstrap" | "command" | "metadata" | "capabilities"): void {
		this.emit({
			...this.createEnvelope(),
			type: "session_state",
			reason,
			state: this.getState(),
		});
	}

	private emitSessionTransition(
		action: "new_session" | "switch_session" | "fork" | "reload",
		previousSessionFile: string | undefined,
		previousSessionId: string | undefined,
		cancelled: boolean,
	): void {
		this.emit({
			...this.createEnvelope(),
			type: "session_transition",
			action,
			cancelled,
			previousSessionFile,
			previousSessionId,
		});
	}

	private handleSessionEvent(event: AgentSessionEvent): void {
		const decoratedEvent: RuntimeDecoratedSessionEvent = {
			...event,
			...this.createEnvelope(),
		};
		this.emit(decoratedEvent);
		const subtaskStarted = this.toSubtaskStartedEvent(event);
		if (subtaskStarted) {
			this.emit(subtaskStarted);
		}
		const subtaskUpdated = this.toSubtaskUpdatedEvent(event);
		if (subtaskUpdated) {
			this.emit(subtaskUpdated);
		}
		const subtaskFinished = this.toSubtaskFinishedEvent(event);
		if (subtaskFinished) {
			this.emit(subtaskFinished);
		}
	}

	private toSubtaskStartedEvent(event: AgentSessionEvent): RuntimeSubtaskStartedEvent | undefined {
		if (event.type !== "tool_execution_start" || event.toolName !== "task") {
			return undefined;
		}
		const args = isRecord(event.args) ? event.args : {};
		return {
			...this.createEnvelope(),
			type: "subtask_started",
			toolCallId: event.toolCallId,
			agent: readString(args.subagent_type),
			description: readString(args.description),
			prompt: readString(args.prompt),
			taskId: readString(args.task_id),
			resumed: typeof args.task_id === "string" && args.task_id.length > 0,
		};
	}

	private toSubtaskUpdatedEvent(event: AgentSessionEvent): RuntimeSubtaskUpdatedEvent | undefined {
		if (event.type !== "tool_execution_update" || event.toolName !== "task") {
			return undefined;
		}
		const partialResult = isRecord(event.partialResult) ? event.partialResult : undefined;
		const details = partialResult && isRecord(partialResult.details) ? partialResult.details : undefined;
		const delegated = this.toDelegatedTaskResult(details?.result);
		const content = Array.isArray(partialResult?.content) ? partialResult.content : undefined;
		const summary = content
			?.filter((item): item is { type: string; text?: string } => isRecord(item) && typeof item.type === "string")
			.map((item) => (item.type === "text" ? item.text : undefined))
			.find((item) => typeof item === "string" && item.trim().length > 0);
		return {
			...this.createEnvelope(),
			type: "subtask_updated",
			toolCallId: event.toolCallId,
			taskId: delegated?.taskId,
			subtaskSessionId: delegated?.sessionId,
			messageCount: delegated?.messages.length,
			summary,
		};
	}

	private toSubtaskFinishedEvent(event: AgentSessionEvent): RuntimeSubtaskFinishedEvent | undefined {
		if (event.type !== "tool_execution_end" || event.toolName !== "task") {
			return undefined;
		}
		const result = isRecord(event.result) ? event.result : undefined;
		const details = result && isRecord(result.details) ? result.details : undefined;
		const delegated = this.toDelegatedTaskResult(details?.result);
		const status = this.getSubtaskStatus(delegated, event.isError);
		return {
			...this.createEnvelope(),
			type: "subtask_finished",
			toolCallId: event.toolCallId,
			taskId: delegated?.taskId,
			subtaskSessionId: delegated?.sessionId,
			agent: delegated?.agent,
			status,
			errorMessage: delegated?.errorMessage,
			stopReason: delegated?.stopReason,
		};
	}

	private toDelegatedTaskResult(value: unknown): DelegatedTaskResult | undefined {
		if (!isRecord(value)) {
			return undefined;
		}
		if (typeof value.taskId !== "string" || typeof value.sessionId !== "string" || typeof value.agent !== "string") {
			return undefined;
		}
		return value as unknown as DelegatedTaskResult;
	}

	private getSubtaskStatus(
		delegated: DelegatedTaskResult | undefined,
		isError: boolean,
	): RuntimeSubtaskFinishedEvent["status"] {
		if (isError) {
			return "failed";
		}
		if (delegated?.stopReason === "aborted") {
			return "aborted";
		}
		if (delegated?.exitCode !== undefined && delegated.exitCode !== 0) {
			return "failed";
		}
		return "completed";
	}
}
