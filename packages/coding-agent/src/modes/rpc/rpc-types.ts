/**
 * RPC protocol types for headless operation.
 *
 * Commands are sent as JSON lines on stdin.
 * Responses and events are emitted as JSON lines on stdout.
 */

import type { AgentMessage, ThinkingLevel } from "@hirocode/agent-core";
import type { ImageContent, Model } from "@hirocode/ai";
import type { SessionStats } from "../../core/agent-session.js";
import type { BashResult } from "../../core/bash-executor.js";
import type { CompactionResult } from "../../core/compaction/index.js";
import type {
	RUNTIME_PROTOCOL_VERSION,
	RuntimeClientCapabilities,
	RuntimeProtocolEvent,
	RuntimeSessionSnapshot,
	RuntimeSlashCommand,
} from "../../core/protocol/types.js";

// ============================================================================
// RPC Commands (stdin)
// ============================================================================

export type RpcCommand =
	// Prompting
	| { id?: string; type: "prompt"; message: string; images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" }
	| { id?: string; type: "steer"; message: string; images?: ImageContent[] }
	| { id?: string; type: "follow_up"; message: string; images?: ImageContent[] }
	| { id?: string; type: "abort" }
	| { id?: string; type: "approve"; requestId: string }
	| { id?: string; type: "reject"; requestId: string; reason?: string }
	| { id?: string; type: "new_session"; parentSession?: string }

	// State
	| { id?: string; type: "get_state" }
	| { id?: string; type: "set_client_capabilities"; capabilities: Partial<RuntimeClientCapabilities> }

	// Model
	| { id?: string; type: "set_model"; provider: string; modelId: string }
	| { id?: string; type: "cycle_model" }
	| { id?: string; type: "get_available_models" }

	// Thinking
	| { id?: string; type: "set_thinking_level"; level: ThinkingLevel }
	| { id?: string; type: "cycle_thinking_level" }

	// Queue modes
	| { id?: string; type: "set_steering_mode"; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "set_follow_up_mode"; mode: "all" | "one-at-a-time" }

	// Compaction
	| { id?: string; type: "compact"; customInstructions?: string }
	| { id?: string; type: "set_auto_compaction"; enabled: boolean }

	// Retry
	| { id?: string; type: "set_auto_retry"; enabled: boolean }
	| { id?: string; type: "abort_retry" }

	// Bash
	| { id?: string; type: "bash"; command: string }
	| { id?: string; type: "abort_bash" }

	// Session
	| { id?: string; type: "get_session_stats" }
	| { id?: string; type: "export_html"; outputPath?: string }
	| { id?: string; type: "switch_session"; sessionPath: string }
	| { id?: string; type: "fork"; entryId: string }
	| { id?: string; type: "get_fork_messages" }
	| { id?: string; type: "get_last_assistant_text" }
	| { id?: string; type: "set_session_name"; name: string }

	// Messages
	| { id?: string; type: "get_messages" }

	// Commands (available for invocation via prompt)
	| { id?: string; type: "get_commands" };

// ============================================================================
// RPC Slash Command (for get_commands response)
// ============================================================================

export type RpcSlashCommand = RuntimeSlashCommand;

// ============================================================================
// RPC State
// ============================================================================

export type RpcSessionState = RuntimeSessionSnapshot;

// ============================================================================
// RPC Responses (stdout)
// ============================================================================

type RpcResponseBase = {
	id?: string;
	protocolVersion: typeof RUNTIME_PROTOCOL_VERSION;
	type: "response";
};

// Success responses with data
export type RpcResponse =
	// Prompting (async - events follow)
	| (RpcResponseBase & { command: "prompt"; success: true })
	| (RpcResponseBase & { command: "steer"; success: true })
	| (RpcResponseBase & { command: "follow_up"; success: true })
	| (RpcResponseBase & { command: "abort"; success: true })
	| (RpcResponseBase & { command: "approve"; success: true })
	| (RpcResponseBase & { command: "reject"; success: true })
	| (RpcResponseBase & { command: "new_session"; success: true; data: { cancelled: boolean } })

	// State
	| (RpcResponseBase & { command: "get_state"; success: true; data: RpcSessionState })
	| (RpcResponseBase & { command: "set_client_capabilities"; success: true; data: RpcSessionState })

	// Model
	| (RpcResponseBase & { command: "set_model"; success: true; data: Model<any> })
	| (RpcResponseBase & {
			command: "cycle_model";
			success: true;
			data: { model: Model<any>; thinkingLevel: ThinkingLevel; isScoped: boolean } | null;
	  })
	| (RpcResponseBase & { command: "get_available_models"; success: true; data: { models: Model<any>[] } })

	// Thinking
	| (RpcResponseBase & { command: "set_thinking_level"; success: true })
	| (RpcResponseBase & { command: "cycle_thinking_level"; success: true; data: { level: ThinkingLevel } | null })

	// Queue modes
	| (RpcResponseBase & { command: "set_steering_mode"; success: true })
	| (RpcResponseBase & { command: "set_follow_up_mode"; success: true })

	// Compaction
	| (RpcResponseBase & { command: "compact"; success: true; data: CompactionResult })
	| (RpcResponseBase & { command: "set_auto_compaction"; success: true })

	// Retry
	| (RpcResponseBase & { command: "set_auto_retry"; success: true })
	| (RpcResponseBase & { command: "abort_retry"; success: true })

	// Bash
	| (RpcResponseBase & { command: "bash"; success: true; data: BashResult })
	| (RpcResponseBase & { command: "abort_bash"; success: true })

	// Session
	| (RpcResponseBase & { command: "get_session_stats"; success: true; data: SessionStats })
	| (RpcResponseBase & { command: "export_html"; success: true; data: { path: string } })
	| (RpcResponseBase & { command: "switch_session"; success: true; data: { cancelled: boolean } })
	| (RpcResponseBase & { command: "fork"; success: true; data: { text: string; cancelled: boolean } })
	| (RpcResponseBase & {
			command: "get_fork_messages";
			success: true;
			data: { messages: Array<{ entryId: string; text: string }> };
	  })
	| (RpcResponseBase & { command: "get_last_assistant_text"; success: true; data: { text: string | null } })
	| (RpcResponseBase & { command: "set_session_name"; success: true })

	// Messages
	| (RpcResponseBase & { command: "get_messages"; success: true; data: { messages: AgentMessage[] } })

	// Commands
	| (RpcResponseBase & { command: "get_commands"; success: true; data: { commands: RpcSlashCommand[] } })

	// Error response (any command can fail)
	| (RpcResponseBase & { command: string; success: false; error: string });

// ============================================================================
// Extension UI Events (stdout)
// ============================================================================

/** Emitted when an extension needs user input */
export type RpcExtensionUIRequest =
	| {
			type: "extension_ui_request";
			protocolVersion: typeof RUNTIME_PROTOCOL_VERSION;
			id: string;
			method: "select";
			title: string;
			options: string[];
			timeout?: number;
	  }
	| {
			type: "extension_ui_request";
			protocolVersion: typeof RUNTIME_PROTOCOL_VERSION;
			id: string;
			method: "confirm";
			title: string;
			message: string;
			timeout?: number;
	  }
	| {
			type: "extension_ui_request";
			protocolVersion: typeof RUNTIME_PROTOCOL_VERSION;
			id: string;
			method: "input";
			title: string;
			placeholder?: string;
			timeout?: number;
	  }
	| {
			type: "extension_ui_request";
			protocolVersion: typeof RUNTIME_PROTOCOL_VERSION;
			id: string;
			method: "editor";
			title: string;
			prefill?: string;
	  }
	| {
			type: "extension_ui_request";
			protocolVersion: typeof RUNTIME_PROTOCOL_VERSION;
			id: string;
			method: "notify";
			message: string;
			notifyType?: "info" | "warning" | "error";
	  }
	| {
			type: "extension_ui_request";
			protocolVersion: typeof RUNTIME_PROTOCOL_VERSION;
			id: string;
			method: "setStatus";
			statusKey: string;
			statusText: string | undefined;
	  }
	| {
			type: "extension_ui_request";
			protocolVersion: typeof RUNTIME_PROTOCOL_VERSION;
			id: string;
			method: "setWidget";
			widgetKey: string;
			widgetLines: string[] | undefined;
			widgetPlacement?: "aboveEditor" | "belowEditor";
	  }
	| {
			type: "extension_ui_request";
			protocolVersion: typeof RUNTIME_PROTOCOL_VERSION;
			id: string;
			method: "setTitle";
			title: string;
	  }
	| {
			type: "extension_ui_request";
			protocolVersion: typeof RUNTIME_PROTOCOL_VERSION;
			id: string;
			method: "set_editor_text";
			text: string;
	  };

// ============================================================================
// Extension UI Commands (stdin)
// ============================================================================

/** Response to an extension UI request */
export type RpcExtensionUIResponse =
	| { type: "extension_ui_response"; id: string; value: string }
	| { type: "extension_ui_response"; id: string; confirmed: boolean }
	| { type: "extension_ui_response"; id: string; cancelled: true };

// ============================================================================
// Helper type for extracting command types
// ============================================================================

export type RpcEvent = RuntimeProtocolEvent;
export type RpcCommandType = RpcCommand["type"];
