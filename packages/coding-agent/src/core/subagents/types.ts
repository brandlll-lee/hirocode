import type { Message } from "@hirocode/ai";

export type AgentScope = "user" | "project" | "both";
export type AgentSource = "built-in" | "user" | "project";
export type TaskPermissionAction = "allow" | "deny" | "ask";

export interface TaskPermissionRule {
	pattern: string;
	action: TaskPermissionAction;
}

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	allowSubagents?: boolean;
	taskPermissions?: TaskPermissionRule[];
	systemPrompt: string;
	source: AgentSource;
	filePath?: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

export interface ParentModelReference {
	provider: string;
	id: string;
}

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface TaskSessionReference {
	taskId: string;
	parentSessionId: string;
	parentSessionFile?: string;
	sessionId: string;
	sessionFile: string;
}

export interface TaskSessionMetadata {
	agent: string;
	agentSource: AgentSource;
	allowSubagents?: boolean;
	taskPermissions?: TaskPermissionRule[];
	title?: string;
	model?: string;
	tools?: string[];
	systemPrompt?: string;
}

export type TaskSessionStatus = "running" | "completed" | "failed" | "error" | "aborted";

export interface TaskSessionState {
	status: TaskSessionStatus;
	task?: string;
	description?: string;
	errorMessage?: string;
	updatedAt: string;
}

export interface DelegatedTaskResult {
	taskId: string;
	parentSessionId: string;
	parentSessionFile?: string;
	sessionId: string;
	sessionFile: string;
	provider?: string;
	agent: string;
	agentSource: AgentSource;
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	tools?: string[];
	systemPrompt?: string;
	resumed?: boolean;
	stopReason?: string;
	errorMessage?: string;
}

export interface LocatedTaskSession {
	reference: TaskSessionReference;
	metadata?: TaskSessionMetadata;
	state?: TaskSessionState;
	legacy: boolean;
}

export interface TaskNavigationSession extends LocatedTaskSession {
	depth: number;
	parentSessionFile?: string;
}

export interface TaskNavigationContext {
	currentSessionFile?: string;
	currentIsTaskSession: boolean;
	parentSessionFile?: string;
	rootSessionFile?: string;
	sessions: TaskNavigationSession[];
}
