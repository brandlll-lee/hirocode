import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ReadonlySessionManager, SessionManager } from "../session-manager.js";
import { withFileMutationQueue } from "../tools/file-mutation-queue.js";
import type { MissionEvent, MissionPlan, MissionRecord, MissionSessionLink, MissionStatus } from "./types.js";

export const MISSION_SESSION_LINK_CUSTOM_TYPE = "hirocode.mission.link";

export interface MissionStorePaths {
	rootDir: string;
	missionDir: string;
	missionFile: string;
	eventsFile: string;
	planJsonFile: string;
	planMarkdownFile: string;
	artifactsDir: string;
	worktreesDir: string;
}

export function createMissionRecord(goal: string, cwd: string): MissionRecord {
	const id = randomUUID();
	const timestamp = new Date().toISOString();
	const paths = resolveMissionPaths(cwd, id);
	return {
		id,
		goal,
		title: goal,
		status: "planning",
		cwd,
		createdAt: timestamp,
		updatedAt: timestamp,
		featureRuns: {},
		milestoneStatus: {},
		validationReports: {},
		workers: {},
		actualCost: 0,
		actualTurns: 0,
		artifactsDir: paths.artifactsDir,
	};
}

export function resolveMissionPaths(cwd: string, missionId: string): MissionStorePaths {
	const rootDir = resolveMissionsRoot(cwd);
	const missionDir = path.join(rootDir, missionId);
	return {
		rootDir,
		missionDir,
		missionFile: path.join(missionDir, "mission.json"),
		eventsFile: path.join(missionDir, "events.jsonl"),
		planJsonFile: path.join(missionDir, "plan.json"),
		planMarkdownFile: path.join(missionDir, "plan.md"),
		artifactsDir: path.join(missionDir, "artifacts"),
		worktreesDir: path.join(missionDir, "worktrees"),
	};
}

export async function saveMission(record: MissionRecord): Promise<MissionStorePaths> {
	const paths = resolveMissionPaths(record.cwd, record.id);
	record.artifactsDir = paths.artifactsDir;
	await ensureMissionDirectories(paths);
	await withFileMutationQueue(paths.missionFile, async () => {
		await fs.promises.writeFile(paths.missionFile, `${JSON.stringify(record, null, 2)}\n`, "utf-8");
	});
	return paths;
}

export async function saveMissionPlan(record: MissionRecord, plan: MissionPlan): Promise<MissionRecord> {
	const next: MissionRecord = {
		...record,
		title: plan.title,
		plan,
		updatedAt: new Date().toISOString(),
	};
	const paths = resolveMissionPaths(record.cwd, record.id);
	await ensureMissionDirectories(paths);
	await Promise.all([
		withFileMutationQueue(paths.planJsonFile, async () => {
			await fs.promises.writeFile(paths.planJsonFile, `${JSON.stringify(plan, null, 2)}\n`, "utf-8");
		}),
		withFileMutationQueue(paths.planMarkdownFile, async () => {
			await fs.promises.writeFile(paths.planMarkdownFile, `${plan.markdown}\n`, "utf-8");
		}),
	]);
	await saveMission(next);
	return next;
}

export async function appendMissionEvent(record: MissionRecord, event: MissionEvent): Promise<void> {
	const paths = resolveMissionPaths(record.cwd, record.id);
	await ensureMissionDirectories(paths);
	await withFileMutationQueue(paths.eventsFile, async () => {
		await fs.promises.appendFile(paths.eventsFile, `${JSON.stringify(event)}\n`, "utf-8");
	});
}

export function loadMission(cwd: string, missionId: string): MissionRecord | undefined {
	const missionFile = resolveMissionPaths(cwd, missionId).missionFile;
	if (!fs.existsSync(missionFile)) {
		return undefined;
	}
	try {
		return JSON.parse(fs.readFileSync(missionFile, "utf-8")) as MissionRecord;
	} catch {
		return undefined;
	}
}

export function listMissions(cwd: string): MissionRecord[] {
	const rootDir = resolveMissionsRoot(cwd);
	if (!fs.existsSync(rootDir)) {
		return [];
	}
	const missions: MissionRecord[] = [];
	for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const mission = loadMission(cwd, entry.name);
		if (mission) {
			missions.push(mission);
		}
	}
	return missions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function writeMissionLink(sessionManager: SessionManager, mission: MissionRecord): MissionSessionLink {
	const link: MissionSessionLink = {
		missionId: mission.id,
		status: mission.status,
		goal: mission.goal,
		title: mission.title,
		updatedAt: mission.updatedAt,
	};
	sessionManager.appendCustomEntry(MISSION_SESSION_LINK_CUSTOM_TYPE, link);
	return link;
}

export function clearMissionLink(sessionManager: SessionManager): void {
	sessionManager.appendCustomEntry(MISSION_SESSION_LINK_CUSTOM_TYPE, {
		missionId: "",
		status: "aborted",
		goal: "",
		updatedAt: new Date().toISOString(),
	});
}

export function readMissionLink(sessionManager: ReadonlySessionManager): MissionSessionLink | undefined {
	const entries = sessionManager.getEntries();
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry.type !== "custom" || entry.customType !== MISSION_SESSION_LINK_CUSTOM_TYPE) {
			continue;
		}
		if (isClearedMissionLink(entry.data)) {
			return undefined;
		}
		if (isMissionLink(entry.data)) {
			return entry.data;
		}
	}
	return undefined;
}

export async function updateMissionStatus(
	record: MissionRecord,
	status: MissionStatus,
	pausedReason?: string,
): Promise<MissionRecord> {
	const next: MissionRecord = {
		...record,
		status,
		pausedReason,
		updatedAt: new Date().toISOString(),
	};
	await saveMission(next);
	return next;
}

export function resolveMissionsRoot(cwd: string): string {
	const root = findNearestProjectRoot(cwd) ?? cwd;
	return path.join(root, ".hirocode", "missions");
}

async function ensureMissionDirectories(paths: MissionStorePaths): Promise<void> {
	await Promise.all([
		fs.promises.mkdir(paths.rootDir, { recursive: true }),
		fs.promises.mkdir(paths.missionDir, { recursive: true }),
		fs.promises.mkdir(paths.artifactsDir, { recursive: true }),
		fs.promises.mkdir(paths.worktreesDir, { recursive: true }),
	]);
}

function findNearestProjectRoot(cwd: string): string | undefined {
	let current = path.resolve(cwd);
	while (true) {
		const marker = path.join(current, ".hirocode");
		if (fs.existsSync(marker) && fs.statSync(marker).isDirectory()) {
			return current;
		}
		const parent = path.dirname(current);
		if (parent === current) {
			return undefined;
		}
		current = parent;
	}
}

function isMissionLink(value: unknown): value is MissionSessionLink {
	if (!value || typeof value !== "object") return false;
	const link = value as Partial<MissionSessionLink>;
	return (
		typeof link.missionId === "string" &&
		link.missionId.length > 0 &&
		typeof link.status === "string" &&
		typeof link.goal === "string" &&
		typeof link.updatedAt === "string"
	);
}

function isClearedMissionLink(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const link = value as Partial<MissionSessionLink>;
	return typeof link.missionId === "string" && link.missionId.length === 0;
}
