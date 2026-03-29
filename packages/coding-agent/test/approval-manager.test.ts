import { describe, expect, test } from "vitest";
import { ApprovalManager } from "../src/core/approval/manager.js";
import type { ApprovalSubject } from "../src/core/policy/types.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createSpecState, writeSpecState } from "../src/core/spec/state.js";

function createSubject(overrides: Partial<ApprovalSubject> = {}): ApprovalSubject {
	return {
		permission: "bash",
		pattern: "git status *",
		normalizedPattern: "git status *",
		level: "high",
		summary: "Approve bash command: git status *",
		justification: "Test approval subject",
		tags: ["read-only-command"],
		displayTarget: "git status *",
		...overrides,
	};
}

describe("ApprovalManager", () => {
	test("prefers the last matching rule across global and project settings", async () => {
		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.inMemory({
			approvalPolicy: "policy-driven",
			autonomyMode: "normal",
		});
		settingsManager.addPermissionRule("global", { permission: "bash", pattern: "git *", action: "allow" });
		settingsManager.addPermissionRule("project", { permission: "bash", pattern: "git status *", action: "deny" });

		const manager = new ApprovalManager({
			sessionManager,
			settingsManager,
			mode: "interactive",
		});
		const result = await manager.request(createSubject());

		expect(result.allowed).toBe(false);
		expect(result.matchedRule).toMatchObject({ source: "project", action: "deny", pattern: "git status *" });
	});

	test("stores session-scoped approvals and reuses them for later requests", async () => {
		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.inMemory({
			approvalPolicy: "always-ask",
			autonomyMode: "normal",
		});
		const manager = new ApprovalManager({
			sessionManager,
			settingsManager,
			mode: "interactive",
		});

		const pending = manager.request(createSubject());
		const request = manager.getPendingRequests()[0];
		expect(request?.subject.pattern).toBe("git status *");

		manager.resolve({
			requestId: request!.id,
			action: "allow",
			scope: "session",
			reason: "Remember for this session",
		});

		const first = await pending;
		expect(first.allowed).toBe(true);
		expect(first.scope).toBe("session");

		const second = await manager.request(createSubject());
		expect(second.allowed).toBe(true);
		expect(second.matchedRule).toMatchObject({ source: "session", action: "allow", pattern: "git status *" });
	});

	test("emits requested events only after the approval is pending", async () => {
		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.inMemory({
			approvalPolicy: "always-ask",
			autonomyMode: "normal",
		});
		const manager = new ApprovalManager({
			sessionManager,
			settingsManager,
			mode: "interactive",
		});
		let pendingCountDuringEvent = -1;

		manager.subscribe((event) => {
			if (event.type !== "requested") {
				return;
			}
			pendingCountDuringEvent = manager.getPendingRequests().length;
			manager.resolve({
				requestId: event.request.id,
				action: "deny",
				scope: "once",
				reason: "Rejected in test",
			});
		});

		const result = await manager.request(createSubject());

		expect(pendingCountDuringEvent).toBe(1);
		expect(result.allowed).toBe(false);
	});

	test("spec planning bypasses manual approval for read-only bash", async () => {
		const sessionManager = SessionManager.inMemory();
		writeSpecState(sessionManager, createSpecState({ phase: "planning", maskEnabled: true }));
		const settingsManager = SettingsManager.inMemory({
			approvalPolicy: "always-ask",
			autonomyMode: "normal",
		});
		const manager = new ApprovalManager({
			sessionManager,
			settingsManager,
			mode: "interactive",
		});

		const result = await manager.request(createSubject({ level: "low", tags: ["read-only-command"] }));

		expect(result.allowed).toBe(true);
		expect(manager.getPendingRequests()).toHaveLength(0);
		expect(result.reason).toContain("specification planning policy");
	});

	test("manual baseline asks for file mutations and command execution", async () => {
		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.inMemory({
			approvalPolicy: "always-ask",
			autonomyMode: "normal",
		});
		const manager = new ApprovalManager({
			sessionManager,
			settingsManager,
			mode: "interactive",
		});

		void manager.request(
			createSubject({
				permission: "edit",
				pattern: "src/app.ts",
				normalizedPattern: "src/app.ts",
				level: "medium",
				summary: "edit src/app.ts",
				tags: ["file-mutation"],
				displayTarget: "src/app.ts",
			}),
		);

		expect(manager.getPendingRequests()).toHaveLength(1);
	});

	test("auto-low allows file mutations and read-only bash only", async () => {
		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.inMemory({
			approvalPolicy: "policy-driven",
			autonomyMode: "auto-low",
		});
		const manager = new ApprovalManager({
			sessionManager,
			settingsManager,
			mode: "interactive",
		});

		const edit = await manager.request(
			createSubject({
				permission: "edit",
				pattern: "src/app.ts",
				normalizedPattern: "src/app.ts",
				level: "medium",
				summary: "edit src/app.ts",
				tags: ["file-mutation"],
				displayTarget: "src/app.ts",
			}),
		);
		expect(edit.allowed).toBe(true);

		const bash = await manager.request(createSubject({ level: "low", tags: ["read-only-command"] }));
		expect(bash.allowed).toBe(true);

		void manager.request(createSubject({ level: "medium", tags: ["reversible-command"], pattern: "npm install *" }));
		expect(manager.getPendingRequests()).toHaveLength(1);
	});

	test("auto-medium only auto-approves reversible commands", async () => {
		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.inMemory({
			approvalPolicy: "policy-driven",
			autonomyMode: "auto-medium",
		});
		const manager = new ApprovalManager({
			sessionManager,
			settingsManager,
			mode: "interactive",
		});

		const reversible = await manager.request(
			createSubject({
				pattern: "npm install *",
				normalizedPattern: "npm install *",
				level: "medium",
				tags: ["reversible-command"],
				displayTarget: "npm install *",
			}),
		);
		expect(reversible.allowed).toBe(true);

		void manager.request(
			createSubject({
				pattern: "docker compose up *",
				normalizedPattern: "docker compose up *",
				level: "high",
				tags: ["network"],
				displayTarget: "docker compose up *",
			}),
		);
		expect(manager.getPendingRequests()).toHaveLength(1);
	});

	test("auto-high still asks for explicit interlocks", async () => {
		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.inMemory({
			approvalPolicy: "policy-driven",
			autonomyMode: "auto-high",
		});
		const manager = new ApprovalManager({
			sessionManager,
			settingsManager,
			mode: "interactive",
		});

		void manager.request(
			createSubject({
				pattern: "bash *",
				normalizedPattern: "bash *",
				level: "high",
				tags: ["explicit-approval-required", "complex-shell"],
				displayTarget: "bash *",
			}),
		);
		expect(manager.getPendingRequests()).toHaveLength(1);
	});
});
