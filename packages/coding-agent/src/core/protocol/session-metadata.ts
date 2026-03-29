import type { CustomEntry, ReadonlySessionManager, SessionManager } from "../session-manager.js";
import { RUNTIME_PROTOCOL_VERSION, type RuntimeClientCapabilities, type RuntimeSessionMetadata } from "./types.js";

export const RUNTIME_SESSION_METADATA_TYPE = "hirocode.runtime_metadata";

export interface PersistedRuntimeSessionMetadata {
	protocolVersion: typeof RUNTIME_PROTOCOL_VERSION;
	metadata: RuntimeSessionMetadata;
	capabilities: RuntimeClientCapabilities;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function normalizeList(values: readonly string[] | undefined): string[] {
	if (!values) return [];
	const seen = new Set<string>();
	for (const value of values) {
		const trimmed = value.trim();
		if (trimmed.length > 0) {
			seen.add(trimmed);
		}
	}
	return Array.from(seen);
}

export function normalizeRuntimeClientCapabilities(
	capabilities: Partial<RuntimeClientCapabilities> & Pick<RuntimeClientCapabilities, "clientKind">,
): RuntimeClientCapabilities {
	return {
		clientKind: capabilities.clientKind,
		approvalUi: capabilities.approvalUi ?? false,
		missionControl: capabilities.missionControl ?? false,
		mcpManager: capabilities.mcpManager ?? false,
		specReview: capabilities.specReview ?? false,
		widgets: capabilities.widgets ?? false,
		customUi: capabilities.customUi ?? false,
		themeControl: capabilities.themeControl ?? false,
	};
}

export function normalizeRuntimeSessionMetadata(
	metadata: Partial<RuntimeSessionMetadata> & Pick<RuntimeSessionMetadata, "mode">,
): RuntimeSessionMetadata {
	return {
		mode: metadata.mode,
		autonomy: metadata.autonomy ?? "manual",
		specState: metadata.specState ?? "inactive",
		missionState: metadata.missionState ?? "inactive",
		tags: normalizeList(metadata.tags),
		activeAgents: normalizeList(metadata.activeAgents),
	};
}

export function createPersistedRuntimeSessionMetadata(
	metadata: Partial<RuntimeSessionMetadata> & Pick<RuntimeSessionMetadata, "mode">,
	capabilities: Partial<RuntimeClientCapabilities> & Pick<RuntimeClientCapabilities, "clientKind">,
): PersistedRuntimeSessionMetadata {
	return {
		protocolVersion: RUNTIME_PROTOCOL_VERSION,
		metadata: normalizeRuntimeSessionMetadata(metadata),
		capabilities: normalizeRuntimeClientCapabilities(capabilities),
	};
}

function isPersistedRuntimeSessionMetadata(value: unknown): value is PersistedRuntimeSessionMetadata {
	if (!isRecord(value)) return false;
	if (value.protocolVersion !== RUNTIME_PROTOCOL_VERSION) return false;
	if (!isRecord(value.metadata) || !isRecord(value.capabilities)) return false;
	if (typeof value.metadata.mode !== "string") return false;
	if (typeof value.capabilities.clientKind !== "string") return false;
	return true;
}

function serialize(value: PersistedRuntimeSessionMetadata): string {
	return JSON.stringify(value);
}

export function readLatestRuntimeSessionMetadata(
	sessionManager: ReadonlySessionManager,
): PersistedRuntimeSessionMetadata | undefined {
	const entries = sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "custom" || entry.customType !== RUNTIME_SESSION_METADATA_TYPE) {
			continue;
		}
		const customEntry = entry as CustomEntry;
		if (isPersistedRuntimeSessionMetadata(customEntry.data)) {
			return customEntry.data;
		}
	}
	return undefined;
}

export function writeRuntimeSessionMetadata(
	sessionManager: SessionManager,
	metadata: Partial<RuntimeSessionMetadata> & Pick<RuntimeSessionMetadata, "mode">,
	capabilities: Partial<RuntimeClientCapabilities> & Pick<RuntimeClientCapabilities, "clientKind">,
): boolean {
	const next = createPersistedRuntimeSessionMetadata(metadata, capabilities);
	const current = readLatestRuntimeSessionMetadata(sessionManager);
	if (current && serialize(current) === serialize(next)) {
		return false;
	}
	sessionManager.appendCustomEntry(RUNTIME_SESSION_METADATA_TYPE, next);
	return true;
}
