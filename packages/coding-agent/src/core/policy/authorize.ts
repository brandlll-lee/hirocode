import {
	createSessionSafetyServices,
	getSessionSafetyServices,
	registerSessionSafetyServices,
} from "../approval/runtime-services.js";
import type { ReadonlySessionManager, SessionManager } from "../session-manager.js";
import type { SettingsManager } from "../settings-manager.js";
import { buildApprovalSubjects } from "./tool-risk.js";
import type { ApprovalMode, ApprovalResult, ApprovalSubject } from "./types.js";

export async function authorizeToolCall(options: {
	toolName: string;
	args: Record<string, unknown>;
	cwd: string;
	sessionManager: ReadonlySessionManager;
	settingsManager: SettingsManager;
	approvalMode: ApprovalMode;
}): Promise<ApprovalResult | undefined> {
	const subjects = await buildApprovalSubjects(options.toolName, options.args, options.cwd);
	if (subjects.length === 0) {
		return undefined;
	}

	const services = getOrCreateServices(options.sessionManager, options.settingsManager, options.approvalMode);
	for (const subject of subjects) {
		const result = await services.approval.request(subject);
		if (!result.allowed) {
			return result;
		}
	}
	return undefined;
}

export async function authorizeDirectBash(options: {
	command: string;
	cwd: string;
	sessionManager: ReadonlySessionManager;
	settingsManager: SettingsManager;
	approvalMode: ApprovalMode;
}): Promise<ApprovalResult | undefined> {
	const subjects = await buildApprovalSubjects("bash", { command: options.command }, options.cwd);
	if (subjects.length === 0) {
		return undefined;
	}
	const services = getOrCreateServices(options.sessionManager, options.settingsManager, options.approvalMode);
	for (const subject of subjects) {
		const result = await services.approval.request(subject);
		if (!result.allowed) {
			return result;
		}
	}
	return undefined;
}

export function getExecutionOperations(
	sessionManager: ReadonlySessionManager,
	settingsManager: SettingsManager,
	approvalMode: ApprovalMode,
) {
	return getOrCreateServices(sessionManager, settingsManager, approvalMode).execution.getBashOperations();
}

export async function requestAdditionalApproval(options: {
	sessionManager: ReadonlySessionManager;
	settingsManager: SettingsManager;
	approvalMode: ApprovalMode;
	subject: ApprovalSubject;
}): Promise<ApprovalResult> {
	return getOrCreateServices(options.sessionManager, options.settingsManager, options.approvalMode).approval.request(
		options.subject,
	);
}

function getOrCreateServices(
	sessionManager: ReadonlySessionManager,
	settingsManager: SettingsManager,
	approvalMode: ApprovalMode,
) {
	const existing = getSessionSafetyServices(sessionManager);
	if (existing) {
		return existing;
	}
	const created = createSessionSafetyServices({
		sessionManager: sessionManager as SessionManager,
		settingsManager,
		approvalMode,
	});
	registerSessionSafetyServices(sessionManager, created);
	return created;
}
