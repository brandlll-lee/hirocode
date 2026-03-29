import { Container } from "@hirocode/tui";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { createSpecState } from "../src/core/spec/state.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { getResolvedThemeColors, initTheme, theme } from "../src/modes/interactive/theme/theme.js";

function renderLastLine(container: Container, width = 120): string {
	const last = container.children[container.children.length - 1];
	if (!last) return "";
	return last.render(width).join("\n");
}

function renderAll(container: Container, width = 120): string {
	return container.children.flatMap((child) => child.render(width)).join("\n");
}

const interactiveModePrototype = (InteractiveMode as any).prototype;

function createSpecPlan(title = "Specification Plan") {
	return {
		title,
		sections: [],
		summary: [],
		goals: [],
		constraints: [],
		acceptanceCriteria: [],
		technicalDetails: [],
		fileChanges: [],
		userJourney: [],
		errorScenarios: [],
		securityCompliance: [],
		scalePerformance: [],
		implementationPlan: [],
		verificationPlan: [],
		assumptions: [],
		markdown: `# ${title}`,
	};
}

function createAssistantMessage(stopReason: "stop" | "error" | "aborted" | "length") {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text: "assistant output" }],
		stopReason,
		timestamp: Date.now(),
	};
}

describe("InteractiveMode.showStatus", () => {
	beforeAll(() => {
		// showStatus uses the global theme instance
		initTheme("dark");
	});

	test("coalesces immediately-sequential status messages", () => {
		const fakeThis: any = {
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() },
			lastStatusSpacer: undefined,
			lastStatusText: undefined,
		};

		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_ONE");
		expect(fakeThis.chatContainer.children).toHaveLength(2);
		expect(renderLastLine(fakeThis.chatContainer)).toContain("STATUS_ONE");

		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_TWO");
		// second status updates the previous line instead of appending
		expect(fakeThis.chatContainer.children).toHaveLength(2);
		expect(renderLastLine(fakeThis.chatContainer)).toContain("STATUS_TWO");
		expect(renderLastLine(fakeThis.chatContainer)).not.toContain("STATUS_ONE");
	});

	test("appends a new status line if something else was added in between", () => {
		const fakeThis: any = {
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() },
			lastStatusSpacer: undefined,
			lastStatusText: undefined,
		};

		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_ONE");
		expect(fakeThis.chatContainer.children).toHaveLength(2);

		// Something else gets added to the chat in between status updates
		fakeThis.chatContainer.addChild({ render: () => ["OTHER"], invalidate: () => {} });
		expect(fakeThis.chatContainer.children).toHaveLength(3);

		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_TWO");
		// adds spacer + text
		expect(fakeThis.chatContainer.children).toHaveLength(5);
		expect(renderLastLine(fakeThis.chatContainer)).toContain("STATUS_TWO");
	});
});

describe("InteractiveMode.createExtensionUIContext setTheme", () => {
	test("persists theme changes to settings manager", () => {
		initTheme("dark");

		let currentTheme = "dark";
		const settingsManager = {
			getTheme: vi.fn(() => currentTheme),
			setTheme: vi.fn((theme: string) => {
				currentTheme = theme;
			}),
		};
		const fakeThis: any = {
			session: { settingsManager },
			settingsManager,
			ui: { requestRender: vi.fn() },
		};

		const uiContext = (InteractiveMode as any).prototype.createExtensionUIContext.call(fakeThis);
		const result = uiContext.setTheme("light");

		expect(result.success).toBe(true);
		expect(settingsManager.setTheme).toHaveBeenCalledWith("light");
		expect(currentTheme).toBe("light");
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(1);
	});

	test("does not persist invalid theme names", () => {
		initTheme("dark");

		const settingsManager = {
			getTheme: vi.fn(() => "dark"),
			setTheme: vi.fn(),
		};
		const fakeThis: any = {
			session: { settingsManager },
			settingsManager,
			ui: { requestRender: vi.fn() },
		};

		const uiContext = (InteractiveMode as any).prototype.createExtensionUIContext.call(fakeThis);
		const result = uiContext.setTheme("__missing_theme__");

		expect(result.success).toBe(false);
		expect(settingsManager.setTheme).not.toHaveBeenCalled();
		expect(fakeThis.ui.requestRender).not.toHaveBeenCalled();
	});
});

describe("InteractiveMode.showLoadedResources", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	function createShowLoadedResourcesThis(options: {
		quietStartup: boolean;
		verbose?: boolean;
		skills?: Array<{ filePath: string }>;
		skillDiagnostics?: Array<{ type: "warning" | "error" | "collision"; message: string }>;
	}) {
		const fakeThis: any = {
			options: { verbose: options.verbose ?? false },
			chatContainer: new Container(),
			settingsManager: {
				getQuietStartup: () => options.quietStartup,
			},
			session: {
				promptTemplates: [],
				extensionRunner: undefined,
				resourceLoader: {
					getPathMetadata: () => new Map(),
					getAgentsFiles: () => ({ agentsFiles: [] }),
					getSkills: () => ({
						skills: options.skills ?? [],
						diagnostics: options.skillDiagnostics ?? [],
					}),
					getPrompts: () => ({ prompts: [], diagnostics: [] }),
					getExtensions: () => ({ errors: [] }),
					getThemes: () => ({ themes: [], diagnostics: [] }),
				},
			},
			formatDisplayPath: (p: string) => p,
			buildScopeGroups: () => [],
			formatScopeGroups: () => "resource-list",
			getShortPath: (p: string) => p,
			formatDiagnostics: () => "diagnostics",
		};

		return fakeThis;
	}

	test("does not show verbose listing on quiet startup during reload", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: true,
			skills: [{ filePath: "/tmp/skill/SKILL.md" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			extensionPaths: ["/tmp/ext/index.ts"],
			force: false,
			showDiagnosticsWhenQuiet: true,
		});

		expect(fakeThis.chatContainer.children).toHaveLength(0);
	});

	test("still shows diagnostics on quiet startup when requested", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: true,
			skills: [{ filePath: "/tmp/skill/SKILL.md" }],
			skillDiagnostics: [{ type: "warning", message: "duplicate skill name" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
			showDiagnosticsWhenQuiet: true,
		});

		const output = renderAll(fakeThis.chatContainer);
		expect(output).toContain("[Skill conflicts]");
		expect(output).not.toContain("[Skills]");
	});
});

describe("InteractiveMode.maybeHandleSpecPlan", () => {
	test("approves a first-turn spec plan when the strict planning evidence is already complete", async () => {
		const sendCustomMessage = vi.fn(async () => undefined);
		const showSpecSelector = vi.fn(async () => undefined);
		const persistSpecState = vi.fn(function (this: any, state: any) {
			this.specState = state;
		});
		const fakeThis: any = {
			specState: createSpecState({
				phase: "planning",
				request: "Create a new React + Vite landing page",
				planningEvidence: {
					hasGrounding: true,
					hasAsk: true,
					hasAgentsGuidance: true,
					hasDependencyReview: true,
					askCount: 2,
					hasWebSearch: true,
					hasWebFetch: true,
					hasVersionResearch: true,
				},
			}),
			persistSpecState,
			session: { sendCustomMessage },
			getLastAssistantMessage: interactiveModePrototype.getLastAssistantMessage,
			getAssistantText: (message: any) =>
				message.content
					.filter((part: any) => part.type === "text")
					.map((part: any) => part.text)
					.join("\n"),
			showSpecSelector,
			clearStreamingSpecPlan: vi.fn(),
			showSpecPlanningBlockedFeedback: vi.fn(),
			showStatus: vi.fn(),
			formatSpecPlanningGateStatus: (missing: string[]) =>
				[
					"Specification plan blocked until the planning prerequisites are complete:",
					...missing.map((item) => `- ${item}`),
				].join("\n"),
		};

		await (InteractiveMode as any).prototype.maybeHandleSpecPlan.call(fakeThis, {
			type: "agent_end",
			messages: [
				{
					role: "assistant",
					content: [
						{
							type: "text",
							text: `<proposed_plan>
# First-Turn Approval
## Summary
- Approve a valid spec plan immediately when the agent already has enough context
## File Changes
- packages/coding-agent/src/modes/interactive/interactive-mode.ts
## Implementation Plan
1. Remove the runtime gate
## Verification Plan
1. Add a regression test
</proposed_plan>`,
						},
					],
					timestamp: Date.now(),
				},
			],
		});

		expect(fakeThis.specState.phase).toBe("approved");
		expect(fakeThis.specState.planningTurnCount).toBe(1);
		expect(fakeThis.specState.title).toBe("First-Turn Approval");
		expect(sendCustomMessage).toHaveBeenCalledWith(
			{
				customType: "spec-plan",
				content: `# First-Turn Approval
## Summary
- Approve a valid spec plan immediately when the agent already has enough context
## File Changes
- packages/coding-agent/src/modes/interactive/interactive-mode.ts
## Implementation Plan
1. Remove the runtime gate
## Verification Plan
1. Add a regression test`,
				display: true,
			},
			{ triggerTurn: false },
		);
		expect(showSpecSelector).toHaveBeenCalledTimes(1);
		expect(fakeThis.clearStreamingSpecPlan).not.toHaveBeenCalled();
		expect(fakeThis.showSpecPlanningBlockedFeedback).not.toHaveBeenCalled();
		expect(fakeThis.showStatus).not.toHaveBeenCalled();
	});

	test("automatically continues planning when only discoverable evidence is still missing", async () => {
		const sendCustomMessage = vi.fn(async () => undefined);
		const removeCustomMessages = vi.fn();
		const showSpecSelector = vi.fn(async () => undefined);
		const persistSpecState = vi.fn(function (this: any, state: any) {
			this.specState = state;
		});
		const fakeThis: any = {
			specState: createSpecState({
				phase: "planning",
				request: "Create a new React + Vite project from scratch",
				planningEvidence: {
					hasGrounding: true,
					hasAsk: true,
					hasAgentsGuidance: true,
					hasDependencyReview: true,
					askCount: 2,
					hasWebSearch: true,
					hasWebFetch: true,
					hasVersionResearch: false,
				},
			}),
			persistSpecState,
			session: { sendCustomMessage, removeCustomMessages },
			getLastAssistantMessage: interactiveModePrototype.getLastAssistantMessage,
			getAssistantText: (message: any) =>
				message.content
					.filter((part: any) => part.type === "text")
					.map((part: any) => part.text)
					.join("\n"),
			showSpecSelector,
			clearStreamingSpecPlan: vi.fn(),
			showSpecPlanningBlockedFeedback: vi.fn(),
			showStatus: vi.fn(),
			formatSpecPlanningGateStatus: (missing: string[]) => missing.join("\n"),
			triggerSpecPlanningAutoContinuationTurn: interactiveModePrototype.triggerSpecPlanningAutoContinuationTurn,
			specAutoContinuationActive: false,
		};

		await (InteractiveMode as any).prototype.maybeHandleSpecPlan.call(fakeThis, {
			type: "agent_end",
			messages: [
				{
					role: "assistant",
					content: [
						{
							type: "text",
							text: `<proposed_plan>
# Dependency-Sensitive Plan
## Summary
- Create the initial app with the latest stable stack
## File Changes
- package.json
## Implementation Plan
1. Scaffold the app
## Verification Plan
1. Add a regression test
</proposed_plan>`,
						},
					],
					timestamp: Date.now(),
				},
			],
		});

		expect(fakeThis.specState.phase).toBe("planning");
		expect(fakeThis.specState.planningTurnCount).toBe(1);
		expect(sendCustomMessage).toHaveBeenCalledTimes(2);
		expect(sendCustomMessage).toHaveBeenNthCalledWith(
			1,
			{
				customType: "spec-mode-context",
				content: expect.stringContaining("[SPECIFICATION MODE ACTIVE]"),
				display: false,
			},
			{ deliverAs: "nextTurn" },
		);
		expect(sendCustomMessage).toHaveBeenNthCalledWith(
			2,
			{
				customType: "spec-planning-continuation",
				content: expect.stringContaining("[SPEC PLANNING CONTINUATION]"),
				display: false,
			},
			{ triggerTurn: true },
		);
		expect(removeCustomMessages).toHaveBeenCalledWith([
			"spec-mode-context",
			"mission-mode-context",
			"spec-planning-continuation",
		]);
		expect(showSpecSelector).not.toHaveBeenCalled();
		expect(fakeThis.clearStreamingSpecPlan).toHaveBeenCalledTimes(1);
		expect(fakeThis.showSpecPlanningBlockedFeedback).not.toHaveBeenCalled();
		expect(fakeThis.showStatus).not.toHaveBeenCalled();
		expect(fakeThis.specAutoContinuationActive).toBe(true);
	});

	test("shows blocked feedback when a second automatic continuation would loop", async () => {
		const sendCustomMessage = vi.fn(async () => undefined);
		const showSpecSelector = vi.fn(async () => undefined);
		const persistSpecState = vi.fn(function (this: any, state: any) {
			this.specState = state;
		});
		const fakeThis: any = {
			specState: createSpecState({
				phase: "planning",
				request: "Create a new React + Vite project from scratch",
				planningEvidence: {
					hasGrounding: true,
					hasAsk: true,
					hasAgentsGuidance: true,
					hasDependencyReview: true,
					askCount: 2,
					hasWebSearch: true,
					hasWebFetch: true,
					hasVersionResearch: false,
				},
			}),
			persistSpecState,
			session: { sendCustomMessage, removeCustomMessages: vi.fn() },
			getLastAssistantMessage: interactiveModePrototype.getLastAssistantMessage,
			getAssistantText: (message: any) =>
				message.content
					.filter((part: any) => part.type === "text")
					.map((part: any) => part.text)
					.join("\n"),
			showSpecSelector,
			clearStreamingSpecPlan: vi.fn(),
			showSpecPlanningBlockedFeedback: vi.fn(),
			showStatus: vi.fn(),
			formatSpecPlanningGateStatus: (missing: string[]) => missing.join("\n"),
			triggerSpecPlanningAutoContinuationTurn: vi.fn(),
			specAutoContinuationActive: true,
		};

		await (InteractiveMode as any).prototype.maybeHandleSpecPlan.call(fakeThis, {
			type: "agent_end",
			messages: [
				{
					role: "assistant",
					content: [
						{
							type: "text",
							text: `<proposed_plan>
# Dependency-Sensitive Plan
## Summary
- Create the initial app with the latest stable stack
## File Changes
- package.json
## Implementation Plan
1. Scaffold the app
## Verification Plan
1. Add a regression test
</proposed_plan>`,
						},
					],
					timestamp: Date.now(),
				},
			],
		});

		expect(sendCustomMessage).not.toHaveBeenCalled();
		expect(showSpecSelector).not.toHaveBeenCalled();
		expect(fakeThis.clearStreamingSpecPlan).toHaveBeenCalledTimes(1);
		expect(fakeThis.showSpecPlanningBlockedFeedback).toHaveBeenCalledTimes(1);
		expect(fakeThis.showSpecPlanningBlockedFeedback.mock.calls[0][0]).toEqual([
			"research official current stable dependency or framework versions relevant to this task",
		]);
		expect(fakeThis.showStatus).toHaveBeenCalledTimes(1);
		expect(fakeThis.specAutoContinuationActive).toBe(false);
	});
});

describe("InteractiveMode spec execution completion", () => {
	test("clears spec mode after a successful executing turn", async () => {
		const restoreSessionAfterSpec = vi.fn(async () => undefined);
		const persistSpecState = vi.fn(function (this: any, state: any) {
			this.specState = state;
		});
		const applySpecStateToSession = vi.fn(async function (this: any, state: any) {
			this.specState = state;
		});
		const executingState = createSpecState({
			phase: "executing",
			maskEnabled: true,
			title: "Ship Phonix",
			plan: createSpecPlan("Ship Phonix"),
			artifactPath: "/tmp/phonix-spec.md",
			approvedAt: "2026-03-29T00:00:00.000Z",
		});
		const fakeThis: any = {
			specState: executingState,
			specAutoContinuationActive: false,
			session: { isRetrying: false },
			restoreSessionAfterSpec,
			persistSpecState,
			applySpecStateToSession,
			showStatus: vi.fn(),
			getLastAssistantMessage: interactiveModePrototype.getLastAssistantMessage,
			createInterruptedSpecState: interactiveModePrototype.createInterruptedSpecState,
			finalizeSpecExecutionState: interactiveModePrototype.finalizeSpecExecutionState,
		};

		await interactiveModePrototype.maybeHandleSpecExecutionCompletion.call(fakeThis, {
			type: "agent_end",
			messages: [createAssistantMessage("stop")],
		});

		expect(restoreSessionAfterSpec).toHaveBeenCalledWith(executingState);
		expect(fakeThis.specState.phase).toBe("inactive");
		expect(fakeThis.specState.plan?.title).toBe("Ship Phonix");
		expect(fakeThis.specState.maskEnabled).toBe(false);
		expect(fakeThis.showStatus).toHaveBeenCalledWith(
			"Specification execution completed. Specification mode cleared.",
		);
	});

	test("releases the mask but keeps the approved plan when execution stops incomplete", async () => {
		const restoreSessionAfterSpec = vi.fn(async () => undefined);
		const persistSpecState = vi.fn(function (this: any, state: any) {
			this.specState = state;
		});
		const applySpecStateToSession = vi.fn(async function (this: any, state: any) {
			this.specState = state;
		});
		const executingState = createSpecState({
			phase: "executing",
			maskEnabled: true,
			title: "Ship Phonix",
			plan: createSpecPlan("Ship Phonix"),
			artifactPath: "/tmp/phonix-spec.md",
			approvedAt: "2026-03-29T00:00:00.000Z",
		});
		const fakeThis: any = {
			specState: executingState,
			specAutoContinuationActive: false,
			session: { isRetrying: false },
			restoreSessionAfterSpec,
			persistSpecState,
			applySpecStateToSession,
			showStatus: vi.fn(),
			getLastAssistantMessage: interactiveModePrototype.getLastAssistantMessage,
			createInterruptedSpecState: interactiveModePrototype.createInterruptedSpecState,
			finalizeSpecExecutionState: interactiveModePrototype.finalizeSpecExecutionState,
		};

		await interactiveModePrototype.maybeHandleSpecExecutionCompletion.call(fakeThis, {
			type: "agent_end",
			messages: [createAssistantMessage("length")],
		});

		expect(restoreSessionAfterSpec).toHaveBeenCalledWith(executingState);
		expect(fakeThis.specState.phase).toBe("approved");
		expect(fakeThis.specState.plan?.title).toBe("Ship Phonix");
		expect(fakeThis.specState.maskEnabled).toBe(false);
		expect(fakeThis.showStatus).toHaveBeenCalledWith(
			"Specification execution stopped before completion. Approved plan kept for review.",
		);
	});

	test("keeps executing state in place while auto-retry is still in flight", async () => {
		const finalizeSpecExecutionState = vi.fn();
		const fakeThis: any = {
			specState: createSpecState({
				phase: "executing",
				maskEnabled: true,
				title: "Ship Phonix",
				plan: createSpecPlan("Ship Phonix"),
			}),
			session: { isRetrying: true },
			getLastAssistantMessage: interactiveModePrototype.getLastAssistantMessage,
			createInterruptedSpecState: interactiveModePrototype.createInterruptedSpecState,
			finalizeSpecExecutionState,
		};

		await interactiveModePrototype.maybeHandleSpecExecutionCompletion.call(fakeThis, {
			type: "agent_end",
			messages: [createAssistantMessage("error")],
		});

		expect(finalizeSpecExecutionState).not.toHaveBeenCalled();
		expect(fakeThis.specState.phase).toBe("executing");
	});

	test("drops back to approved when auto-retry ultimately fails", async () => {
		const restoreSessionAfterSpec = vi.fn(async () => undefined);
		const persistSpecState = vi.fn(function (this: any, state: any) {
			this.specState = state;
		});
		const applySpecStateToSession = vi.fn(async function (this: any, state: any) {
			this.specState = state;
		});
		const executingState = createSpecState({
			phase: "executing",
			maskEnabled: true,
			title: "Ship Phonix",
			plan: createSpecPlan("Ship Phonix"),
		});
		const fakeThis: any = {
			specState: executingState,
			specAutoContinuationActive: false,
			restoreSessionAfterSpec,
			persistSpecState,
			applySpecStateToSession,
			showStatus: vi.fn(),
			createInterruptedSpecState: interactiveModePrototype.createInterruptedSpecState,
			finalizeSpecExecutionState: interactiveModePrototype.finalizeSpecExecutionState,
		};

		await interactiveModePrototype.maybeHandleSpecRetryFailure.call(fakeThis, {
			type: "auto_retry_end",
			success: false,
			attempt: 2,
			finalError: "provider timeout",
		});

		expect(fakeThis.specState.phase).toBe("approved");
		expect(fakeThis.specState.maskEnabled).toBe(false);
		expect(fakeThis.showStatus).toHaveBeenCalledWith(
			"Specification execution stopped before completion. Approved plan kept for review.",
		);
	});
});

describe("InteractiveMode.reloadSpecStateFromSession", () => {
	test("normalizes a stale completed executing state back to inactive", async () => {
		const executingState = createSpecState({
			phase: "executing",
			maskEnabled: true,
			title: "Ship Phonix",
			plan: createSpecPlan("Ship Phonix"),
			artifactPath: "/tmp/phonix-spec.md",
		});
		const restoreSessionAfterSpec = vi.fn(async () => undefined);
		const persistSpecState = vi.fn(function (this: any, state: any) {
			this.specState = state;
		});
		const applySpecStateToSession = vi.fn(async function (this: any, state: any) {
			this.specState = state;
		});
		const fakeThis: any = {
			specState: undefined,
			session: { isStreaming: false },
			sessionManager: {
				getEntries: () => [
					{
						type: "custom",
						customType: "hirocode.spec.state",
						data: executingState,
					},
					{
						type: "message",
						message: createAssistantMessage("stop"),
					},
				],
			},
			restoreSessionAfterSpec,
			persistSpecState,
			applySpecStateToSession,
			getLastPersistedAssistantMessageAfterLatestSpecState:
				interactiveModePrototype.getLastPersistedAssistantMessageAfterLatestSpecState,
			createInterruptedSpecState: interactiveModePrototype.createInterruptedSpecState,
			finalizeSpecExecutionState: interactiveModePrototype.finalizeSpecExecutionState,
		};

		await interactiveModePrototype.reloadSpecStateFromSession.call(fakeThis);

		expect(restoreSessionAfterSpec).toHaveBeenCalledWith(executingState);
		expect(fakeThis.specState.phase).toBe("inactive");
		expect(fakeThis.specState.maskEnabled).toBe(false);
		expect(applySpecStateToSession).toHaveBeenCalledWith(fakeThis.specState);
	});

	test("normalizes a stale interrupted executing state back to approved without mask", async () => {
		const executingState = createSpecState({
			phase: "executing",
			maskEnabled: true,
			title: "Ship Phonix",
			plan: createSpecPlan("Ship Phonix"),
			artifactPath: "/tmp/phonix-spec.md",
		});
		const restoreSessionAfterSpec = vi.fn(async () => undefined);
		const persistSpecState = vi.fn(function (this: any, state: any) {
			this.specState = state;
		});
		const applySpecStateToSession = vi.fn(async function (this: any, state: any) {
			this.specState = state;
		});
		const fakeThis: any = {
			specState: undefined,
			session: { isStreaming: false },
			sessionManager: {
				getEntries: () => [
					{
						type: "custom",
						customType: "hirocode.spec.state",
						data: executingState,
					},
				],
			},
			restoreSessionAfterSpec,
			persistSpecState,
			applySpecStateToSession,
			getLastPersistedAssistantMessageAfterLatestSpecState:
				interactiveModePrototype.getLastPersistedAssistantMessageAfterLatestSpecState,
			createInterruptedSpecState: interactiveModePrototype.createInterruptedSpecState,
			finalizeSpecExecutionState: interactiveModePrototype.finalizeSpecExecutionState,
		};

		await interactiveModePrototype.reloadSpecStateFromSession.call(fakeThis);

		expect(restoreSessionAfterSpec).toHaveBeenCalledWith(executingState);
		expect(fakeThis.specState.phase).toBe("approved");
		expect(fakeThis.specState.maskEnabled).toBe(false);
		expect(fakeThis.specState.plan?.title).toBe("Ship Phonix");
		expect(applySpecStateToSession).toHaveBeenCalledWith(fakeThis.specState);
	});
});

describe("InteractiveMode.updateSpecWidget", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("renders a compact spec card and highlights /spec with the spec theme color", () => {
		const setExtensionWidget = vi.fn();
		const fakeThis = {
			specState: createSpecState({
				phase: "approved",
				request: "Review the current specification",
				plan: createSpecPlan(),
			}),
			missionState: undefined,
			isSpecMaskEnabled: () => true,
			setExtensionWidget,
			getSpecThemeColor: interactiveModePrototype.getSpecThemeColor,
			getSpecWidgetTitleLine: interactiveModePrototype.getSpecWidgetTitleLine,
		};

		interactiveModePrototype.updateSpecWidget.call(fakeThis);

		expect(setExtensionWidget).toHaveBeenCalledTimes(1);
		const [widgetId, lines, options] = setExtensionWidget.mock.calls[0] as [string, string[], { placement: string }];
		expect(widgetId).toBe("__spec_card__");
		expect(lines).toHaveLength(2);
		expect(lines.join("\n")).not.toContain("Phase: approved");
		expect(lines.join("\n")).not.toContain("Specification Specification Plan");
		expect(lines[0]).toBe(theme.fg("customMessageLabel", "Specification"));
		expect(lines[1]).toContain(theme.fg("customMessageLabel", "/spec"));
		expect(options).toEqual({ placement: "aboveEditor" });
	});
});

describe("InteractiveMode.updateModeBanner", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("prepends the working timer to the key hint row", () => {
		const fakeThis = {
			modeContainer: new Container(),
			missionState: undefined,
			getAutonomyModeDisplay: () => ({
				label: "Auto (Spec)",
				description: "planning stays read-only under spec rules",
			}),
			getSpecModeDisplay: () => "Spec (Approved)",
			getSpecThemeColor: interactiveModePrototype.getSpecThemeColor,
			hasMissionModeIndicator: () => false,
			getWorkingSessionTimerLabel: () => "\u23F1\uFE0F0s",
			capitalize: (value: string) => value.charAt(0).toUpperCase() + value.slice(1),
		};

		interactiveModePrototype.updateModeBanner.call(fakeThis);

		const lines = renderAll(fakeThis.modeContainer).split("\n");
		expect(lines[1]).toContain("\u23F1\uFE0F0s");
		expect(lines[1].indexOf("\u23F1\uFE0F0s")).toBeLessThan(lines[1].indexOf("toggle spec"));
		expect(lines[1]).toContain("cycle auto");
	});
});

describe("InteractiveMode.updateEditorBorderColor", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("uses the spec theme color while spec mode is active", () => {
		const fakeThis: any = {
			isBashMode: false,
			isSpecMaskEnabled: () => true,
			session: { thinkingLevel: "xhigh" },
			editor: { borderColor: undefined },
			ui: { requestRender: vi.fn() },
			getSpecThemeColor: interactiveModePrototype.getSpecThemeColor,
		};

		interactiveModePrototype.updateEditorBorderColor.call(fakeThis);

		expect(fakeThis.editor.borderColor("spec")).toBe(theme.fg("customMessageLabel", "spec"));
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(1);
	});

	test("keeps bash mode border color as the highest priority", () => {
		const fakeThis: any = {
			isBashMode: true,
			isSpecMaskEnabled: () => true,
			session: { thinkingLevel: "xhigh" },
			editor: { borderColor: undefined },
			ui: { requestRender: vi.fn() },
			getSpecThemeColor: interactiveModePrototype.getSpecThemeColor,
		};

		interactiveModePrototype.updateEditorBorderColor.call(fakeThis);

		expect(fakeThis.editor.borderColor("bash")).toBe(theme.getBashModeBorderColor()("bash"));
	});

	test("keeps thinking-level colors outside spec mode", () => {
		const fakeThis: any = {
			isBashMode: false,
			isSpecMaskEnabled: () => false,
			session: { thinkingLevel: "high" },
			editor: { borderColor: undefined },
			ui: { requestRender: vi.fn() },
			getSpecThemeColor: interactiveModePrototype.getSpecThemeColor,
		};

		interactiveModePrototype.updateEditorBorderColor.call(fakeThis);

		expect(fakeThis.editor.borderColor("think")).toBe(theme.getThinkingBorderColor("high")("think"));
	});
});

describe("InteractiveMode working session timer", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	test("accumulates elapsed time across agent turns and pauses while idle", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-03-28T00:00:00.000Z"));

		const updateModeBanner = vi.fn();
		const requestRender = vi.fn();
		const fakeThis = {
			workingElapsedMs: 0,
			workingStartedAt: undefined as number | undefined,
			workingTimerInterval: undefined as ReturnType<typeof setInterval> | undefined,
			ui: { requestRender },
			updateModeBanner,
			clearWorkingSessionTimerInterval: interactiveModePrototype.clearWorkingSessionTimerInterval,
			refreshWorkingSessionTimerDisplay: interactiveModePrototype.refreshWorkingSessionTimerDisplay,
			getWorkingSessionElapsedMs: interactiveModePrototype.getWorkingSessionElapsedMs,
			getWorkingSessionTimerLabel: interactiveModePrototype.getWorkingSessionTimerLabel,
		};

		expect(interactiveModePrototype.getWorkingSessionTimerLabel.call(fakeThis)).toBe("\u23F1\uFE0F0s");

		interactiveModePrototype.startWorkingSessionTimer.call(fakeThis);
		vi.advanceTimersByTime(65_000);
		expect(interactiveModePrototype.getWorkingSessionTimerLabel.call(fakeThis)).toBe("\u23F1\uFE0F1m 5s");

		interactiveModePrototype.stopWorkingSessionTimer.call(fakeThis);
		vi.advanceTimersByTime(15_000);
		expect(interactiveModePrototype.getWorkingSessionTimerLabel.call(fakeThis)).toBe("\u23F1\uFE0F1m 5s");

		interactiveModePrototype.startWorkingSessionTimer.call(fakeThis);
		vi.advanceTimersByTime(5_000);
		interactiveModePrototype.stopWorkingSessionTimer.call(fakeThis);
		expect(interactiveModePrototype.getWorkingSessionTimerLabel.call(fakeThis)).toBe("\u23F1\uFE0F1m 10s");

		fakeThis.workingElapsedMs = 6_287_000;
		fakeThis.workingStartedAt = undefined;
		expect(interactiveModePrototype.getWorkingSessionTimerLabel.call(fakeThis)).toBe("\u23F1\uFE0F1h 44m 47s");

		interactiveModePrototype.resetWorkingSessionTimer.call(fakeThis);
		expect(interactiveModePrototype.getWorkingSessionTimerLabel.call(fakeThis)).toBe("\u23F1\uFE0F0s");
		expect(updateModeBanner).toHaveBeenCalled();
		expect(requestRender).toHaveBeenCalled();
	});
});

describe("interactive theme accent colors", () => {
	test("uses the orange accent family while preserving spec purple", () => {
		const dark = getResolvedThemeColors("dark");
		expect(dark.accent).toBe("#d7875f");
		expect(dark.borderAccent).toBe("#d7875f");
		expect(dark.mdHeading).toBe("#d7875f");
		expect(dark.mdLink).toBe("#d7875f");
		expect(dark.mdCode).toBe("#d7875f");
		expect(dark.mdListBullet).toBe("#d7875f");
		expect(dark.customMessageLabel).toBe("#9575cd");

		const light = getResolvedThemeColors("light");
		expect(light.accent).toBe("#d7875f");
		expect(light.borderAccent).toBe("#d7875f");
		expect(light.mdHeading).toBe("#d7875f");
		expect(light.mdLink).toBe("#d7875f");
		expect(light.mdCode).toBe("#d7875f");
		expect(light.mdListBullet).toBe("#d7875f");
		expect(light.customMessageLabel).toBe("#7e57c2");
	});
});
describe("InteractiveMode.buildVisibleAssistantMessage", () => {
	test("does not render a streaming approval plan while spec planning is still in progress", () => {
		const fakeThis: any = {
			missionState: undefined,
			specState: createSpecState({ phase: "planning", request: "Plan the feature" }),
			updateStreamingSpecPlan: vi.fn(),
		};

		const message = {
			role: "assistant",
			content: [
				{
					type: "text",
					text: "Intro\n<proposed_plan>\n# Draft\n## Implementation Plan\n1. Something\n## Verification Plan\n1. Test it\n</proposed_plan>\nOutro",
				},
			],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5.4",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0,
				},
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		const visible = (InteractiveMode as any).prototype.buildVisibleAssistantMessage.call(fakeThis, message);
		expect(visible.content[0].text).toBe("Intro\n\nOutro");
		expect(fakeThis.updateStreamingSpecPlan).not.toHaveBeenCalled();
	});
});
