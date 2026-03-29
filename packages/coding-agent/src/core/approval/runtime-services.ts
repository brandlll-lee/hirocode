import { LocalExecutionService } from "../execution/local-adapter.js";
import { SandboxExecutionService } from "../execution/sandbox-adapter.js";
import type { ExecutionService } from "../execution/types.js";
import type { ApprovalMode } from "../policy/types.js";
import type { ReadonlySessionManager, SessionManager } from "../session-manager.js";
import type { SettingsManager } from "../settings-manager.js";
import { ApprovalManager } from "./manager.js";

export interface SessionSafetyServices {
	approval: ApprovalManager;
	execution: ExecutionService;
	dispose(): Promise<void>;
}

const registry = new WeakMap<ReadonlySessionManager, SessionSafetyServices>();

export function createSessionSafetyServices(options: {
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	approvalMode: ApprovalMode;
}): SessionSafetyServices {
	const approval = new ApprovalManager({
		sessionManager: options.sessionManager,
		settingsManager: options.settingsManager,
		mode: options.approvalMode,
	});
	const execution = createExecutionService(options.settingsManager);
	return {
		approval,
		execution,
		async dispose() {
			await execution.dispose();
		},
	};
}

export function registerSessionSafetyServices(
	sessionManager: ReadonlySessionManager,
	services: SessionSafetyServices,
): void {
	registry.set(sessionManager, services);
}

export function getSessionSafetyServices(sessionManager: ReadonlySessionManager): SessionSafetyServices | undefined {
	return registry.get(sessionManager);
}

export function unregisterSessionSafetyServices(sessionManager: ReadonlySessionManager): void {
	registry.delete(sessionManager);
}

function createExecutionService(settingsManager: SettingsManager): ExecutionService {
	const local = new LocalExecutionService();
	const sandbox = new SandboxExecutionService(settingsManager);
	return {
		getBashOperations() {
			const policy = settingsManager.getSandboxPolicy();
			if (policy.enabled && policy.adapter === "sandbox") {
				return sandbox.getBashOperations();
			}
			return local.getBashOperations();
		},
		async dispose() {
			await sandbox.dispose();
			await local.dispose();
		},
	};
}
