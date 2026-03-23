import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "../../../src/config.js";
import { CURRENT_SESSION_VERSION } from "../../../src/core/session-manager.js";

export interface StoredTaskReference {
	taskId: string;
	parentSessionId: string;
	agent: string;
	agentSource: "user" | "project" | "unknown";
	allowSubagents?: boolean;
	sessionFile: string;
	metadataFile: string;
	sessionId?: string;
	provider?: string;
	model?: string;
	tools?: string[];
	systemPrompt?: string;
}

interface SessionBranchEntryLike {
	type: string;
	message?: {
		role?: string;
		toolName?: string;
		details?: unknown;
	};
}

interface TaskResultLike {
	taskId?: string;
	parentSessionId?: string;
	agent?: string;
	agentSource?: "user" | "project" | "unknown";
	allowSubagents?: boolean;
	sessionFile?: string;
	metadataFile?: string;
	sessionId?: string;
	provider?: string;
	model?: string;
	tools?: string[];
	systemPrompt?: string;
}

function getSubagentRoot(): string {
	return path.join(getAgentDir(), "subagents");
}

export function isSubagentSessionFile(filePath: string | undefined): boolean {
	if (!filePath) {
		return false;
	}

	const relative = path.relative(getSubagentRoot(), path.resolve(filePath));
	return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function getTaskDirectory(parentSessionId: string): string {
	return path.join(getSubagentRoot(), parentSessionId);
}

function isStoredTaskReference(value: unknown): value is StoredTaskReference {
	if (!value || typeof value !== "object") return false;
	return (
		typeof (value as StoredTaskReference).taskId === "string" &&
		typeof (value as StoredTaskReference).parentSessionId === "string" &&
		typeof (value as StoredTaskReference).agent === "string" &&
		typeof (value as StoredTaskReference).sessionFile === "string" &&
		typeof (value as StoredTaskReference).metadataFile === "string"
	);
}

function toStoredTaskReference(result: TaskResultLike): StoredTaskReference | undefined {
	if (!result.taskId || !result.parentSessionId || !result.agent || !result.sessionFile || !result.metadataFile) {
		return undefined;
	}

	return {
		taskId: result.taskId,
		parentSessionId: result.parentSessionId,
		agent: result.agent,
		agentSource: result.agentSource ?? "unknown",
		allowSubagents: result.allowSubagents,
		sessionFile: result.sessionFile,
		metadataFile: result.metadataFile,
		sessionId: result.sessionId,
		provider: result.provider,
		model: result.model,
		tools: result.tools,
		systemPrompt: result.systemPrompt,
	};
}

export function createTaskReference(
	parentSessionId: string,
	config: Pick<
		StoredTaskReference,
		"agent" | "agentSource" | "allowSubagents" | "provider" | "model" | "tools" | "systemPrompt"
	>,
): StoredTaskReference {
	const taskId = randomUUID();
	const dir = getTaskDirectory(parentSessionId);
	return {
		taskId,
		parentSessionId,
		agent: config.agent,
		agentSource: config.agentSource,
		allowSubagents: config.allowSubagents,
		sessionFile: path.join(dir, `task-${taskId}.jsonl`),
		metadataFile: path.join(dir, `task-${taskId}.json`),
		sessionId: taskId,
		provider: config.provider,
		model: config.model,
		tools: config.tools,
		systemPrompt: config.systemPrompt,
	};
}

export function initializeTaskSession(reference: StoredTaskReference, cwd: string, parentSessionFile?: string): void {
	if (fs.existsSync(reference.sessionFile)) {
		return;
	}

	fs.mkdirSync(path.dirname(reference.sessionFile), { recursive: true });
	fs.writeFileSync(
		reference.sessionFile,
		`${JSON.stringify({
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: reference.taskId,
			timestamp: new Date().toISOString(),
			cwd,
			parentSession: parentSessionFile,
		})}\n`,
		"utf-8",
	);
}

export function persistTaskReference(reference: StoredTaskReference): void {
	fs.mkdirSync(path.dirname(reference.metadataFile), { recursive: true });
	fs.writeFileSync(reference.metadataFile, `${JSON.stringify(reference, null, 2)}\n`, "utf-8");
}

export function extractStoredTaskReferences(details: unknown): StoredTaskReference[] {
	if (!details || typeof details !== "object") return [];
	const results = (details as { results?: unknown[] }).results;
	if (!Array.isArray(results)) return [];
	return results
		.map((result) => toStoredTaskReference(result as TaskResultLike))
		.filter((result): result is StoredTaskReference => Boolean(result));
}

export function findStoredTaskReferenceInBranch(
	entries: SessionBranchEntryLike[],
	taskId: string,
): StoredTaskReference | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		if (entry.message?.role !== "toolResult") continue;
		const references = extractStoredTaskReferences(entry.message.details);
		const match = references.find((reference) => reference.taskId === taskId || reference.sessionId === taskId);
		if (match) return match;
	}
	return undefined;
}

function readTaskReference(metadataFile: string): StoredTaskReference | undefined {
	try {
		const parsed = JSON.parse(fs.readFileSync(metadataFile, "utf-8")) as unknown;
		return isStoredTaskReference(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function* walkTaskMetadataFiles(dir: string): Generator<string> {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}

	for (const entry of entries) {
		const entryPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			yield* walkTaskMetadataFiles(entryPath);
			continue;
		}

		if (entry.isFile() && entry.name.endsWith(".json")) {
			yield entryPath;
		}
	}
}

export function findStoredTaskReferenceOnDisk(
	taskId: string,
	parentSessionId?: string,
): StoredTaskReference | undefined {
	const root = getSubagentRoot();
	if (parentSessionId) {
		const direct = path.join(getTaskDirectory(parentSessionId), `task-${taskId}.json`);
		if (fs.existsSync(direct)) {
			return readTaskReference(direct);
		}
	}

	for (const metadataFile of walkTaskMetadataFiles(root)) {
		const reference = readTaskReference(metadataFile);
		if (reference && (reference.taskId === taskId || reference.sessionId === taskId)) {
			return reference;
		}
	}

	return undefined;
}

export function formatTaskToolOutput(
	reference: Pick<StoredTaskReference, "taskId" | "sessionId">,
	text: string,
): string {
	const lines = formatTaskReferenceLines(reference);
	lines.push("", "<task_result>", text, "</task_result>");
	return lines.join("\n");
}

export function formatTaskReferenceLines(reference: Pick<StoredTaskReference, "taskId" | "sessionId">): string[] {
	const lines = [`task_id: ${reference.taskId}`];
	if (reference.sessionId && reference.sessionId !== reference.taskId) {
		lines.push(`subagent_id: ${reference.sessionId}`);
	}
	return lines;
}
