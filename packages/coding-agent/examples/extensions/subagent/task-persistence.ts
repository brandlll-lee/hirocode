import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "../../../src/config.js";

export interface StoredTaskReference {
	taskId: string;
	parentSessionId: string;
	agent: string;
	agentSource: "built-in" | "user" | "project" | "unknown";
	allowSubagents?: boolean;
	taskPermissions?: Array<{ pattern: string; action: "allow" | "deny" | "ask" }>;
	sessionFile: string;
	metadataFile: string;
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

export function formatTaskReferenceLines(reference: Pick<StoredTaskReference, "taskId" | "sessionId">): string[] {
	const lines = [`task_id: ${reference.taskId}`];
	if (reference.sessionId && reference.sessionId !== reference.taskId) {
		lines.push(`subagent_id: ${reference.sessionId}`);
	}
	return lines;
}
