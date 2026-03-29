export type PermissionAction = "allow" | "ask" | "deny";

export type ApprovalPolicy = "always-ask" | "policy-driven" | "headless-reject";

export type AutonomyMode = "normal" | "auto-low" | "auto-medium" | "auto-high";

export type SandboxAdapter = "local" | "sandbox";

export type ToolPermission =
	| "read"
	| "grep"
	| "find"
	| "ls"
	| "edit"
	| "write"
	| "bash"
	| "task"
	| "webfetch"
	| "websearch"
	| "external_directory";

export type RiskLevel = "low" | "medium" | "high" | "critical";

export type ApprovalMode = "interactive" | "external" | "disabled";

export type DecisionScope = "once" | "session" | "project" | "global";

export interface PermissionRule {
	permission: string;
	pattern: string;
	action: PermissionAction;
}

export interface SandboxNetworkPolicy {
	allowedDomains?: string[];
	deniedDomains?: string[];
}

export interface SandboxFilesystemPolicy {
	denyRead?: string[];
	allowWrite?: string[];
	denyWrite?: string[];
}

export interface SandboxPolicy {
	enabled?: boolean;
	adapter?: SandboxAdapter;
	network?: SandboxNetworkPolicy;
	filesystem?: SandboxFilesystemPolicy;
	ignoreViolations?: Record<string, string[]>;
	enableWeakerNestedSandbox?: boolean;
}

export interface MatchedRule extends PermissionRule {
	source: "global" | "project" | "session";
}

export interface RiskAssessment {
	permission: ToolPermission;
	pattern: string;
	normalizedPattern: string;
	level: RiskLevel;
	summary: string;
	justification: string;
	tags: string[];
	hardDeny?: boolean;
	metadata?: Record<string, unknown>;
}

export interface ApprovalSubject extends RiskAssessment {
	displayTarget: string;
}

export interface ApprovalRequest {
	id: string;
	createdAt: string;
	subject: ApprovalSubject;
	availableScopes: DecisionScope[];
	pendingCount: number;
}

export interface ApprovalDecision {
	requestId: string;
	action: PermissionAction;
	scope: DecisionScope;
	reason?: string;
}

export interface ApprovalResult {
	allowed: boolean;
	action: PermissionAction;
	scope: DecisionScope;
	reason?: string;
	matchedRule?: MatchedRule;
	requestId?: string;
}

export interface PersistedApprovalRequest {
	requestId: string;
	createdAt: string;
	subject: ApprovalSubject;
	availableScopes: DecisionScope[];
	pendingCount: number;
}

export interface PersistedApprovalDecision {
	requestId: string;
	decidedAt: string;
	action: PermissionAction;
	scope: DecisionScope;
	reason?: string;
	subject: ApprovalSubject;
}
