/**
 * RPC mode: Headless operation with JSON stdin/stdout protocol.
 *
 * Used for embedding the agent in other applications.
 * Receives commands as JSON on stdin, outputs events and responses as JSON on stdout.
 *
 * Protocol:
 * - Commands: JSON objects with `type` field, optional `id` for correlation
 * - Responses: JSON objects with `type: "response"`, `command`, `success`, and optional `data`/`error`
 * - Events: AgentSessionEvent objects streamed as they occur
 * - Extension UI: Extension UI requests are emitted, client responds with extension_ui_response
 */

import * as crypto from "node:crypto";
import type { AgentSession } from "../../core/agent-session.js";
import type {
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
} from "../../core/extensions/index.js";
import { RUNTIME_PROTOCOL_VERSION } from "../../core/protocol/types.js";
import { SessionRuntimeController } from "../../core/runtime/session-runtime-controller.js";
import { type Theme, theme } from "../interactive/theme/theme.js";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.js";
import type { RpcCommand, RpcExtensionUIRequest, RpcExtensionUIResponse, RpcResponse } from "./rpc-types.js";

// Re-export types for consumers
export type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
} from "./rpc-types.js";

/**
 * Run in RPC mode.
 * Listens for JSON commands on stdin, outputs events and responses on stdout.
 */
export async function runRpcMode(session: AgentSession): Promise<never> {
	const rawStdoutWrite = process.stdout.write.bind(process.stdout);
	const rawStderrWrite = process.stderr.write.bind(process.stderr);

	process.stdout.write = ((
		...args: Parameters<typeof process.stdout.write>
	): ReturnType<typeof process.stdout.write> => rawStderrWrite(...args)) as typeof process.stdout.write;

	const output = (obj: RpcResponse | RpcExtensionUIRequest | object) => {
		rawStdoutWrite(serializeJsonLine(obj));
	};

	const success = <T extends RpcCommand["type"]>(
		id: string | undefined,
		command: T,
		data?: object | null,
	): RpcResponse => {
		if (data === undefined) {
			return {
				id,
				protocolVersion: RUNTIME_PROTOCOL_VERSION,
				type: "response",
				command,
				success: true,
			} as RpcResponse;
		}
		return {
			id,
			protocolVersion: RUNTIME_PROTOCOL_VERSION,
			type: "response",
			command,
			success: true,
			data,
		} as RpcResponse;
	};

	const error = (id: string | undefined, command: string, message: string): RpcResponse => {
		return {
			id,
			protocolVersion: RUNTIME_PROTOCOL_VERSION,
			type: "response",
			command,
			success: false,
			error: message,
		};
	};

	// Pending extension UI requests waiting for response
	const pendingExtensionRequests = new Map<
		string,
		{ resolve: (value: RpcExtensionUIResponse) => void; reject: (error: Error) => void }
	>();

	// Shutdown request flag
	let shutdownRequested = false;

	/** Helper for dialog methods with signal/timeout support */
	function createDialogPromise<T>(
		opts: ExtensionUIDialogOptions | undefined,
		defaultValue: T,
		request: Record<string, unknown>,
		parseResponse: (response: RpcExtensionUIResponse) => T,
	): Promise<T> {
		if (opts?.signal?.aborted) return Promise.resolve(defaultValue);

		const id = crypto.randomUUID();
		return new Promise((resolve, reject) => {
			let timeoutId: ReturnType<typeof setTimeout> | undefined;

			const cleanup = () => {
				if (timeoutId) clearTimeout(timeoutId);
				opts?.signal?.removeEventListener("abort", onAbort);
				pendingExtensionRequests.delete(id);
			};

			const onAbort = () => {
				cleanup();
				resolve(defaultValue);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			if (opts?.timeout) {
				timeoutId = setTimeout(() => {
					cleanup();
					resolve(defaultValue);
				}, opts.timeout);
			}

			pendingExtensionRequests.set(id, {
				resolve: (response: RpcExtensionUIResponse) => {
					cleanup();
					resolve(parseResponse(response));
				},
				reject,
			});
			output({
				type: "extension_ui_request",
				protocolVersion: RUNTIME_PROTOCOL_VERSION,
				id,
				...request,
			} as RpcExtensionUIRequest);
		});
	}

	/**
	 * Create an extension UI context that uses the RPC protocol.
	 */
	const createExtensionUIContext = (): ExtensionUIContext => ({
		select: (title, options, opts) =>
			createDialogPromise(opts, undefined, { method: "select", title, options, timeout: opts?.timeout }, (r) =>
				"cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined,
			),

		confirm: (title, message, opts) =>
			createDialogPromise(opts, false, { method: "confirm", title, message, timeout: opts?.timeout }, (r) =>
				"cancelled" in r && r.cancelled ? false : "confirmed" in r ? r.confirmed : false,
			),

		input: (title, placeholder, opts) =>
			createDialogPromise(opts, undefined, { method: "input", title, placeholder, timeout: opts?.timeout }, (r) =>
				"cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined,
			),

		notify(message: string, type?: "info" | "warning" | "error"): void {
			// Fire and forget - no response needed
			output({
				type: "extension_ui_request",
				protocolVersion: RUNTIME_PROTOCOL_VERSION,
				id: crypto.randomUUID(),
				method: "notify",
				message,
				notifyType: type,
			} as RpcExtensionUIRequest);
		},

		onTerminalInput(): () => void {
			// Raw terminal input not supported in RPC mode
			return () => {};
		},

		setStatus(key: string, text: string | undefined): void {
			// Fire and forget - no response needed
			output({
				type: "extension_ui_request",
				protocolVersion: RUNTIME_PROTOCOL_VERSION,
				id: crypto.randomUUID(),
				method: "setStatus",
				statusKey: key,
				statusText: text,
			} as RpcExtensionUIRequest);
		},

		setWorkingMessage(_message?: string): void {
			// Working message not supported in RPC mode - requires TUI loader access
		},

		setWidget(key: string, content: unknown, options?: ExtensionWidgetOptions): void {
			// Only support string arrays in RPC mode - factory functions are ignored
			if (content === undefined || Array.isArray(content)) {
				output({
					type: "extension_ui_request",
					protocolVersion: RUNTIME_PROTOCOL_VERSION,
					id: crypto.randomUUID(),
					method: "setWidget",
					widgetKey: key,
					widgetLines: content as string[] | undefined,
					widgetPlacement: options?.placement,
				} as RpcExtensionUIRequest);
			}
			// Component factories are not supported in RPC mode - would need TUI access
		},

		setFooter(_factory: unknown): void {
			// Custom footer not supported in RPC mode - requires TUI access
		},

		setHeader(_factory: unknown): void {
			// Custom header not supported in RPC mode - requires TUI access
		},

		setTitle(title: string): void {
			// Fire and forget - host can implement terminal title control
			output({
				type: "extension_ui_request",
				protocolVersion: RUNTIME_PROTOCOL_VERSION,
				id: crypto.randomUUID(),
				method: "setTitle",
				title,
			} as RpcExtensionUIRequest);
		},

		async custom() {
			// Custom UI not supported in RPC mode
			return undefined as never;
		},

		pasteToEditor(text: string): void {
			// Paste handling not supported in RPC mode - falls back to setEditorText
			this.setEditorText(text);
		},

		setEditorText(text: string): void {
			// Fire and forget - host can implement editor control
			output({
				type: "extension_ui_request",
				protocolVersion: RUNTIME_PROTOCOL_VERSION,
				id: crypto.randomUUID(),
				method: "set_editor_text",
				text,
			} as RpcExtensionUIRequest);
		},

		getEditorText(): string {
			// Synchronous method can't wait for RPC response
			// Host should track editor state locally if needed
			return "";
		},

		async editor(title: string, prefill?: string): Promise<string | undefined> {
			const id = crypto.randomUUID();
			return new Promise((resolve, reject) => {
				pendingExtensionRequests.set(id, {
					resolve: (response: RpcExtensionUIResponse) => {
						if ("cancelled" in response && response.cancelled) {
							resolve(undefined);
						} else if ("value" in response) {
							resolve(response.value);
						} else {
							resolve(undefined);
						}
					},
					reject,
				});
				output({
					type: "extension_ui_request",
					protocolVersion: RUNTIME_PROTOCOL_VERSION,
					id,
					method: "editor",
					title,
					prefill,
				} as RpcExtensionUIRequest);
			});
		},

		setEditorComponent(): void {
			// Custom editor components not supported in RPC mode
		},

		get theme() {
			return theme;
		},

		getAllThemes() {
			return [];
		},

		getTheme(_name: string) {
			return undefined;
		},

		setTheme(_theme: string | Theme) {
			// Theme switching not supported in RPC mode
			return { success: false, error: "Theme switching not supported in RPC mode" };
		},

		getToolsExpanded() {
			// Tool expansion not supported in RPC mode - no TUI
			return false;
		},

		setToolsExpanded(_expanded: boolean) {
			// Tool expansion not supported in RPC mode - no TUI
		},
	});

	const controller = new SessionRuntimeController({
		session,
		mode: "rpc",
		clientCapabilities: {
			approvalUi: true,
			missionControl: false,
			mcpManager: false,
			specReview: false,
			widgets: true,
			customUi: false,
			themeControl: false,
		},
		uiContext: createExtensionUIContext(),
		shutdownHandler: () => {
			shutdownRequested = true;
		},
		onExtensionError: (err) => {
			output({
				type: "extension_error",
				protocolVersion: RUNTIME_PROTOCOL_VERSION,
				extensionPath: err.extensionPath,
				event: err.event,
				error: err.error,
			});
		},
	});

	controller.subscribe((event) => {
		output(event);
	});
	await controller.start();

	// Handle a single command
	const handleCommand = async (command: RpcCommand): Promise<RpcResponse> => {
		const id = command.id;

		switch (command.type) {
			// =================================================================
			// Prompting
			// =================================================================

			case "prompt": {
				const handle = await controller.execute({
					type: "prompt",
					message: command.message,
					images: command.images,
					streamingBehavior: command.streamingBehavior,
					source: "rpc",
					waitForCompletion: false,
				});
				void handle.completion.catch((e: Error) => output(error(id, "prompt", e.message)));
				return success(id, "prompt");
			}

			case "steer": {
				await controller.execute({ type: "steer", message: command.message, images: command.images });
				return success(id, "steer");
			}

			case "follow_up": {
				await controller.execute({ type: "follow_up", message: command.message, images: command.images });
				return success(id, "follow_up");
			}

			case "abort": {
				await controller.execute({ type: "interrupt" });
				return success(id, "abort");
			}

			case "approve": {
				await controller.execute({ type: "approve", requestId: command.requestId });
				return success(id, "approve");
			}

			case "reject": {
				await controller.execute({ type: "reject", requestId: command.requestId, reason: command.reason });
				return success(id, "reject");
			}

			case "new_session": {
				const { cancelled } = await controller.execute({
					type: "new_session",
					parentSession: command.parentSession,
				});
				return success(id, "new_session", { cancelled });
			}

			// =================================================================
			// State
			// =================================================================

			case "get_state": {
				const state = await controller.execute({ type: "get_state" });
				return success(id, "get_state", state);
			}

			case "set_client_capabilities": {
				const state = await controller.execute({
					type: "set_client_capabilities",
					capabilities: command.capabilities,
				});
				return success(id, "set_client_capabilities", state);
			}

			// =================================================================
			// Model
			// =================================================================

			case "set_model": {
				const model = await controller.execute({
					type: "switch_model",
					provider: command.provider,
					modelId: command.modelId,
				});
				return success(id, "set_model", model);
			}

			case "cycle_model": {
				const result = await controller.execute({ type: "cycle_model" });
				if (result === null) {
					return success(id, "cycle_model", null);
				}
				return success(id, "cycle_model", result);
			}

			case "get_available_models": {
				const models = await controller.execute({ type: "get_available_models" });
				return success(id, "get_available_models", { models });
			}

			// =================================================================
			// Thinking
			// =================================================================

			case "set_thinking_level": {
				await controller.execute({ type: "set_thinking_level", level: command.level });
				return success(id, "set_thinking_level");
			}

			case "cycle_thinking_level": {
				const result = await controller.execute({ type: "cycle_thinking_level" });
				if (result === null) {
					return success(id, "cycle_thinking_level", null);
				}
				return success(id, "cycle_thinking_level", result);
			}

			// =================================================================
			// Queue Modes
			// =================================================================

			case "set_steering_mode": {
				await controller.execute({ type: "set_steering_mode", mode: command.mode });
				return success(id, "set_steering_mode");
			}

			case "set_follow_up_mode": {
				await controller.execute({ type: "set_follow_up_mode", mode: command.mode });
				return success(id, "set_follow_up_mode");
			}

			// =================================================================
			// Compaction
			// =================================================================

			case "compact": {
				const result = await controller.execute({
					type: "compact",
					customInstructions: command.customInstructions,
				});
				return success(id, "compact", result);
			}

			case "set_auto_compaction": {
				await controller.execute({ type: "set_auto_compaction", enabled: command.enabled });
				return success(id, "set_auto_compaction");
			}

			// =================================================================
			// Retry
			// =================================================================

			case "set_auto_retry": {
				await controller.execute({ type: "set_auto_retry", enabled: command.enabled });
				return success(id, "set_auto_retry");
			}

			case "abort_retry": {
				await controller.execute({ type: "abort_retry" });
				return success(id, "abort_retry");
			}

			// =================================================================
			// Bash
			// =================================================================

			case "bash": {
				const result = await controller.execute({ type: "bash", command: command.command });
				return success(id, "bash", result);
			}

			case "abort_bash": {
				await controller.execute({ type: "abort_bash" });
				return success(id, "abort_bash");
			}

			// =================================================================
			// Session
			// =================================================================

			case "get_session_stats": {
				const stats = await controller.execute({ type: "get_session_stats" });
				return success(id, "get_session_stats", stats);
			}

			case "export_html": {
				const result = await controller.execute({ type: "export_html", outputPath: command.outputPath });
				return success(id, "export_html", result);
			}

			case "switch_session": {
				const { cancelled } = await controller.execute({
					type: "switch_session",
					sessionPath: command.sessionPath,
				});
				return success(id, "switch_session", { cancelled });
			}

			case "fork": {
				const result = await controller.execute({ type: "fork", entryId: command.entryId });
				return success(id, "fork", result);
			}

			case "get_fork_messages": {
				const messages = await controller.execute({ type: "get_fork_messages" });
				return success(id, "get_fork_messages", { messages });
			}

			case "get_last_assistant_text": {
				const result = await controller.execute({ type: "get_last_assistant_text" });
				return success(id, "get_last_assistant_text", result);
			}

			case "set_session_name": {
				await controller.execute({ type: "set_session_name", name: command.name });
				return success(id, "set_session_name");
			}

			// =================================================================
			// Messages
			// =================================================================

			case "get_messages": {
				const result = await controller.execute({ type: "get_messages" });
				return success(id, "get_messages", result);
			}

			// =================================================================
			// Commands (available for invocation via prompt)
			// =================================================================

			case "get_commands": {
				const result = await controller.execute({ type: "get_commands" });
				return success(id, "get_commands", result);
			}

			default: {
				const unknownCommand = command as { type: string };
				return error(undefined, unknownCommand.type, `Unknown command: ${unknownCommand.type}`);
			}
		}
	};

	/**
	 * Check if shutdown was requested and perform shutdown if so.
	 * Called after handling each command when waiting for the next command.
	 */
	let detachInput = () => {};

	async function shutdown(): Promise<never> {
		const currentRunner = session.extensionRunner;
		if (currentRunner?.hasHandlers("session_shutdown")) {
			await currentRunner.emit({ type: "session_shutdown" });
		}

		detachInput();
		process.stdin.pause();
		process.exit(0);
	}

	async function checkShutdownRequested(): Promise<void> {
		if (!shutdownRequested) return;
		await shutdown();
	}

	const handleInputLine = async (line: string) => {
		try {
			const parsed = JSON.parse(line);

			// Handle extension UI responses
			if (parsed.type === "extension_ui_response") {
				const response = parsed as RpcExtensionUIResponse;
				const pending = pendingExtensionRequests.get(response.id);
				if (pending) {
					pendingExtensionRequests.delete(response.id);
					pending.resolve(response);
				}
				return;
			}

			// Handle regular commands
			const command = parsed as RpcCommand;
			const response = await handleCommand(command);
			output(response);

			// Check for deferred shutdown request (idle between commands)
			await checkShutdownRequested();
		} catch (errorValue: unknown) {
			const message = errorValue instanceof Error ? errorValue.message : String(errorValue);
			output(error(undefined, "parse", `Failed to parse command: ${message}`));
		}
	};

	const onInputEnd = () => {
		void shutdown();
	};
	process.stdin.on("end", onInputEnd);

	detachInput = (() => {
		const detachJsonl = attachJsonlLineReader(process.stdin, (line) => {
			void handleInputLine(line);
		});
		return () => {
			detachJsonl();
			process.stdin.off("end", onInputEnd);
		};
	})();

	// Keep process alive forever
	return new Promise(() => {});
}
