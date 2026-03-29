import { randomUUID } from "node:crypto";
import { evaluatePermission } from "../policy/evaluate.js";
import type {
	ApprovalDecision,
	ApprovalMode,
	ApprovalRequest,
	ApprovalResult,
	ApprovalSubject,
	MatchedRule,
	PermissionAction,
	PermissionRule,
	PersistedApprovalDecision,
	PersistedApprovalRequest,
} from "../policy/types.js";
import type { ReadonlySessionManager, SessionManager } from "../session-manager.js";
import type { SettingsManager } from "../settings-manager.js";
import { readLatestSpecState } from "../spec/state.js";

export const APPROVAL_REQUEST_CUSTOM_TYPE = "hirocode.approval.request";
export const APPROVAL_DECISION_CUSTOM_TYPE = "hirocode.approval.decision";

interface PendingApproval {
	request: ApprovalRequest;
	resolve: (result: ApprovalResult) => void;
	reject: (error: Error) => void;
}

export type ApprovalManagerEvent =
	| { type: "requested"; request: ApprovalRequest }
	| { type: "resolved"; request: ApprovalRequest; result: ApprovalResult };

export interface ApprovalManagerOptions {
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	mode: ApprovalMode;
}

export class ApprovalManager {
	private readonly sessionManager: SessionManager;
	private readonly settingsManager: SettingsManager;
	private mode: ApprovalMode;
	private listeners = new Set<(event: ApprovalManagerEvent) => void>();
	private pending = new Map<string, PendingApproval>();
	private sessionRules: Array<PermissionRule & { source: MatchedRule["source"] }> = [];
	private lastSessionId = "";

	constructor(options: ApprovalManagerOptions) {
		this.sessionManager = options.sessionManager;
		this.settingsManager = options.settingsManager;
		this.mode = options.mode;
		this.syncSessionRules();
	}

	setMode(mode: ApprovalMode): void {
		this.mode = mode;
	}

	subscribe(listener: (event: ApprovalManagerEvent) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	getPendingRequests(): ApprovalRequest[] {
		this.syncSessionRules();
		return Array.from(this.pending.values()).map((entry, index, all) => ({
			...entry.request,
			pendingCount: all.length - index,
		}));
	}

	async request(subject: ApprovalSubject): Promise<ApprovalResult> {
		this.syncSessionRules();
		const matchedRule = evaluatePermission(
			subject.permission,
			subject.pattern,
			this.settingsManager.getGlobalPermissionRulesWithSource(),
			this.settingsManager.getProjectPermissionRulesWithSource(),
			this.sessionRules,
		);

		if (subject.hardDeny) {
			const result: ApprovalResult = {
				allowed: false,
				action: "deny",
				scope: "once",
				reason: subject.justification,
				matchedRule,
			};
			this.emitResolved(undefined, subject, result);
			return result;
		}

		if (matchedRule?.action === "allow") {
			return {
				allowed: true,
				action: "allow",
				scope: matchedRule.source === "session" ? "session" : matchedRule.source,
				reason: `Allowed by ${matchedRule.source} permission rule ${matchedRule.permission}:${matchedRule.pattern}`,
				matchedRule,
			};
		}

		if (matchedRule?.action === "deny") {
			const result: ApprovalResult = {
				allowed: false,
				action: "deny",
				scope: matchedRule.source === "session" ? "session" : matchedRule.source,
				reason: `Denied by ${matchedRule.source} permission rule ${matchedRule.permission}:${matchedRule.pattern}`,
				matchedRule,
			};
			this.emitResolved(undefined, subject, result);
			return result;
		}

		if (matchedRule?.action !== "ask" && shouldAutoApproveInSpecPlanning(this.sessionManager, subject)) {
			return {
				allowed: true,
				action: "allow",
				scope: "once",
				reason: "Allowed by specification planning policy for read-only inspection.",
				matchedRule,
			};
		}

		const fallback = this.evaluateFallback(subject, matchedRule?.action);
		if (fallback !== "ask") {
			const result: ApprovalResult = {
				allowed: fallback === "allow",
				action: fallback,
				scope: "once",
				reason:
					fallback === "allow"
						? `Allowed by ${this.settingsManager.getApprovalPolicy()} policy in ${this.settingsManager.getAutonomyMode()} mode.`
						: this.mode === "disabled"
							? "Approval required but no approval client is available in this runtime."
							: `Denied by ${this.settingsManager.getApprovalPolicy()} policy.`,
				matchedRule,
			};
			this.emitResolved(undefined, subject, result);
			return result;
		}

		const request = this.createRequest(subject);
		this.appendRequestTrace(request);

		if (this.mode === "disabled") {
			const denied: ApprovalResult = {
				allowed: false,
				action: "deny",
				scope: "once",
				reason: "Approval required but the current runtime cannot present approval prompts.",
				matchedRule,
				requestId: request.id,
			};
			this.appendDecisionTrace(request, {
				requestId: request.id,
				action: "deny",
				scope: "once",
				reason: denied.reason,
			});
			this.emit({ type: "resolved", request, result: denied });
			return denied;
		}

		return new Promise<ApprovalResult>((resolve, reject) => {
			this.pending.set(request.id, {
				request,
				resolve,
				reject,
			});
			this.emit({ type: "requested", request });
		});
	}

	resolve(decision: ApprovalDecision): ApprovalResult {
		const pending = this.pending.get(decision.requestId);
		if (!pending) {
			throw new Error(`Unknown approval request: ${decision.requestId}`);
		}
		this.pending.delete(decision.requestId);
		const result = this.applyDecision(pending.request, decision);
		pending.resolve(result);
		return result;
	}

	private applyDecision(
		request: ApprovalRequest,
		decision: ApprovalDecision,
		matchedRule?: MatchedRule,
	): ApprovalResult {
		this.syncSessionRules();
		this.appendDecisionTrace(request, decision);
		if (decision.action === "allow" && decision.scope !== "once") {
			const rule: PermissionRule = {
				permission: request.subject.permission,
				pattern: request.subject.pattern,
				action: "allow",
			};
			if (decision.scope === "session") {
				this.sessionRules.push({ ...rule, source: "session" });
			}
			if (decision.scope === "project" || decision.scope === "global") {
				this.settingsManager.addPermissionRule(decision.scope, rule);
			}
		}
		const result: ApprovalResult = {
			allowed: decision.action === "allow",
			action: decision.action,
			scope: decision.scope,
			reason: decision.reason,
			matchedRule,
			requestId: request.id,
		};
		this.emit({ type: "resolved", request, result });
		return result;
	}

	private createRequest(subject: ApprovalSubject): ApprovalRequest {
		const pendingCount = this.pending.size + 1;
		return {
			id: randomUUID(),
			createdAt: new Date().toISOString(),
			subject,
			availableScopes: ["once", "session", "project", "global"],
			pendingCount,
		};
	}

	private evaluateFallback(subject: ApprovalSubject, explicitAction: PermissionAction | undefined): PermissionAction {
		if (explicitAction === "ask") {
			return this.mode === "disabled" ? "deny" : "ask";
		}

		const policy = this.settingsManager.getApprovalPolicy();
		if (policy === "headless-reject" && this.mode === "disabled") {
			return canAutoApprove(this.settingsManager.getAutonomyMode(), subject) ? "allow" : "deny";
		}

		if (policy === "always-ask") {
			if (requiresManualApproval(subject)) {
				return this.mode === "disabled" ? "deny" : "ask";
			}
			return "allow";
		}

		return canAutoApprove(this.settingsManager.getAutonomyMode(), subject)
			? "allow"
			: this.mode === "disabled"
				? "deny"
				: "ask";
	}

	private syncSessionRules(): void {
		const sessionId = this.sessionManager.getSessionId();
		if (sessionId === this.lastSessionId) {
			return;
		}
		this.lastSessionId = sessionId;
		this.sessionRules = readSessionRules(this.sessionManager);
		for (const pending of this.pending.values()) {
			pending.reject(new Error("Approval queue reset because the session changed."));
		}
		this.pending.clear();
	}

	private appendRequestTrace(request: ApprovalRequest): void {
		const payload: PersistedApprovalRequest = {
			requestId: request.id,
			createdAt: request.createdAt,
			subject: request.subject,
			availableScopes: request.availableScopes,
			pendingCount: request.pendingCount,
		};
		this.sessionManager.appendCustomEntry(APPROVAL_REQUEST_CUSTOM_TYPE, payload);
	}

	private appendDecisionTrace(request: ApprovalRequest, decision: ApprovalDecision): void {
		const payload: PersistedApprovalDecision = {
			requestId: decision.requestId,
			decidedAt: new Date().toISOString(),
			action: decision.action,
			scope: decision.scope,
			reason: decision.reason,
			subject: request.subject,
		};
		this.sessionManager.appendCustomEntry(APPROVAL_DECISION_CUSTOM_TYPE, payload);
	}

	private emitResolved(request: ApprovalRequest | undefined, subject: ApprovalSubject, result: ApprovalResult): void {
		if (!request) {
			return;
		}
		this.emit({ type: "resolved", request, result });
		void subject;
	}

	private emit(event: ApprovalManagerEvent): void {
		for (const listener of this.listeners) {
			listener(event);
		}
	}
}

function readSessionRules(
	sessionManager: ReadonlySessionManager,
): Array<PermissionRule & { source: MatchedRule["source"] }> {
	const entries = sessionManager.getEntries();
	const rules: Array<PermissionRule & { source: MatchedRule["source"] }> = [];
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== APPROVAL_DECISION_CUSTOM_TYPE) {
			continue;
		}
		const payload = entry.data;
		if (!isPersistedDecision(payload)) {
			continue;
		}
		if (payload.scope !== "session") {
			continue;
		}
		rules.push({
			permission: payload.subject.permission,
			pattern: payload.subject.pattern,
			action: payload.action,
			source: "session",
		});
	}
	return rules;
}

function canAutoApprove(mode: ReturnType<SettingsManager["getAutonomyMode"]>, subject: ApprovalSubject): boolean {
	if (requiresExplicitApproval(subject)) {
		return false;
	}

	if (subject.level === "low") {
		return true;
	}
	if (mode === "normal") {
		return false;
	}
	if (mode === "auto-low") {
		return isFileMutation(subject) || isReadOnlyBash(subject);
	}
	if (mode === "auto-medium") {
		return isFileMutation(subject) || isReadOnlyBash(subject) || isReversibleCommand(subject);
	}
	if (mode === "auto-high") {
		return subject.level !== "critical";
	}
	return false;
}

function shouldAutoApproveInSpecPlanning(sessionManager: ReadonlySessionManager, subject: ApprovalSubject): boolean {
	const specState = readLatestSpecState(sessionManager);
	if (specState?.phase !== "planning" || specState.maskEnabled === false) {
		return false;
	}

	if (subject.permission === "bash") {
		return subject.level === "low" && subject.tags.includes("read-only-command");
	}

	if (subject.permission === "read") {
		return subject.level === "low" && subject.tags.includes("read-only");
	}

	return (
		subject.level === "low" &&
		(subject.permission === "grep" ||
			subject.permission === "find" ||
			subject.permission === "ls" ||
			subject.permission === "webfetch" ||
			subject.permission === "websearch")
	);
}

function requiresManualApproval(subject: ApprovalSubject): boolean {
	return (
		requiresExplicitApproval(subject) ||
		subject.permission === "bash" ||
		subject.permission === "edit" ||
		subject.permission === "write" ||
		subject.permission === "task" ||
		subject.permission === "external_directory"
	);
}

function requiresExplicitApproval(subject: ApprovalSubject): boolean {
	return subject.permission === "external_directory" || subject.tags.includes("explicit-approval-required");
}

function isFileMutation(subject: ApprovalSubject): boolean {
	return subject.tags.includes("file-mutation");
}

function isReadOnlyBash(subject: ApprovalSubject): boolean {
	return subject.permission === "bash" && subject.tags.includes("read-only-command");
}

function isReversibleCommand(subject: ApprovalSubject): boolean {
	return subject.permission === "bash" && subject.tags.includes("reversible-command");
}

function isPersistedDecision(value: unknown): value is PersistedApprovalDecision {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const payload = value as Partial<PersistedApprovalDecision>;
	return (
		typeof payload.requestId === "string" &&
		typeof payload.decidedAt === "string" &&
		(payload.action === "allow" || payload.action === "ask" || payload.action === "deny") &&
		typeof payload.subject === "object" &&
		payload.subject !== null
	);
}
