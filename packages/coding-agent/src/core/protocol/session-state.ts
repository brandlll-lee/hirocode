import type { AgentSession } from "../agent-session.js";
import type { RuntimeClientCapabilities, RuntimeSessionMetadata, RuntimeSessionSnapshot } from "./types.js";
import { RUNTIME_PROTOCOL_VERSION } from "./types.js";

export function createRuntimeSessionSnapshot(
	session: AgentSession,
	metadata: RuntimeSessionMetadata,
	capabilities: RuntimeClientCapabilities,
): RuntimeSessionSnapshot {
	return {
		protocolVersion: RUNTIME_PROTOCOL_VERSION,
		model: session.model,
		thinkingLevel: session.thinkingLevel,
		isStreaming: session.isStreaming,
		isCompacting: session.isCompacting,
		steeringMode: session.steeringMode,
		followUpMode: session.followUpMode,
		sessionFile: session.sessionFile,
		sessionId: session.sessionId,
		sessionName: session.sessionName,
		autoCompactionEnabled: session.autoCompactionEnabled,
		messageCount: session.messages.length,
		pendingMessageCount: session.pendingMessageCount,
		activeToolNames: session.getActiveToolNames(),
		metadata: structuredClone(metadata),
		capabilities: structuredClone(capabilities),
	};
}
