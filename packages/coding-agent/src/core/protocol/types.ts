import type { AgentMessage, ThinkingLevel } from "@hirocode/agent-core";
import type { ImageContent, Model } from "@hirocode/ai";
import type { AgentSessionEvent, ModelCycleResult, SessionStats } from "../agent-session.js";
import type { BashResult } from "../bash-executor.js";
import type { CompactionResult } from "../compaction/index.js";
import type { InputSource } from "../extensions/index.js";
import type { SessionManager } from "../session-manager.js";
import type { DelegatedTaskResult } from "../subagents/types.js";

export const RUNTIME_PROTOCOL_VERSION = 1 as const;

export type RuntimeMode = "interactive" | "text" | "json" | "rpc" | "exec" | "sdk";
export type RuntimeAutonomyState = "manual" | "auto-low" | "auto-medium" | "auto-high";
export type RuntimeSpecState = "inactive" | "planning" | "approved" | "executing";
export type RuntimeMissionState = "inactive" | "planning" | "running" | "paused" | "completed" | "failed";

export interface RuntimeClientCapabilities {
	clientKind: RuntimeMode;
	approvalUi: boolean;
	missionControl: boolean;
	mcpManager: boolean;
	specReview: boolean;
	widgets: boolean;
	customUi: boolean;
	themeControl: boolean;
}

export interface RuntimeSessionMetadata {
	mode: RuntimeMode;
	autonomy: RuntimeAutonomyState;
	specState: RuntimeSpecState;
	missionState: RuntimeMissionState;
	tags: string[];
	activeAgents: string[];
}

export interface RuntimeSessionSnapshot {
	protocolVersion: typeof RUNTIME_PROTOCOL_VERSION;
	model?: Model<any>;
	thinkingLevel: ThinkingLevel;
	isStreaming: boolean;
	isCompacting: boolean;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	sessionFile?: string;
	sessionId: string;
	sessionName?: string;
	autoCompactionEnabled: boolean;
	messageCount: number;
	pendingMessageCount: number;
	activeToolNames: string[];
	metadata: RuntimeSessionMetadata;
	capabilities: RuntimeClientCapabilities;
}

export interface RuntimeSlashCommand {
	name: string;
	description?: string;
	source: "extension" | "prompt" | "skill";
	location?: "user" | "project" | "path";
	path?: string;
}

export interface RuntimePromptHandle {
	completion: Promise<void>;
}

export interface RuntimeCommandPrompt {
	type: "prompt";
	message: string;
	images?: ImageContent[];
	streamingBehavior?: "steer" | "followUp";
	expandPromptTemplates?: boolean;
	source?: InputSource;
	waitForCompletion?: boolean;
}

export interface RuntimeCommandSteer {
	type: "steer";
	message: string;
	images?: ImageContent[];
}

export interface RuntimeCommandFollowUp {
	type: "follow_up";
	message: string;
	images?: ImageContent[];
}

export interface RuntimeCommandInterrupt {
	type: "interrupt";
}

export interface RuntimeCommandApprove {
	type: "approve";
	requestId: string;
}

export interface RuntimeCommandReject {
	type: "reject";
	requestId: string;
	reason?: string;
}

export interface RuntimeCommandNewSession {
	type: "new_session";
	parentSession?: string;
	setup?: (sessionManager: SessionManager) => Promise<void>;
}

export interface RuntimeCommandGetState {
	type: "get_state";
}

export interface RuntimeCommandSwitchModel {
	type: "switch_model";
	provider: string;
	modelId: string;
}

export interface RuntimeCommandCycleModel {
	type: "cycle_model";
	direction?: "forward" | "backward";
}

export interface RuntimeCommandGetAvailableModels {
	type: "get_available_models";
}

export interface RuntimeCommandSetThinkingLevel {
	type: "set_thinking_level";
	level: ThinkingLevel;
}

export interface RuntimeCommandCycleThinkingLevel {
	type: "cycle_thinking_level";
}

export interface RuntimeCommandSetSteeringMode {
	type: "set_steering_mode";
	mode: "all" | "one-at-a-time";
}

export interface RuntimeCommandSetFollowUpMode {
	type: "set_follow_up_mode";
	mode: "all" | "one-at-a-time";
}

export interface RuntimeCommandCompact {
	type: "compact";
	customInstructions?: string;
}

export interface RuntimeCommandSetAutoCompaction {
	type: "set_auto_compaction";
	enabled: boolean;
}

export interface RuntimeCommandSetAutoRetry {
	type: "set_auto_retry";
	enabled: boolean;
}

export interface RuntimeCommandAbortRetry {
	type: "abort_retry";
}

export interface RuntimeCommandBash {
	type: "bash";
	command: string;
}

export interface RuntimeCommandAbortBash {
	type: "abort_bash";
}

export interface RuntimeCommandGetSessionStats {
	type: "get_session_stats";
}

export interface RuntimeCommandExportHtml {
	type: "export_html";
	outputPath?: string;
}

export interface RuntimeCommandSwitchSession {
	type: "switch_session";
	sessionPath: string;
}

export interface RuntimeCommandFork {
	type: "fork";
	entryId: string;
}

export interface RuntimeCommandGetForkMessages {
	type: "get_fork_messages";
}

export interface RuntimeCommandGetLastAssistantText {
	type: "get_last_assistant_text";
}

export interface RuntimeCommandSetSessionName {
	type: "set_session_name";
	name: string;
}

export interface RuntimeCommandGetMessages {
	type: "get_messages";
}

export interface RuntimeCommandGetCommands {
	type: "get_commands";
}

export interface RuntimeCommandReload {
	type: "reload";
}

export interface RuntimeCommandSetClientCapabilities {
	type: "set_client_capabilities";
	capabilities: Partial<RuntimeClientCapabilities>;
}

export interface RuntimeCommandUpdateMetadata {
	type: "update_metadata";
	metadata: Partial<RuntimeSessionMetadata>;
}

export interface RuntimeCommandSpawnTask {
	type: "spawn_task";
	prompt: string;
	description: string;
	subagentType: string;
	taskId?: string;
}

export type RuntimeControlCommand =
	| RuntimeCommandPrompt
	| RuntimeCommandSteer
	| RuntimeCommandFollowUp
	| RuntimeCommandInterrupt
	| RuntimeCommandApprove
	| RuntimeCommandReject
	| RuntimeCommandNewSession
	| RuntimeCommandGetState
	| RuntimeCommandSwitchModel
	| RuntimeCommandCycleModel
	| RuntimeCommandGetAvailableModels
	| RuntimeCommandSetThinkingLevel
	| RuntimeCommandCycleThinkingLevel
	| RuntimeCommandSetSteeringMode
	| RuntimeCommandSetFollowUpMode
	| RuntimeCommandCompact
	| RuntimeCommandSetAutoCompaction
	| RuntimeCommandSetAutoRetry
	| RuntimeCommandAbortRetry
	| RuntimeCommandBash
	| RuntimeCommandAbortBash
	| RuntimeCommandGetSessionStats
	| RuntimeCommandExportHtml
	| RuntimeCommandSwitchSession
	| RuntimeCommandFork
	| RuntimeCommandGetForkMessages
	| RuntimeCommandGetLastAssistantText
	| RuntimeCommandSetSessionName
	| RuntimeCommandGetMessages
	| RuntimeCommandGetCommands
	| RuntimeCommandReload
	| RuntimeCommandSetClientCapabilities
	| RuntimeCommandUpdateMetadata
	| RuntimeCommandSpawnTask;

export interface RuntimeCommandResultMap {
	prompt: RuntimePromptHandle;
	steer: undefined;
	follow_up: undefined;
	interrupt: undefined;
	approve: undefined;
	reject: undefined;
	new_session: { cancelled: boolean };
	get_state: RuntimeSessionSnapshot;
	switch_model: Model<any>;
	cycle_model: ModelCycleResult | null;
	get_available_models: Model<any>[];
	set_thinking_level: undefined;
	cycle_thinking_level: { level: ThinkingLevel } | null;
	set_steering_mode: undefined;
	set_follow_up_mode: undefined;
	compact: CompactionResult;
	set_auto_compaction: undefined;
	set_auto_retry: undefined;
	abort_retry: undefined;
	bash: BashResult;
	abort_bash: undefined;
	get_session_stats: SessionStats;
	export_html: { path: string };
	switch_session: { cancelled: boolean };
	fork: { text: string; cancelled: boolean };
	get_fork_messages: Array<{ entryId: string; text: string }>;
	get_last_assistant_text: { text: string | null };
	set_session_name: undefined;
	get_messages: { messages: AgentMessage[] };
	get_commands: { commands: RuntimeSlashCommand[] };
	reload: undefined;
	set_client_capabilities: RuntimeSessionSnapshot;
	update_metadata: RuntimeSessionSnapshot;
	spawn_task: DelegatedTaskResult;
}

export type RuntimeCommandResult<T extends RuntimeControlCommand["type"]> = RuntimeCommandResultMap[T];

export interface RuntimeEventEnvelope {
	protocolVersion: typeof RUNTIME_PROTOCOL_VERSION;
	emittedAt: string;
	runtimeMode: RuntimeMode;
	sessionId: string;
	sessionFile?: string;
	metadata: RuntimeSessionMetadata;
}

export type RuntimeDecoratedSessionEvent = AgentSessionEvent & RuntimeEventEnvelope;

export interface RuntimeProtocolReadyEvent extends RuntimeEventEnvelope {
	type: "protocol_ready";
	capabilities: RuntimeClientCapabilities;
	supportedCommands: RuntimeControlCommand["type"][];
	reservedCommands: Array<"spawn_task">;
}

export interface RuntimeSessionStateEvent extends RuntimeEventEnvelope {
	type: "session_state";
	reason: "bootstrap" | "command" | "metadata" | "capabilities";
	state: RuntimeSessionSnapshot;
}

export interface RuntimeSessionTransitionEvent extends RuntimeEventEnvelope {
	type: "session_transition";
	action: "new_session" | "switch_session" | "fork" | "reload";
	cancelled: boolean;
	previousSessionFile?: string;
	previousSessionId?: string;
}

export interface RuntimeApprovalRequestedEvent extends RuntimeEventEnvelope {
	type: "approval_requested";
	requestId: string;
	summary: string;
	kind: string;
}

export interface RuntimeApprovalResolvedEvent extends RuntimeEventEnvelope {
	type: "approval_resolved";
	requestId: string;
	approved: boolean;
	reason?: string;
}

export interface RuntimeSubtaskStartedEvent extends RuntimeEventEnvelope {
	type: "subtask_started";
	toolCallId: string;
	agent?: string;
	description?: string;
	prompt?: string;
	taskId?: string;
	resumed: boolean;
}

export interface RuntimeSubtaskUpdatedEvent extends RuntimeEventEnvelope {
	type: "subtask_updated";
	toolCallId: string;
	taskId?: string;
	subtaskSessionId?: string;
	messageCount?: number;
	summary?: string;
}

export interface RuntimeSubtaskFinishedEvent extends RuntimeEventEnvelope {
	type: "subtask_finished";
	toolCallId: string;
	taskId?: string;
	subtaskSessionId?: string;
	agent?: string;
	status: "completed" | "failed" | "aborted";
	errorMessage?: string;
	stopReason?: string;
}

export type RuntimeProtocolEvent =
	| RuntimeDecoratedSessionEvent
	| RuntimeProtocolReadyEvent
	| RuntimeSessionStateEvent
	| RuntimeSessionTransitionEvent
	| RuntimeApprovalRequestedEvent
	| RuntimeApprovalResolvedEvent
	| RuntimeSubtaskStartedEvent
	| RuntimeSubtaskUpdatedEvent
	| RuntimeSubtaskFinishedEvent;

export type RuntimeEventListener = (event: RuntimeProtocolEvent) => void;
