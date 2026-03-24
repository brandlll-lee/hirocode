import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "../../config.js";
import {
	CURRENT_SESSION_VERSION,
	type CustomEntry,
	loadEntriesFromFile,
	type ReadonlySessionManager,
	type SessionEntry,
	type SessionHeader,
	SessionManager,
} from "../session-manager.js";
import type {
	LocatedTaskSession,
	TaskNavigationContext,
	TaskNavigationSession,
	TaskSessionMetadata,
	TaskSessionReference,
	TaskSessionState,
	TaskSessionStatus,
} from "./types.js";

export const SUBAGENT_TASK_CUSTOM_TYPE = "subagent_task";
export const SUBAGENT_TASK_STATE_CUSTOM_TYPE = "subagent_task_state";

interface LegacyStoredTaskReference {
	taskId: string;
	parentSessionId: string;
	agent: string;
	agentSource: TaskSessionMetadata["agentSource"] | "unknown";
	allowSubagents?: boolean;
	taskPermissions?: TaskSessionMetadata["taskPermissions"];
	sessionFile: string;
	metadataFile: string;
	sessionId?: string;
	model?: string;
	tools?: string[];
	systemPrompt?: string;
}

interface StateLike {
	status?: TaskSessionStatus;
	task?: string;
	description?: string;
	errorMessage?: string;
	updatedAt?: string;
}

interface SessionHeaderOnly {
	type: "session";
	id: string;
	parentSession?: string;
	cwd?: string;
	timestamp?: string;
	version?: number;
}

function getLegacySubagentRoot(): string {
	return path.join(getAgentDir(), "subagents");
}

function readSessionHeaderOnly(filePath: string): SessionHeaderOnly | undefined {
	let fileContent: string;
	try {
		fileContent = fs.readFileSync(filePath, "utf-8");
	} catch {
		return undefined;
	}

	const firstLine = fileContent.split(/\r?\n/, 1)[0];
	if (!firstLine) {
		return undefined;
	}

	try {
		const parsed = JSON.parse(firstLine) as unknown;
		if (!parsed || typeof parsed !== "object") {
			return undefined;
		}
		const header = parsed as SessionHeaderOnly;
		return header.type === "session" && typeof header.id === "string" ? header : undefined;
	} catch {
		return undefined;
	}
}

function readTaskSessionMetadataFromEntries(
	entries: Array<SessionHeader | SessionEntry>,
): TaskSessionMetadata | undefined {
	for (const entry of entries) {
		if (entry.type !== "custom") {
			continue;
		}
		if (entry.customType !== SUBAGENT_TASK_CUSTOM_TYPE) {
			continue;
		}
		if (!entry.data || typeof entry.data !== "object") {
			continue;
		}
		const metadata = entry.data as TaskSessionMetadata;
		if (typeof metadata.agent === "string" && typeof metadata.agentSource === "string") {
			return metadata;
		}
	}

	return undefined;
}

function readTaskSessionStateFromEntries(entries: Array<SessionHeader | SessionEntry>): TaskSessionState | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "custom" || entry.customType !== SUBAGENT_TASK_STATE_CUSTOM_TYPE) {
			continue;
		}
		if (!entry.data || typeof entry.data !== "object") {
			continue;
		}
		const state = entry.data as StateLike;
		if (typeof state.status === "string" && typeof state.updatedAt === "string") {
			return {
				status: state.status,
				task: state.task,
				description: state.description,
				errorMessage: state.errorMessage,
				updatedAt: state.updatedAt,
			};
		}
	}

	return undefined;
}

export function readCurrentTaskSessionMetadata(
	sessionManager: ReadonlySessionManager,
): TaskSessionMetadata | undefined {
	return readTaskSessionMetadataFromEntries(sessionManager.getEntries());
}

export function createChildTaskSession(
	sessionManager: ReadonlySessionManager,
	options: {
		cwd: string;
		metadata: TaskSessionMetadata;
		taskId?: string;
		state?: Omit<TaskSessionState, "updatedAt">;
	},
): TaskSessionReference {
	const taskId = options.taskId ?? randomUUID();
	const timestamp = new Date().toISOString();
	const sessionDir = sessionManager.getSessionDir();
	const sessionFile = path.join(sessionDir, `${timestamp.replace(/[:.]/g, "-")}_${taskId}.jsonl`);
	const header: SessionHeader = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: taskId,
		timestamp,
		cwd: options.cwd,
		parentSession: sessionManager.getSessionFile(),
	};
	const metadataEntry: CustomEntry<TaskSessionMetadata> = {
		type: "custom",
		customType: SUBAGENT_TASK_CUSTOM_TYPE,
		data: options.metadata,
		id: randomUUID().slice(0, 8),
		parentId: null,
		timestamp,
	};
	const stateEntry: CustomEntry<TaskSessionState> = {
		type: "custom",
		customType: SUBAGENT_TASK_STATE_CUSTOM_TYPE,
		data: {
			status: options.state?.status ?? "running",
			task: options.state?.task,
			description: options.state?.description,
			errorMessage: options.state?.errorMessage,
			updatedAt: timestamp,
		},
		id: randomUUID().slice(0, 8),
		parentId: metadataEntry.id,
		timestamp,
	};

	fs.mkdirSync(sessionDir, { recursive: true });
	fs.writeFileSync(
		sessionFile,
		`${JSON.stringify(header)}\n${JSON.stringify(metadataEntry)}\n${JSON.stringify(stateEntry)}\n`,
		"utf-8",
	);
	if (options.metadata.title) {
		const childSession = SessionManager.open(sessionFile, sessionDir);
		childSession.appendSessionInfo(options.metadata.title);
	}

	return {
		taskId,
		parentSessionId: sessionManager.getSessionId(),
		parentSessionFile: sessionManager.getSessionFile(),
		sessionId: taskId,
		sessionFile,
	};
}

function findStandardTaskSession(
	sessionManager: ReadonlySessionManager,
	taskId: string,
): LocatedTaskSession | undefined {
	let fileNames: string[];
	try {
		fileNames = fs.readdirSync(sessionManager.getSessionDir()).filter((fileName) => fileName.endsWith(".jsonl"));
	} catch {
		return undefined;
	}

	for (const fileName of fileNames) {
		const sessionFile = path.join(sessionManager.getSessionDir(), fileName);
		const header = readSessionHeaderOnly(sessionFile);
		if (!header || header.id !== taskId) {
			continue;
		}

		const entries = loadEntriesFromFile(sessionFile);
		const metadata = readTaskSessionMetadataFromEntries(entries);
		return {
			reference: {
				taskId,
				parentSessionId: sessionManager.getSessionId(),
				parentSessionFile: header.parentSession,
				sessionId: taskId,
				sessionFile,
			},
			metadata,
			state: readTaskSessionStateFromEntries(entries),
			legacy: false,
		};
	}

	return undefined;
}

function isLegacyStoredTaskReference(value: unknown): value is LegacyStoredTaskReference {
	if (!value || typeof value !== "object") {
		return false;
	}

	const reference = value as LegacyStoredTaskReference;
	return (
		typeof reference.taskId === "string" &&
		typeof reference.parentSessionId === "string" &&
		typeof reference.agent === "string" &&
		typeof reference.sessionFile === "string" &&
		typeof reference.metadataFile === "string"
	);
}

function readLegacyTaskReference(metadataFile: string): LegacyStoredTaskReference | undefined {
	try {
		const parsed = JSON.parse(fs.readFileSync(metadataFile, "utf-8")) as unknown;
		return isLegacyStoredTaskReference(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function* walkLegacyTaskMetadataFiles(dir: string): Generator<string> {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}

	for (const entry of entries) {
		const entryPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			yield* walkLegacyTaskMetadataFiles(entryPath);
			continue;
		}
		if (entry.isFile() && entry.name.endsWith(".json")) {
			yield entryPath;
		}
	}
}

function findLegacyTaskSession(sessionManager: ReadonlySessionManager, taskId: string): LocatedTaskSession | undefined {
	const root = getLegacySubagentRoot();
	const direct = path.join(root, sessionManager.getSessionId(), `task-${taskId}.json`);
	const directReference = fs.existsSync(direct) ? readLegacyTaskReference(direct) : undefined;
	if (directReference) {
		return {
			reference: {
				taskId: directReference.taskId,
				parentSessionId: directReference.parentSessionId,
				sessionId: directReference.sessionId ?? directReference.taskId,
				sessionFile: directReference.sessionFile,
			},
			metadata: {
				agent: directReference.agent,
				agentSource: directReference.agentSource === "unknown" ? "user" : directReference.agentSource,
				allowSubagents: directReference.allowSubagents,
				taskPermissions: directReference.taskPermissions,
				model: directReference.model,
				tools: directReference.tools,
				systemPrompt: directReference.systemPrompt,
			},
			legacy: true,
		};
	}

	for (const metadataFile of walkLegacyTaskMetadataFiles(root)) {
		const reference = readLegacyTaskReference(metadataFile);
		if (!reference) {
			continue;
		}
		if (reference.taskId !== taskId && reference.sessionId !== taskId) {
			continue;
		}

		return {
			reference: {
				taskId: reference.taskId,
				parentSessionId: reference.parentSessionId,
				sessionId: reference.sessionId ?? reference.taskId,
				sessionFile: reference.sessionFile,
			},
			metadata: {
				agent: reference.agent,
				agentSource: reference.agentSource === "unknown" ? "user" : reference.agentSource,
				allowSubagents: reference.allowSubagents,
				taskPermissions: reference.taskPermissions,
				model: reference.model,
				tools: reference.tools,
				systemPrompt: reference.systemPrompt,
			},
			legacy: true,
		};
	}

	return undefined;
}

export function findTaskSession(
	sessionManager: ReadonlySessionManager,
	taskId: string,
): LocatedTaskSession | undefined {
	return findStandardTaskSession(sessionManager, taskId) ?? findLegacyTaskSession(sessionManager, taskId);
}

export function updateTaskSessionState(
	sessionFile: string,
	state: Omit<TaskSessionState, "updatedAt">,
	sessionDir?: string,
): void {
	const session = SessionManager.open(sessionFile, sessionDir);
	session.appendCustomEntry(SUBAGENT_TASK_STATE_CUSTOM_TYPE, {
		...state,
		updatedAt: new Date().toISOString(),
	});
}

export function listChildTaskSessions(sessionManager: ReadonlySessionManager): LocatedTaskSession[] {
	const parentSessionFile = sessionManager.getSessionFile();
	if (!parentSessionFile) {
		return [];
	}

	let fileNames: string[];
	try {
		fileNames = fs.readdirSync(sessionManager.getSessionDir()).filter((fileName) => fileName.endsWith(".jsonl"));
	} catch {
		return [];
	}

	const children: LocatedTaskSession[] = [];
	for (const fileName of fileNames) {
		const sessionFile = path.join(sessionManager.getSessionDir(), fileName);
		const header = readSessionHeaderOnly(sessionFile);
		if (!header || header.parentSession !== parentSessionFile) {
			continue;
		}

		const entries = loadEntriesFromFile(sessionFile);
		const metadata = readTaskSessionMetadataFromEntries(entries);
		if (!metadata) {
			continue;
		}
		children.push({
			reference: {
				taskId: header.id,
				parentSessionId: sessionManager.getSessionId(),
				parentSessionFile,
				sessionId: header.id,
				sessionFile,
			},
			metadata,
			state: readTaskSessionStateFromEntries(entries),
			legacy: false,
		});
	}

	return children.sort((left, right) => {
		const leftWeight = left.state?.status === "running" ? 0 : 1;
		const rightWeight = right.state?.status === "running" ? 0 : 1;
		if (leftWeight !== rightWeight) {
			return leftWeight - rightWeight;
		}
		const leftUpdated = left.state?.updatedAt ?? "";
		const rightUpdated = right.state?.updatedAt ?? "";
		return rightUpdated.localeCompare(leftUpdated);
	});
}

function sortTaskSessions(left: LocatedTaskSession, right: LocatedTaskSession): number {
	const leftWeight = left.state?.status === "running" ? 0 : 1;
	const rightWeight = right.state?.status === "running" ? 0 : 1;
	if (leftWeight !== rightWeight) {
		return leftWeight - rightWeight;
	}
	const leftUpdated = left.state?.updatedAt ?? "";
	const rightUpdated = right.state?.updatedAt ?? "";
	return rightUpdated.localeCompare(leftUpdated);
}

interface StandardTaskIndex {
	headersByFile: Map<string, SessionHeaderOnly>;
	tasksByFile: Map<string, LocatedTaskSession>;
	childrenByParent: Map<string, LocatedTaskSession[]>;
}

function buildStandardTaskIndex(sessionDir: string): StandardTaskIndex {
	let fileNames: string[];
	try {
		fileNames = fs.readdirSync(sessionDir).filter((fileName) => fileName.endsWith(".jsonl"));
	} catch {
		return {
			headersByFile: new Map(),
			tasksByFile: new Map(),
			childrenByParent: new Map(),
		};
	}

	const headersByFile = new Map<string, SessionHeaderOnly>();
	const tasksByFile = new Map<string, LocatedTaskSession>();
	for (const fileName of fileNames) {
		const sessionFile = path.join(sessionDir, fileName);
		const header = readSessionHeaderOnly(sessionFile);
		if (!header) {
			continue;
		}
		headersByFile.set(sessionFile, header);

		const entries = loadEntriesFromFile(sessionFile);
		const metadata = readTaskSessionMetadataFromEntries(entries);
		if (!metadata) {
			continue;
		}
		tasksByFile.set(sessionFile, {
			reference: {
				taskId: header.id,
				parentSessionId: "",
				parentSessionFile: header.parentSession,
				sessionId: header.id,
				sessionFile,
			},
			metadata,
			state: readTaskSessionStateFromEntries(entries),
			legacy: false,
		});
	}

	const childrenByParent = new Map<string, LocatedTaskSession[]>();
	for (const task of tasksByFile.values()) {
		const parentSessionFile = task.reference.parentSessionFile;
		if (!parentSessionFile) {
			continue;
		}
		const children = childrenByParent.get(parentSessionFile) ?? [];
		children.push(task);
		childrenByParent.set(parentSessionFile, children);
	}

	for (const children of childrenByParent.values()) {
		children.sort(sortTaskSessions);
	}

	return { headersByFile, tasksByFile, childrenByParent };
}

export function buildTaskNavigationContext(sessionManager: ReadonlySessionManager): TaskNavigationContext {
	const currentSessionFile = sessionManager.getSessionFile();
	if (!currentSessionFile) {
		return {
			currentSessionFile: undefined,
			currentIsTaskSession: false,
			parentSessionFile: undefined,
			rootSessionFile: undefined,
			sessions: [],
		};
	}

	const index = buildStandardTaskIndex(sessionManager.getSessionDir());
	const currentTask = index.tasksByFile.get(currentSessionFile);
	const currentHeader = index.headersByFile.get(currentSessionFile);
	const parentSessionFile = currentTask?.reference.parentSessionFile ?? currentHeader?.parentSession;

	let rootSessionFile = currentSessionFile;
	if (currentTask && parentSessionFile) {
		rootSessionFile = parentSessionFile;
		let cursor = parentSessionFile;
		while (true) {
			const parentTask = index.tasksByFile.get(cursor);
			const parentHeader = index.headersByFile.get(cursor);
			if (!parentTask || !parentHeader?.parentSession) {
				break;
			}
			rootSessionFile = parentHeader.parentSession;
			cursor = parentHeader.parentSession;
		}
	}

	const sessions: TaskNavigationSession[] = [];
	const visit = (parentFile: string, depth: number) => {
		for (const child of index.childrenByParent.get(parentFile) ?? []) {
			const childParentFile = child.reference.parentSessionFile;
			sessions.push({ ...child, depth, parentSessionFile: childParentFile });
			visit(child.reference.sessionFile, depth + 1);
		}
	};
	visit(rootSessionFile, 1);

	return {
		currentSessionFile,
		currentIsTaskSession: currentTask !== undefined,
		parentSessionFile,
		rootSessionFile,
		sessions,
	};
}

export function formatTaskReferenceLines(reference: Pick<TaskSessionReference, "taskId" | "sessionId">): string[] {
	const lines = [`task_id: ${reference.taskId}`];
	if (reference.sessionId !== reference.taskId) {
		lines.push(`subagent_id: ${reference.sessionId}`);
	}
	return lines;
}

export function formatTaskToolOutput(
	reference: Pick<TaskSessionReference, "taskId" | "sessionId">,
	text: string,
): string {
	const lines = formatTaskReferenceLines(reference);
	lines.push("", "<task_result>", text, "</task_result>");
	return lines.join("\n");
}
