import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	appendMissionEvent,
	clearMissionLink,
	createMissionRecord,
	listMissions,
	readMissionLink,
	resolveMissionPaths,
	saveMission,
	writeMissionLink,
} from "../src/core/missions/store.js";
import { SessionManager } from "../src/core/session-manager.js";

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length > 0) {
		fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
	}
});

describe("mission store", () => {
	it("persists mission records and events inside .hirocode/missions", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "hirocode-mission-store-"));
		tempDirs.push(root);
		fs.mkdirSync(path.join(root, ".hirocode"), { recursive: true });
		const mission = createMissionRecord("Build a full-stack todo app with auth", root);

		await saveMission(mission);
		await appendMissionEvent(mission, {
			type: "mission_created",
			missionId: mission.id,
			goal: mission.goal,
			createdAt: mission.createdAt,
		});

		const paths = resolveMissionPaths(root, mission.id);
		expect(fs.existsSync(paths.missionFile)).toBe(true);
		expect(fs.existsSync(paths.eventsFile)).toBe(true);
		expect(listMissions(root).map((item) => item.id)).toContain(mission.id);
	});

	it("writes and clears session links", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "hirocode-mission-link-"));
		tempDirs.push(root);
		fs.mkdirSync(path.join(root, ".hirocode"), { recursive: true });
		const sessionManager = SessionManager.create(root, path.join(root, "sessions"));
		const mission = createMissionRecord("Build a full-stack todo app with auth", root);

		writeMissionLink(sessionManager, mission);
		expect(readMissionLink(sessionManager)?.missionId).toBe(mission.id);

		clearMissionLink(sessionManager);
		expect(readMissionLink(sessionManager)).toBeUndefined();
	});
});
