/**
 * Print mode (single-shot): Send prompts, output result, exit.
 *
 * Used for:
 * - `pi -p "prompt"` - text output
 * - `pi --mode json "prompt"` - JSON event stream
 */

import type { AssistantMessage, ImageContent } from "@hirocode/ai";
import type { AgentSession } from "../core/agent-session.js";
import type { RuntimeProfile } from "../core/benchmark-profile.js";
import { SessionRuntimeController } from "../core/runtime/session-runtime-controller.js";

/**
 * Options for print mode.
 */
export interface PrintModeOptions {
	/** Output mode: "text" for final response only, "json" for all events */
	mode: "text" | "json";
	/** Array of additional prompts to send after initialMessage */
	messages?: string[];
	/** First message to send (may contain @file content) */
	initialMessage?: string;
	/** Images to attach to the initial message */
	initialImages?: ImageContent[];
	/** Optional runtime profile for benchmark/non-interactive behavior */
	runtimeProfile?: RuntimeProfile;
}

function getLastAssistantMessage(session: AgentSession): AssistantMessage | undefined {
	const messages = session.state.messages;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "assistant") {
			return message as AssistantMessage;
		}
	}
	return undefined;
}

async function runForcedVerificationPass(
	controller: SessionRuntimeController,
	runtimeProfile: RuntimeProfile | undefined,
): Promise<void> {
	if (!runtimeProfile?.forceVerification || !runtimeProfile.verificationPrompt) {
		return;
	}

	const lastAssistant = getLastAssistantMessage(controller.agentSession);
	if (!lastAssistant) {
		return;
	}

	if (lastAssistant.stopReason === "error" || lastAssistant.stopReason === "aborted") {
		return;
	}

	const handle = await controller.execute({
		type: "prompt",
		message: runtimeProfile.verificationPrompt,
		expandPromptTemplates: false,
		source: "extension",
	});
	await handle.completion;
}

/**
 * Run in print (single-shot) mode.
 * Sends prompts to the agent and outputs the result.
 */
export async function runPrintMode(session: AgentSession, options: PrintModeOptions): Promise<void> {
	const { mode, messages = [], initialMessage, initialImages, runtimeProfile } = options;
	const controller = new SessionRuntimeController({
		session,
		mode: mode === "json" ? "json" : "text",
		clientCapabilities: {
			approvalUi: false,
			missionControl: false,
			mcpManager: false,
			specReview: false,
			widgets: false,
			customUi: false,
			themeControl: false,
		},
		onExtensionError: (err) => {
			console.error(`Extension error (${err.extensionPath}): ${err.error}`);
		},
	});

	if (mode === "json") {
		const header = session.sessionManager.getHeader();
		if (header) {
			console.log(JSON.stringify(header));
		}
	}
	controller.subscribe((event) => {
		// In JSON mode, output all events
		if (mode === "json") {
			console.log(JSON.stringify(event));
		}
	});
	await controller.start();

	// Send initial message with attachments
	if (initialMessage) {
		const handle = await controller.execute({ type: "prompt", message: initialMessage, images: initialImages });
		await handle.completion;
	}

	// Send remaining messages
	for (const message of messages) {
		const handle = await controller.execute({ type: "prompt", message });
		await handle.completion;
	}

	await runForcedVerificationPass(controller, runtimeProfile);

	// In text mode, output final response
	if (mode === "text") {
		const state = session.state;
		const lastMessage = state.messages[state.messages.length - 1];

		if (lastMessage?.role === "assistant") {
			const assistantMsg = lastMessage as AssistantMessage;

			// Check for error/aborted
			if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
				console.error(assistantMsg.errorMessage || `Request ${assistantMsg.stopReason}`);
				process.exit(1);
			}

			// Output text content
			for (const content of assistantMsg.content) {
				if (content.type === "text") {
					console.log(content.text);
				}
			}
		}
	}

	// Ensure stdout is fully flushed before returning
	// This prevents race conditions where the process exits before all output is written
	await new Promise<void>((resolve, reject) => {
		process.stdout.write("", (err) => {
			if (err) reject(err);
			else resolve();
		});
	});
}
