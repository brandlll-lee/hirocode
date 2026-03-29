/**
 * Interactive mode for the coding agent.
 * Handles TUI rendering and user interaction, delegating business logic to AgentSession.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@hirocode/agent-core";
import type { AssistantMessage, ImageContent, Message, Model, OAuthProviderId, TextContent } from "@hirocode/ai";
import type {
	AutocompleteItem,
	EditorComponent,
	EditorTheme,
	Keybinding,
	KeyId,
	MarkdownTheme,
	OverlayHandle,
	OverlayOptions,
	SlashCommand,
} from "@hirocode/tui";
import {
	CombinedAutocompleteProvider,
	type Component,
	Container,
	fuzzyFilter,
	Loader,
	Markdown,
	matchesKey,
	ProcessTerminal,
	Spacer,
	setKeybindings,
	Text,
	TruncatedText,
	TUI,
	visibleWidth,
} from "@hirocode/tui";
import { spawn, spawnSync } from "child_process";
import {
	APP_NAME,
	ENV_OFFLINE,
	ENV_OFFLINE_LEGACY,
	ENV_SKIP_VERSION_CHECK,
	ENV_SKIP_VERSION_CHECK_LEGACY,
	getAgentDir,
	getAuthPath,
	getDebugLogPath,
	getShareViewerUrl,
	getUpdateInstruction,
	PACKAGE_NAME,
	VERSION,
} from "../../config.js";
import { type AgentSession, type AgentSessionEvent, parseSkillBlock } from "../../core/agent-session.js";
import type { ApprovalManagerEvent } from "../../core/approval/manager.js";
import {
	createSessionSafetyServices,
	registerSessionSafetyServices,
	type SessionSafetyServices,
	unregisterSessionSafetyServices,
} from "../../core/approval/runtime-services.js";
import type { CompactionResult } from "../../core/compaction/index.js";
import type {
	ExtensionContext,
	ExtensionRunner,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
} from "../../core/extensions/index.js";
import { FooterDataProvider, type ReadonlyFooterDataProvider } from "../../core/footer-data-provider.js";
import { type AppKeybinding, KeybindingsManager } from "../../core/keybindings.js";
import { loadMcpConfig, removeUserMcpServer, setUserMcpServerDisabled } from "../../core/mcp/index.js";
import { createCompactionSummaryMessage } from "../../core/messages.js";
import { resolveMissionFeatureSessionNavigation } from "../../core/missions/feature-session-navigation.js";
import { MissionOrchestrator } from "../../core/missions/orchestrator.js";
import {
	buildMissionPlanningContext,
	extractMissionPlanDisplayState,
	looksLikeMissionPlanReadySignal,
	type MissionPlanningSkill,
	parseMissionPlan,
} from "../../core/missions/planner.js";
import { mergeMissionRuntimeSnapshot } from "../../core/missions/runtime-state.js";
import { buildMissionSchedule } from "../../core/missions/scheduler.js";
import {
	appendMissionEvent,
	clearMissionLink,
	createMissionRecord,
	listMissions,
	loadMission,
	readMissionLink,
	saveMission,
	saveMissionPlan,
	updateMissionStatus,
	writeMissionLink,
} from "../../core/missions/store.js";
import type { MissionFeatureRun, MissionRecord, MissionWorkerState } from "../../core/missions/types.js";
import { findExactModelReferenceMatch, resolveCliModel, resolveModelScope } from "../../core/model-resolver.js";
import { DefaultPackageManager } from "../../core/package-manager.js";
import {
	cycleInteractiveAutonomyPreset,
	deriveInteractiveAutonomyPreset,
	describeInteractiveAutonomyPreset,
	type InteractiveAutonomyPreset,
	resolveInteractiveAutonomyPreset,
	type StandardInteractiveAutonomyPreset,
} from "../../core/policy/interactive-autonomy.js";
import type { ApprovalDecision, ApprovalRequest } from "../../core/policy/types.js";
import type { ResourceDiagnostic } from "../../core/resource-loader.js";
import { type SessionContext, SessionManager } from "../../core/session-manager.js";
import { BUILTIN_SLASH_COMMANDS } from "../../core/slash-commands.js";
import { saveSpecArtifact } from "../../core/spec/artifact.js";
import {
	buildSpecExecutionContext,
	buildSpecPlanningBlockedMessage,
	buildSpecPlanningContext,
	buildSpecPlanningContinuationContext,
	collectSpecPlanningEvidence,
	evaluateSpecPlanningGate,
	extractProposedPlanDisplayState,
	mergeSpecPlanningEvidence,
	parseSpecPlan,
	shouldAutoContinueSpecPlanning,
} from "../../core/spec/plan.js";
import {
	createInactiveSpecState,
	createSpecState,
	getSpecStateEntry,
	readLatestSpecState,
	specHasPlan,
	writeSpecState,
} from "../../core/spec/state.js";
import { getSpecPlanningToolNames } from "../../core/spec/tool-policy.js";
import type { SpecSessionState } from "../../core/spec/types.js";
import { discoverAgents, getDefaultProjectAgentsDir, getUserAgentsDir } from "../../core/subagents/agent-registry.js";
import { agentExistsInDir, importClaudeAgents, scanClaudeAgents } from "../../core/subagents/claude-import.js";
import { resolveChildSessionOpenMode } from "../../core/subagents/session-navigation.js";
import { buildTaskNavigationContext } from "../../core/subagents/task-sessions.js";
import type { AgentConfig, DelegatedTaskApprovalRequest, LocatedTaskSession } from "../../core/subagents/types.js";
import { type AskAnswer, type AskQuestion, registerAskHandler, unregisterAskHandler } from "../../core/tools/ask.js";
import type { TruncationResult } from "../../core/tools/truncate.js";
import { getChangelogPath, getNewEntries, parseChangelog } from "../../utils/changelog.js";
import { copyToClipboard } from "../../utils/clipboard.js";
import { extensionForImageMimeType, readClipboardImage } from "../../utils/clipboard-image.js";
import { ensureTool } from "../../utils/tools-manager.js";
import { ArminComponent } from "./components/armin.js";
import { AskQuestionComponent } from "./components/ask-question.js";
import { AssistantMessageComponent } from "./components/assistant-message.js";
import { BashExecutionComponent } from "./components/bash-execution.js";
import { BorderedLoader } from "./components/bordered-loader.js";
import { BranchSummaryMessageComponent } from "./components/branch-summary-message.js";
import { getBuiltinMessageRenderer } from "./components/builtin-message-renderers.js";
import { CompactionSummaryMessageComponent } from "./components/compaction-summary-message.js";
import { CustomEditor } from "./components/custom-editor.js";
import { CustomMessageComponent } from "./components/custom-message.js";
import { DaxnutsComponent } from "./components/daxnuts.js";
import { DynamicBorder } from "./components/dynamic-border.js";
import { ExtensionEditorComponent } from "./components/extension-editor.js";
import { ExtensionInputComponent } from "./components/extension-input.js";
import { ExtensionSelectorComponent } from "./components/extension-selector.js";
import { FooterComponent } from "./components/footer.js";
import { keyHint, keyText, rawKeyHint } from "./components/keybinding-hints.js";
import { LoginDialogComponent } from "./components/login-dialog.js";
import { type MissionControlAction, MissionControlComponent } from "./components/mission-control.js";
import { MissionListComponent } from "./components/mission-list.js";
import { type MissionPlanOverviewChoice, MissionPlanOverviewComponent } from "./components/mission-plan-overview.js";
import { ModelSelectorComponent } from "./components/model-selector.js";
import { OAuthSelectorComponent } from "./components/oauth-selector.js";
import { ScopedModelsSelectorComponent } from "./components/scoped-models-selector.js";
import { SessionSelectorComponent } from "./components/session-selector.js";
import { SettingsSelectorComponent } from "./components/settings-selector.js";
import { SkillInvocationMessageComponent } from "./components/skill-invocation-message.js";
import { ToolExecutionComponent } from "./components/tool-execution.js";
import { TreeSelectorComponent } from "./components/tree-selector.js";
import { UserMessageComponent } from "./components/user-message.js";
import { UserMessageSelectorComponent } from "./components/user-message-selector.js";
import {
	getAvailableThemes,
	getAvailableThemesWithPaths,
	getEditorTheme,
	getMarkdownTheme,
	getThemeByName,
	initTheme,
	onThemeChange,
	setRegisteredThemes,
	setTheme,
	setThemeInstance,
	Theme,
	type ThemeColor,
	theme,
} from "./theme/theme.js";

/** Interface for components that can be expanded/collapsed */
interface Expandable {
	setExpanded(expanded: boolean): void;
}

function isExpandable(obj: unknown): obj is Expandable {
	return typeof obj === "object" && obj !== null && "setExpanded" in obj && typeof obj.setExpanded === "function";
}

type CompactionQueuedMessage = {
	text: string;
	mode: "steer" | "followUp";
};

/**
 * Options for InteractiveMode initialization.
 */
export interface InteractiveModeOptions {
	/** Providers that were migrated to auth.json (shows warning) */
	migratedProviders?: string[];
	/** Warning message if session model couldn't be restored */
	modelFallbackMessage?: string;
	/** Initial message to send on startup (can include @file content) */
	initialMessage?: string;
	/** Images to attach to the initial message */
	initialImages?: ImageContent[];
	/** Additional messages to send after the initial message */
	initialMessages?: string[];
	/** Force verbose startup (overrides quietStartup setting) */
	verbose?: boolean;
}

export class InteractiveMode {
	private session: AgentSession;
	private ui: TUI;
	private chatContainer: Container;
	private pendingMessagesContainer: Container;
	private statusContainer: Container;
	private modeContainer: Container;
	private defaultEditor: CustomEditor;
	private editor: EditorComponent;
	private autocompleteProvider: CombinedAutocompleteProvider | undefined;
	private fdPath: string | undefined;
	private editorContainer: Container;
	private footer: FooterComponent;
	private footerDataProvider: FooterDataProvider;
	// Stored so the same manager can be injected into custom editors, selectors, and extension UI.
	private keybindings: KeybindingsManager;
	private version: string;
	private isInitialized = false;
	private onInputCallback?: (text: string) => void;
	private loadingAnimation: Loader | undefined = undefined;
	private pendingWorkingMessage: string | undefined = undefined;
	private readonly defaultWorkingMessage = "Working...";
	private workingElapsedMs = 0;
	private workingStartedAt: number | undefined = undefined;
	private workingTimerInterval: ReturnType<typeof setInterval> | undefined = undefined;
	private specAutoContinuationActive = false;

	private lastSigintTime = 0;
	private lastEscapeTime = 0;
	private changelogMarkdown: string | undefined = undefined;

	// Status line tracking (for mutating immediately-sequential status updates)
	private lastStatusSpacer: Spacer | undefined = undefined;
	private lastStatusText: Text | undefined = undefined;

	// Streaming message tracking
	private streamingComponent: AssistantMessageComponent | undefined = undefined;
	private streamingMessage: AssistantMessage | undefined = undefined;
	private streamingSpecPlanComponent: CustomMessageComponent | undefined = undefined;

	// Tool execution tracking: toolCallId -> component
	private pendingTools = new Map<string, ToolExecutionComponent>();

	// Tool output expansion state
	private toolOutputExpanded = false;

	// Thinking block visibility state
	private hideThinkingBlock = false;

	// Skill commands: command name -> skill file path
	private skillCommands = new Map<string, string>();

	// Agent subscription unsubscribe function
	private unsubscribe?: () => void;

	// Track if editor is in bash mode (text starts with !)
	private isBashMode = false;

	// Track current bash execution component
	private bashComponent: BashExecutionComponent | undefined = undefined;

	// Track pending bash components (shown in pending area, moved to chat on submit)
	private pendingBashComponents: BashExecutionComponent[] = [];

	// Auto-compaction state
	private autoCompactionLoader: Loader | undefined = undefined;
	private autoCompactionEscapeHandler?: () => void;

	// Auto-retry state
	private retryLoader: Loader | undefined = undefined;
	private retryEscapeHandler?: () => void;

	// Messages queued while compaction is running
	private compactionQueuedMessages: CompactionQueuedMessage[] = [];

	// Shutdown state
	private shutdownRequested = false;

	// Extension UI state
	private extensionSelector: ExtensionSelectorComponent | undefined = undefined;
	private extensionInput: ExtensionInputComponent | undefined = undefined;
	private extensionEditor: ExtensionEditorComponent | undefined = undefined;
	private extensionTerminalInputUnsubscribers = new Set<() => void>();

	// Extension widgets (components rendered above/below the editor)
	private extensionWidgetsAbove = new Map<string, Component & { dispose?(): void }>();
	private extensionWidgetsBelow = new Map<string, Component & { dispose?(): void }>();
	private widgetContainerAbove!: Container;
	private widgetContainerBelow!: Container;

	// Custom footer from extension (undefined = use built-in footer)
	private customFooter: (Component & { dispose?(): void }) | undefined = undefined;

	// Header container that holds the built-in or custom header
	private headerContainer: Container;

	// Built-in header (logo + keybinding hints + changelog)
	private builtInHeader: Component | undefined = undefined;

	// Custom header from extension (undefined = use built-in header)
	private customHeader: (Component & { dispose?(): void }) | undefined = undefined;

	// Detached session view state (viewing a child session while the active session keeps running)
	private detachedSessionManager: SessionManager | undefined = undefined;
	private detachedSessionRefreshTimer: ReturnType<typeof setInterval> | undefined = undefined;
	private detachedSessionLastMtime = 0;
	private detachedActiveStreamingComponent: AssistantMessageComponent | undefined = undefined;
	private detachedActiveStreamingMessage: AssistantMessage | undefined = undefined;
	private detachedActiveToolComponents = new Map<string, ToolExecutionComponent>();
	private detachedActivePendingToolIds = new Set<string>();
	private safetyServices: SessionSafetyServices;
	private approvalFlowActive = false;
	private specState: SpecSessionState | undefined;
	private missionState: MissionRecord | undefined;
	private missionOrchestrator: MissionOrchestrator | undefined;
	private missionRuntimeUpdateChain: Promise<void> = Promise.resolve();

	// Convenience accessors
	private get agent() {
		return this.session.agent;
	}
	private get sessionManager() {
		return this.session.sessionManager;
	}
	private get settingsManager() {
		return this.session.settingsManager;
	}
	private get activeSessionManager() {
		return this.session.sessionManager;
	}

	private isViewingDetachedSession(): boolean {
		return this.detachedSessionManager !== undefined;
	}

	private getDisplaySessionManager(): SessionManager {
		return this.detachedSessionManager ?? this.sessionManager;
	}

	private stopDetachedSessionView(): void {
		if (this.detachedSessionRefreshTimer) {
			clearInterval(this.detachedSessionRefreshTimer);
			this.detachedSessionRefreshTimer = undefined;
		}
		this.detachedSessionManager = undefined;
		this.detachedSessionLastMtime = 0;
	}

	private clearDetachedActiveSessionState(): void {
		this.detachedActiveStreamingComponent = undefined;
		this.detachedActiveStreamingMessage = undefined;
		this.detachedActiveToolComponents.clear();
		this.detachedActivePendingToolIds.clear();
	}

	private captureDetachedActiveSessionState(): void {
		if (this.detachedActiveStreamingComponent || this.detachedActiveToolComponents.size > 0) {
			return;
		}

		this.detachedActiveStreamingComponent = this.streamingComponent;
		this.detachedActiveStreamingMessage = this.streamingMessage;

		for (const [toolCallId, component] of this.pendingTools) {
			this.detachedActiveToolComponents.set(toolCallId, component);
			this.detachedActivePendingToolIds.add(toolCallId);
		}

		this.streamingComponent = undefined;
		this.streamingMessage = undefined;
		this.pendingTools.clear();
	}

	private ensureDetachedStreamingComponent(message: AssistantMessage): AssistantMessageComponent {
		if (!this.detachedActiveStreamingComponent) {
			this.detachedActiveStreamingComponent = new AssistantMessageComponent(
				undefined,
				this.hideThinkingBlock,
				this.getMarkdownThemeWithSettings(),
			);
		}
		this.detachedActiveStreamingMessage = message;
		this.detachedActiveStreamingComponent.updateContent(message);
		return this.detachedActiveStreamingComponent;
	}

	private ensureDetachedToolComponent(
		toolCallId: string,
		toolName: string,
		args: Record<string, unknown>,
	): ToolExecutionComponent {
		let component = this.detachedActiveToolComponents.get(toolCallId);
		if (!component) {
			component = new ToolExecutionComponent(
				toolName,
				toolCallId,
				args,
				{ showImages: this.settingsManager.getShowImages() },
				this.getRegisteredToolDefinition(toolName),
				this.ui,
			);
			component.setExpanded(this.toolOutputExpanded);
			this.detachedActiveToolComponents.set(toolCallId, component);
		} else {
			component.updateArgs(args);
		}
		return component;
	}

	private captureDetachedActiveSessionEvent(event: AgentSessionEvent): void {
		if (event.type === "message_start" && event.message.role === "assistant") {
			this.clearDetachedActiveSessionState();
			this.ensureDetachedStreamingComponent(event.message);
			return;
		}

		if (event.type === "message_update" && event.message.role === "assistant") {
			this.ensureDetachedStreamingComponent(event.message);
			for (const content of event.message.content) {
				if (content.type === "toolCall") {
					this.ensureDetachedToolComponent(content.id, content.name, content.arguments);
				}
			}
			return;
		}

		if (event.type === "message_end" && event.message.role === "assistant") {
			if (this.detachedActiveStreamingComponent) {
				let errorMessage: string | undefined;
				if (event.message.stopReason === "aborted") {
					const retryAttempt = this.session.retryAttempt;
					errorMessage =
						retryAttempt > 0
							? `Aborted after ${retryAttempt} retry attempt${retryAttempt > 1 ? "s" : ""}`
							: "Operation aborted";
					event.message.errorMessage = errorMessage;
				}
				this.detachedActiveStreamingMessage = event.message;
				this.detachedActiveStreamingComponent.updateContent(event.message);

				if (event.message.stopReason === "aborted" || event.message.stopReason === "error") {
					if (!errorMessage) {
						errorMessage = event.message.errorMessage || "Error";
					}
					for (const toolCallId of this.detachedActivePendingToolIds) {
						this.detachedActiveToolComponents.get(toolCallId)?.updateResult({
							content: [{ type: "text", text: errorMessage }],
							isError: true,
						});
					}
					this.detachedActivePendingToolIds.clear();
				} else {
					for (const toolCallId of this.detachedActivePendingToolIds) {
						this.detachedActiveToolComponents.get(toolCallId)?.setArgsComplete();
					}
				}
			}

			this.detachedActiveStreamingComponent = undefined;
			this.detachedActiveStreamingMessage = undefined;
			return;
		}

		if (event.type === "tool_execution_start") {
			const component = this.ensureDetachedToolComponent(event.toolCallId, event.toolName, event.args);
			component.markExecutionStarted();
			this.detachedActivePendingToolIds.add(event.toolCallId);
			return;
		}

		if (event.type === "tool_execution_update") {
			const component = this.detachedActiveToolComponents.get(event.toolCallId);
			if (component) {
				component.updateResult({ ...event.partialResult, isError: false }, true);
			}
			return;
		}

		if (event.type === "tool_execution_end") {
			const component = this.detachedActiveToolComponents.get(event.toolCallId);
			if (component) {
				component.updateResult({ ...event.result, isError: event.isError });
				this.detachedActivePendingToolIds.delete(event.toolCallId);
			}
		}
	}

	private restoreDetachedActiveSessionState(): void {
		if (!this.detachedActiveStreamingComponent && this.detachedActiveToolComponents.size === 0) {
			this.clearDetachedActiveSessionState();
			return;
		}

		for (const child of [...this.chatContainer.children]) {
			if (!(child instanceof ToolExecutionComponent)) {
				continue;
			}
			if (this.detachedActiveToolComponents.has(child.getToolCallId())) {
				this.chatContainer.removeChild(child);
			}
		}

		if (this.detachedActiveStreamingComponent && this.detachedActiveStreamingMessage) {
			this.streamingComponent = this.detachedActiveStreamingComponent;
			this.streamingMessage = this.detachedActiveStreamingMessage;
			this.chatContainer.addChild(this.streamingComponent);
		}

		for (const [toolCallId, component] of this.detachedActiveToolComponents) {
			component.setExpanded(this.toolOutputExpanded);
			this.chatContainer.addChild(component);
			if (this.detachedActivePendingToolIds.has(toolCallId)) {
				this.pendingTools.set(toolCallId, component);
			}
		}

		this.clearDetachedActiveSessionState();
		this.ui.requestRender();
	}

	private openDetachedSessionView(sessionPath: string): void {
		if (!this.isViewingDetachedSession()) {
			this.captureDetachedActiveSessionState();
		}
		this.stopDetachedSessionView();
		this.detachedSessionManager = SessionManager.open(sessionPath, this.activeSessionManager.getSessionDir());
		try {
			this.detachedSessionLastMtime = fs.statSync(sessionPath).mtimeMs;
		} catch {
			this.detachedSessionLastMtime = 0;
		}
		this.detachedSessionRefreshTimer = setInterval(() => {
			if (!this.detachedSessionManager) {
				return;
			}
			try {
				const nextMtime = fs.statSync(sessionPath).mtimeMs;
				if (nextMtime !== this.detachedSessionLastMtime) {
					this.detachedSessionLastMtime = nextMtime;
					this.detachedSessionManager = SessionManager.open(
						sessionPath,
						this.activeSessionManager.getSessionDir(),
					);
					this.rebuildChatFromMessages();
				}
			} catch {
				// Ignore transient read failures while the child session is being written.
			}
		}, 400);
		this.chatContainer.clear();
		this.renderInitialMessages();
	}

	private renderDetachedSessionBanner(): void {
		if (!this.detachedSessionManager) {
			return;
		}

		const detachedFile = this.detachedSessionManager.getSessionFile();
		const activeFile = this.activeSessionManager.getSessionFile();
		const header = this.detachedSessionManager.getHeader();
		const title =
			this.detachedSessionManager.getSessionName() ?? detachedFile ?? this.detachedSessionManager.getSessionId();
		const stateText =
			activeFile && this.session.isStreaming
				? "Viewing detached child session while the active session keeps running."
				: "Viewing a detached session snapshot.";
		const lines = [
			theme.fg("warning", "[Detached session view]"),
			theme.fg("dim", title),
			theme.fg("muted", stateText),
			theme.fg("muted", `Parent: ${header?.parentSession ?? "(none)"}`),
			theme.fg("muted", `Use /subagents to return or switch, /resume to attach permanently.`),
		].join("\n");
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
		this.chatContainer.addChild(new Text(lines, 1, 0));
		this.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
		this.chatContainer.addChild(new Spacer(1));
	}

	constructor(
		session: AgentSession,
		private options: InteractiveModeOptions = {},
	) {
		this.session = session;
		this.version = VERSION;
		this.ui = new TUI(new ProcessTerminal(), this.settingsManager.getShowHardwareCursor());
		this.ui.setClearOnShrink(this.settingsManager.getClearOnShrink());
		this.headerContainer = new Container();
		this.chatContainer = new Container();
		this.pendingMessagesContainer = new Container();
		this.statusContainer = new Container();
		this.modeContainer = new Container();
		this.widgetContainerAbove = new Container();
		this.widgetContainerBelow = new Container();
		this.keybindings = KeybindingsManager.create();
		setKeybindings(this.keybindings);
		const editorPaddingX = this.settingsManager.getEditorPaddingX();
		const autocompleteMaxVisible = this.settingsManager.getAutocompleteMaxVisible();
		this.defaultEditor = new CustomEditor(this.ui, getEditorTheme(), this.keybindings, {
			paddingX: editorPaddingX,
			autocompleteMaxVisible,
		});
		this.editor = this.defaultEditor;
		this.editorContainer = new Container();
		this.editorContainer.addChild(this.editor as Component);
		this.footerDataProvider = new FooterDataProvider();
		this.footer = new FooterComponent(session, this.footerDataProvider);
		this.footer.setAutoCompactEnabled(session.autoCompactionEnabled);
		this.safetyServices = createSessionSafetyServices({
			sessionManager: this.sessionManager,
			settingsManager: this.settingsManager,
			approvalMode: "interactive",
		});
		registerSessionSafetyServices(this.sessionManager, this.safetyServices);
		this.safetyServices.approval.subscribe((event) => {
			void this.handleApprovalManagerEvent(event);
		});
		this.specState = readLatestSpecState(this.sessionManager);
		this.missionState = this.loadMissionStateFromSession();
		this.syncInteractiveAskAvailability();

		// Load hide thinking block setting
		this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();

		// Register themes from resource loader and initialize
		setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
		initTheme(this.settingsManager.getTheme(), true);
	}

	private setupAutocomplete(fdPath: string | undefined): void {
		// Define commands for autocomplete
		const slashCommands: SlashCommand[] = BUILTIN_SLASH_COMMANDS.map((command) => ({
			name: command.name,
			description: command.description,
		}));

		const modelCommand = slashCommands.find((command) => command.name === "model");
		if (modelCommand) {
			modelCommand.getArgumentCompletions = (prefix: string): AutocompleteItem[] | null => {
				// Get available models (scoped or from registry)
				const models =
					this.session.scopedModels.length > 0
						? this.session.scopedModels.map((s) => s.model)
						: this.session.modelRegistry.getAvailable();

				if (models.length === 0) return null;

				// Create items with provider/id format
				const items = models.map((m) => ({
					id: m.id,
					provider: m.provider,
					label: `${m.provider}/${m.id}`,
				}));

				// Fuzzy filter by model ID + provider (allows "opus anthropic" to match)
				const filtered = fuzzyFilter(items, prefix, (item) => `${item.id} ${item.provider}`);

				if (filtered.length === 0) return null;

				return filtered.map((item) => ({
					value: item.label,
					label: item.id,
					description: item.provider,
				}));
			};
		}

		// Convert prompt templates to SlashCommand format for autocomplete
		const templateCommands: SlashCommand[] = this.session.promptTemplates.map((cmd) => ({
			name: cmd.name,
			description: cmd.description,
		}));

		// Convert extension commands to SlashCommand format
		const builtinCommandNames = new Set(slashCommands.map((c) => c.name));
		const extensionCommands: SlashCommand[] = (
			this.session.extensionRunner?.getRegisteredCommands(builtinCommandNames) ?? []
		).map((cmd) => ({
			name: cmd.name,
			description: cmd.description ?? "(extension command)",
			getArgumentCompletions: cmd.getArgumentCompletions,
		}));

		// Build skill commands from session.skills (if enabled)
		this.skillCommands.clear();
		const skillCommandList: SlashCommand[] = [];
		if (this.settingsManager.getEnableSkillCommands()) {
			for (const skill of this.session.resourceLoader.getSkills().skills) {
				const prefixedName = `skill:${skill.name}`;
				this.skillCommands.set(prefixedName, skill.filePath);
				if (skill.userInvocable) {
					// user-invocable skills appear in the slash command menu under both /skill-name and /skill:name
					skillCommandList.push({ name: skill.name, description: skill.description });
					skillCommandList.push({ name: prefixedName, description: skill.description });
				}
				// user-invocable: false skills are hidden from the menu but the AI can still auto-invoke them
			}
		}

		// Setup autocomplete
		this.autocompleteProvider = new CombinedAutocompleteProvider(
			[...slashCommands, ...templateCommands, ...extensionCommands, ...skillCommandList],
			process.cwd(),
			fdPath,
		);
		this.defaultEditor.setAutocompleteProvider(this.autocompleteProvider);
		if (this.editor !== this.defaultEditor) {
			this.editor.setAutocompleteProvider?.(this.autocompleteProvider);
		}
	}

	async init(): Promise<void> {
		if (this.isInitialized) return;

		// Load changelog (only show new entries, skip for resumed sessions)
		this.changelogMarkdown = this.getChangelogForDisplay();

		// Ensure fd and rg are available (downloads if missing, adds to PATH via getBinDir)
		// Both are needed: fd for autocomplete, rg for grep tool and bash commands
		const [fdPath] = await Promise.all([ensureTool("fd"), ensureTool("rg")]);
		this.fdPath = fdPath;

		// Add header container as first child
		this.ui.addChild(this.headerContainer);

		// Add header with keybindings from config (unless silenced)
		if (this.options.verbose || !this.settingsManager.getQuietStartup()) {
			const logo = theme.bold(theme.fg("accent", APP_NAME)) + theme.fg("dim", ` v${this.version}`);

			// Build startup instructions using keybinding hint helpers
			const hint = (keybinding: AppKeybinding, description: string) => keyHint(keybinding, description);

			const instructions = [
				hint("app.interrupt", "to interrupt"),
				hint("app.clear", "to clear"),
				rawKeyHint(`${keyText("app.clear")} twice`, "to exit"),
				hint("app.exit", "to exit (empty)"),
				hint("app.suspend", "to suspend"),
				keyHint("tui.editor.deleteToLineEnd", "to delete to end"),
				hint("app.thinking.cycle", "to cycle thinking level"),
				rawKeyHint(`${keyText("app.model.cycleForward")}/${keyText("app.model.cycleBackward")}`, "to cycle models"),
				hint("app.model.select", "to select model"),
				hint("app.tools.expand", "to expand tools"),
				hint("app.thinking.toggle", "to expand thinking"),
				hint("app.editor.external", "for external editor"),
				rawKeyHint("/", "for commands"),
				rawKeyHint("!", "to run bash"),
				rawKeyHint("!!", "to run bash (no context)"),
				hint("app.message.followUp", "to queue follow-up"),
				hint("app.message.dequeue", "to edit all queued messages"),
				hint("app.clipboard.pasteImage", "to paste image"),
				rawKeyHint("drop files", "to attach"),
			].join("\n");
			this.builtInHeader = new Text(`${logo}\n${instructions}`, 1, 0);

			// Setup UI layout
			this.headerContainer.addChild(new Spacer(1));
			this.headerContainer.addChild(this.builtInHeader);
			this.headerContainer.addChild(new Spacer(1));

			// Add changelog if provided
			if (this.changelogMarkdown) {
				this.headerContainer.addChild(new DynamicBorder());
				if (this.settingsManager.getCollapseChangelog()) {
					const versionMatch = this.changelogMarkdown.match(/##\s+\[?(\d+\.\d+\.\d+)\]?/);
					const latestVersion = versionMatch ? versionMatch[1] : this.version;
					const condensedText = `Updated to v${latestVersion}. Use ${theme.bold("/changelog")} to view full changelog.`;
					this.headerContainer.addChild(new Text(condensedText, 1, 0));
				} else {
					this.headerContainer.addChild(new Text(theme.bold(theme.fg("accent", "What's New")), 1, 0));
					this.headerContainer.addChild(new Spacer(1));
					this.headerContainer.addChild(
						new Markdown(this.changelogMarkdown.trim(), 1, 0, this.getMarkdownThemeWithSettings()),
					);
					this.headerContainer.addChild(new Spacer(1));
				}
				this.headerContainer.addChild(new DynamicBorder());
			}
		} else {
			// Minimal header when silenced
			this.builtInHeader = new Text("", 0, 0);
			this.headerContainer.addChild(this.builtInHeader);
			if (this.changelogMarkdown) {
				// Still show changelog notification even in silent mode
				this.headerContainer.addChild(new Spacer(1));
				const versionMatch = this.changelogMarkdown.match(/##\s+\[?(\d+\.\d+\.\d+)\]?/);
				const latestVersion = versionMatch ? versionMatch[1] : this.version;
				const condensedText = `Updated to v${latestVersion}. Use ${theme.bold("/changelog")} to view full changelog.`;
				this.headerContainer.addChild(new Text(condensedText, 1, 0));
			}
		}

		this.ui.addChild(this.chatContainer);
		this.ui.addChild(this.pendingMessagesContainer);
		this.ui.addChild(this.statusContainer);
		this.renderWidgets(); // Initialize with default spacer
		this.ui.addChild(this.widgetContainerAbove);
		this.ui.addChild(this.modeContainer);
		this.ui.addChild(this.editorContainer);
		this.ui.addChild(this.widgetContainerBelow);
		this.ui.addChild(this.footer);
		this.ui.setFocus(this.editor);

		this.setupKeyHandlers();
		this.setupEditorSubmitHandler();
		this.updateModeBanner();

		// Start the UI before initializing extensions so session_start handlers can use interactive dialogs
		this.ui.start();
		this.isInitialized = true;

		// Initialize extensions first so resources are shown before messages
		await this.initExtensions();

		// Render initial messages AFTER showing loaded resources
		this.renderInitialMessages();

		// Set terminal title
		this.updateTerminalTitle();

		// Subscribe to agent events
		this.subscribeToAgent();

		// Set up theme file watcher
		onThemeChange(() => {
			this.ui.invalidate();
			this.updateEditorBorderColor();
			this.ui.requestRender();
		});

		// Set up git branch watcher (uses provider instead of footer)
		this.footerDataProvider.onBranchChange(() => {
			this.ui.requestRender();
		});

		// Initialize available provider count for footer display
		await this.updateAvailableProviderCount();
	}

	/**
	 * Update terminal title with session name and cwd.
	 */
	private updateTerminalTitle(): void {
		const cwdBasename = path.basename(process.cwd());
		const titleName = APP_NAME.charAt(0).toUpperCase() + APP_NAME.slice(1);
		const sessionName = this.sessionManager.getSessionName();
		if (sessionName) {
			this.ui.terminal.setTitle(`${titleName} - ${sessionName} - ${cwdBasename}`);
		} else {
			this.ui.terminal.setTitle(`${titleName} - ${cwdBasename}`);
		}
	}

	/**
	 * Run the interactive mode. This is the main entry point.
	 * Initializes the UI, shows warnings, processes initial messages, and starts the interactive loop.
	 */
	async run(): Promise<void> {
		await this.init();

		// Start version check asynchronously
		this.checkForNewVersion().then((newVersion) => {
			if (newVersion) {
				this.showNewVersionNotification(newVersion);
			}
		});

		// Start package update check asynchronously
		this.checkForPackageUpdates().then((updates) => {
			if (updates.length > 0) {
				this.showPackageUpdateNotification(updates);
			}
		});

		// Check tmux keyboard setup asynchronously
		this.checkTmuxKeyboardSetup().then((warning) => {
			if (warning) {
				this.showWarning(warning);
			}
		});

		// Show startup warnings
		const { migratedProviders, modelFallbackMessage, initialMessage, initialImages, initialMessages } = this.options;

		if (migratedProviders && migratedProviders.length > 0) {
			this.showWarning(`Migrated credentials to auth.json: ${migratedProviders.join(", ")}`);
		}

		const modelsJsonError = this.session.modelRegistry.getError();
		if (modelsJsonError) {
			this.showError(`models.json error: ${modelsJsonError}`);
		}

		if (modelFallbackMessage) {
			this.showWarning(modelFallbackMessage);
		}

		await this.reloadSpecStateFromSession();
		this.reloadMissionStateFromSession();

		// Process initial messages
		if (initialMessage) {
			try {
				await this.withSpecContextPrompt(initialMessage, { images: initialImages });
			} catch (error: unknown) {
				const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
				this.showError(errorMessage);
			}
		}

		if (initialMessages) {
			for (const message of initialMessages) {
				try {
					await this.withSpecContextPrompt(message);
				} catch (error: unknown) {
					const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
					this.showError(errorMessage);
				}
			}
		}

		// Main interactive loop
		while (true) {
			const userInput = await this.getUserInput();
			try {
				await this.withSpecContextPrompt(userInput);
			} catch (error: unknown) {
				const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
				this.showError(errorMessage);
			}
		}
	}

	/**
	 * Check npm registry for a newer version.
	 */
	private async checkForNewVersion(): Promise<string | undefined> {
		if (
			process.env[ENV_SKIP_VERSION_CHECK] ||
			process.env[ENV_SKIP_VERSION_CHECK_LEGACY] ||
			process.env[ENV_OFFLINE] ||
			process.env[ENV_OFFLINE_LEGACY]
		) {
			return undefined;
		}

		try {
			const response = await fetch(`https://registry.npmjs.org/${PACKAGE_NAME}/latest`, {
				signal: AbortSignal.timeout(10000),
			});
			if (!response.ok) return undefined;

			const data = (await response.json()) as { version?: string };
			const latestVersion = data.version;

			if (latestVersion && latestVersion !== this.version) {
				return latestVersion;
			}

			return undefined;
		} catch {
			return undefined;
		}
	}

	private async checkForPackageUpdates(): Promise<string[]> {
		if (process.env[ENV_OFFLINE] || process.env[ENV_OFFLINE_LEGACY]) {
			return [];
		}

		try {
			const packageManager = new DefaultPackageManager({
				cwd: process.cwd(),
				agentDir: getAgentDir(),
				settingsManager: this.settingsManager,
			});
			const updates = await packageManager.checkForAvailableUpdates();
			return updates.map((update) => update.displayName);
		} catch {
			return [];
		}
	}

	private async checkTmuxKeyboardSetup(): Promise<string | undefined> {
		if (!process.env.TMUX) return undefined;

		const runTmuxShow = (option: string): Promise<string | undefined> => {
			return new Promise((resolve) => {
				const proc = spawn("tmux", ["show", "-gv", option], {
					stdio: ["ignore", "pipe", "ignore"],
				});
				let stdout = "";
				const timer = setTimeout(() => {
					proc.kill();
					resolve(undefined);
				}, 2000);

				proc.stdout?.on("data", (data) => {
					stdout += data.toString();
				});
				proc.on("error", () => {
					clearTimeout(timer);
					resolve(undefined);
				});
				proc.on("close", (code) => {
					clearTimeout(timer);
					resolve(code === 0 ? stdout.trim() : undefined);
				});
			});
		};

		const [extendedKeys, extendedKeysFormat] = await Promise.all([
			runTmuxShow("extended-keys"),
			runTmuxShow("extended-keys-format"),
		]);

		// If we couldn't query tmux (timeout, sandbox, etc.), don't warn
		if (extendedKeys === undefined) return undefined;

		if (extendedKeys !== "on" && extendedKeys !== "always") {
			return "tmux extended-keys is off. Modified Enter keys may not work. Add `set -g extended-keys on` to ~/.tmux.conf and restart tmux.";
		}

		if (extendedKeysFormat === "xterm") {
			return "tmux extended-keys-format is xterm. Hirocode works best with csi-u. Add `set -g extended-keys-format csi-u` to ~/.tmux.conf and restart tmux.";
		}

		return undefined;
	}

	/**
	 * Get changelog entries to display on startup.
	 * Only shows new entries since last seen version, skips for resumed sessions.
	 */
	private getChangelogForDisplay(): string | undefined {
		// Skip changelog for resumed/continued sessions (already have messages)
		if (this.session.state.messages.length > 0) {
			return undefined;
		}

		const lastVersion = this.settingsManager.getLastChangelogVersion();
		const changelogPath = getChangelogPath();
		const entries = parseChangelog(changelogPath);

		if (!lastVersion) {
			// Fresh install - just record the version, don't show changelog
			this.settingsManager.setLastChangelogVersion(VERSION);
			return undefined;
		} else {
			const newEntries = getNewEntries(entries, lastVersion);
			if (newEntries.length > 0) {
				this.settingsManager.setLastChangelogVersion(VERSION);
				return newEntries.map((e) => e.content).join("\n\n");
			}
		}

		return undefined;
	}

	private getMarkdownThemeWithSettings(): MarkdownTheme {
		return {
			...getMarkdownTheme(),
			codeBlockIndent: this.settingsManager.getCodeBlockIndent(),
		};
	}

	// =========================================================================
	// Extension System
	// =========================================================================

	private formatDisplayPath(p: string): string {
		const home = os.homedir();
		let result = p;

		// Replace home directory with ~
		if (result.startsWith(home)) {
			result = `~${result.slice(home.length)}`;
		}

		return result;
	}

	/**
	 * Get a short path relative to the package root for display.
	 */
	private getShortPath(fullPath: string, source: string): string {
		// For npm packages, show path relative to node_modules/pkg/
		const npmMatch = fullPath.match(/node_modules\/(@?[^/]+(?:\/[^/]+)?)\/(.*)/);
		if (npmMatch && source.startsWith("npm:")) {
			return npmMatch[2];
		}

		// For git packages, show path relative to repo root
		const gitMatch = fullPath.match(/git\/[^/]+\/[^/]+\/(.*)/);
		if (gitMatch && source.startsWith("git:")) {
			return gitMatch[1];
		}

		// For local/auto, just use formatDisplayPath
		return this.formatDisplayPath(fullPath);
	}

	private getDisplaySourceInfo(
		source: string,
		scope: string,
	): { label: string; scopeLabel?: string; color: "accent" | "muted" } {
		if (source === "local") {
			if (scope === "user") {
				return { label: "user", color: "muted" };
			}
			if (scope === "project") {
				return { label: "project", color: "muted" };
			}
			if (scope === "temporary") {
				return { label: "path", scopeLabel: "temp", color: "muted" };
			}
			return { label: "path", color: "muted" };
		}

		if (source === "cli") {
			return { label: "path", scopeLabel: scope === "temporary" ? "temp" : undefined, color: "muted" };
		}

		const scopeLabel =
			scope === "user" ? "user" : scope === "project" ? "project" : scope === "temporary" ? "temp" : undefined;
		return { label: source, scopeLabel, color: "accent" };
	}

	private getScopeGroup(source: string, scope: string): "user" | "project" | "path" {
		if (source === "cli" || scope === "temporary") return "path";
		if (scope === "user") return "user";
		if (scope === "project") return "project";
		return "path";
	}

	private isPackageSource(source: string): boolean {
		return source.startsWith("npm:") || source.startsWith("git:");
	}

	private buildScopeGroups(
		paths: string[],
		metadata: Map<string, { source: string; scope: string; origin: string }>,
	): Array<{ scope: "user" | "project" | "path"; paths: string[]; packages: Map<string, string[]> }> {
		const groups: Record<
			"user" | "project" | "path",
			{ scope: "user" | "project" | "path"; paths: string[]; packages: Map<string, string[]> }
		> = {
			user: { scope: "user", paths: [], packages: new Map() },
			project: { scope: "project", paths: [], packages: new Map() },
			path: { scope: "path", paths: [], packages: new Map() },
		};

		for (const p of paths) {
			const meta = this.findMetadata(p, metadata);
			const source = meta?.source ?? "local";
			const scope = meta?.scope ?? "project";
			const groupKey = this.getScopeGroup(source, scope);
			const group = groups[groupKey];

			if (this.isPackageSource(source)) {
				const list = group.packages.get(source) ?? [];
				list.push(p);
				group.packages.set(source, list);
			} else {
				group.paths.push(p);
			}
		}

		return [groups.project, groups.user, groups.path].filter(
			(group) => group.paths.length > 0 || group.packages.size > 0,
		);
	}

	private formatScopeGroups(
		groups: Array<{ scope: "user" | "project" | "path"; paths: string[]; packages: Map<string, string[]> }>,
		options: {
			formatPath: (p: string) => string;
			formatPackagePath: (p: string, source: string) => string;
		},
	): string {
		const lines: string[] = [];

		for (const group of groups) {
			lines.push(`  ${theme.fg("accent", group.scope)}`);

			const sortedPaths = [...group.paths].sort((a, b) => a.localeCompare(b));
			for (const p of sortedPaths) {
				lines.push(theme.fg("dim", `    ${options.formatPath(p)}`));
			}

			const sortedPackages = Array.from(group.packages.entries()).sort(([a], [b]) => a.localeCompare(b));
			for (const [source, paths] of sortedPackages) {
				lines.push(`    ${theme.fg("mdLink", source)}`);
				const sortedPackagePaths = [...paths].sort((a, b) => a.localeCompare(b));
				for (const p of sortedPackagePaths) {
					lines.push(theme.fg("dim", `      ${options.formatPackagePath(p, source)}`));
				}
			}
		}

		return lines.join("\n");
	}

	/**
	 * Find metadata for a path, checking parent directories if exact match fails.
	 * Package manager stores metadata for directories, but we display file paths.
	 */
	private findMetadata(
		p: string,
		metadata: Map<string, { source: string; scope: string; origin: string }>,
	): { source: string; scope: string; origin: string } | undefined {
		// Try exact match first
		const exact = metadata.get(p);
		if (exact) return exact;

		// Try parent directories (package manager stores directory paths)
		let current = p;
		while (current.includes("/")) {
			current = current.substring(0, current.lastIndexOf("/"));
			const parent = metadata.get(current);
			if (parent) return parent;
		}

		return undefined;
	}

	/**
	 * Format a path with its source/scope info from metadata.
	 */
	private formatPathWithSource(
		p: string,
		metadata: Map<string, { source: string; scope: string; origin: string }>,
	): string {
		const meta = this.findMetadata(p, metadata);
		if (meta) {
			const shortPath = this.getShortPath(p, meta.source);
			const { label, scopeLabel } = this.getDisplaySourceInfo(meta.source, meta.scope);
			const labelText = scopeLabel ? `${label} (${scopeLabel})` : label;
			return `${labelText} ${shortPath}`;
		}
		return this.formatDisplayPath(p);
	}

	/**
	 * Format resource diagnostics with nice collision display using metadata.
	 */
	private formatDiagnostics(
		diagnostics: readonly ResourceDiagnostic[],
		metadata: Map<string, { source: string; scope: string; origin: string }>,
	): string {
		const lines: string[] = [];

		// Group collision diagnostics by name
		const collisions = new Map<string, ResourceDiagnostic[]>();
		const otherDiagnostics: ResourceDiagnostic[] = [];

		for (const d of diagnostics) {
			if (d.type === "collision" && d.collision) {
				const list = collisions.get(d.collision.name) ?? [];
				list.push(d);
				collisions.set(d.collision.name, list);
			} else {
				otherDiagnostics.push(d);
			}
		}

		// Format collision diagnostics grouped by name
		for (const [name, collisionList] of collisions) {
			const first = collisionList[0]?.collision;
			if (!first) continue;
			lines.push(theme.fg("warning", `  "${name}" collision:`));
			// Show winner
			lines.push(
				theme.fg("dim", `    ${theme.fg("success", "✓")} ${this.formatPathWithSource(first.winnerPath, metadata)}`),
			);
			// Show all losers
			for (const d of collisionList) {
				if (d.collision) {
					lines.push(
						theme.fg(
							"dim",
							`    ${theme.fg("warning", "✗")} ${this.formatPathWithSource(d.collision.loserPath, metadata)} (skipped)`,
						),
					);
				}
			}
		}

		// Format other diagnostics (skill name collisions, parse errors, etc.)
		for (const d of otherDiagnostics) {
			if (d.path) {
				// Use metadata-aware formatting for paths
				const sourceInfo = this.formatPathWithSource(d.path, metadata);
				lines.push(theme.fg(d.type === "error" ? "error" : "warning", `  ${sourceInfo}`));
				lines.push(theme.fg(d.type === "error" ? "error" : "warning", `    ${d.message}`));
			} else {
				lines.push(theme.fg(d.type === "error" ? "error" : "warning", `  ${d.message}`));
			}
		}

		return lines.join("\n");
	}

	private showLoadedResources(options?: {
		extensionPaths?: string[];
		force?: boolean;
		showDiagnosticsWhenQuiet?: boolean;
	}): void {
		const showListing = options?.force || this.options.verbose || !this.settingsManager.getQuietStartup();
		const showDiagnostics = showListing || options?.showDiagnosticsWhenQuiet === true;
		if (!showListing && !showDiagnostics) {
			return;
		}

		const metadata = this.session.resourceLoader.getPathMetadata();
		const sectionHeader = (name: string, color: ThemeColor = "mdHeading") => theme.fg(color, `[${name}]`);

		const skillsResult = this.session.resourceLoader.getSkills();
		const promptsResult = this.session.resourceLoader.getPrompts();
		const themesResult = this.session.resourceLoader.getThemes();

		if (showListing) {
			const contextFiles = this.session.resourceLoader.getAgentsFiles().agentsFiles;
			if (contextFiles.length > 0) {
				this.chatContainer.addChild(new Spacer(1));
				const contextList = contextFiles
					.map((f) => theme.fg("dim", `  ${this.formatDisplayPath(f.path)}`))
					.join("\n");
				this.chatContainer.addChild(new Text(`${sectionHeader("Context")}\n${contextList}`, 0, 0));
				this.chatContainer.addChild(new Spacer(1));
			}

			const skills = skillsResult.skills;
			if (skills.length > 0) {
				const skillPaths = skills.map((s) => s.filePath);
				const groups = this.buildScopeGroups(skillPaths, metadata);
				const skillList = this.formatScopeGroups(groups, {
					formatPath: (p) => this.formatDisplayPath(p),
					formatPackagePath: (p, source) => this.getShortPath(p, source),
				});
				this.chatContainer.addChild(new Text(`${sectionHeader("Skills")}\n${skillList}`, 0, 0));
				this.chatContainer.addChild(new Spacer(1));
			}

			const templates = this.session.promptTemplates;
			if (templates.length > 0) {
				const templatePaths = templates.map((t) => t.filePath);
				const groups = this.buildScopeGroups(templatePaths, metadata);
				const templateByPath = new Map(templates.map((t) => [t.filePath, t]));
				const templateList = this.formatScopeGroups(groups, {
					formatPath: (p) => {
						const template = templateByPath.get(p);
						return template ? `/${template.name}` : this.formatDisplayPath(p);
					},
					formatPackagePath: (p) => {
						const template = templateByPath.get(p);
						return template ? `/${template.name}` : this.formatDisplayPath(p);
					},
				});
				this.chatContainer.addChild(new Text(`${sectionHeader("Prompts")}\n${templateList}`, 0, 0));
				this.chatContainer.addChild(new Spacer(1));
			}

			const extensionPaths = options?.extensionPaths ?? [];
			if (extensionPaths.length > 0) {
				const groups = this.buildScopeGroups(extensionPaths, metadata);
				const extList = this.formatScopeGroups(groups, {
					formatPath: (p) => this.formatDisplayPath(p),
					formatPackagePath: (p, source) => this.getShortPath(p, source),
				});
				this.chatContainer.addChild(new Text(`${sectionHeader("Extensions", "mdHeading")}\n${extList}`, 0, 0));
				this.chatContainer.addChild(new Spacer(1));
			}

			// Show loaded themes (excluding built-in)
			const loadedThemes = themesResult.themes;
			const customThemes = loadedThemes.filter((t) => t.sourcePath);
			if (customThemes.length > 0) {
				const themePaths = customThemes.map((t) => t.sourcePath!);
				const groups = this.buildScopeGroups(themePaths, metadata);
				const themeList = this.formatScopeGroups(groups, {
					formatPath: (p) => this.formatDisplayPath(p),
					formatPackagePath: (p, source) => this.getShortPath(p, source),
				});
				this.chatContainer.addChild(new Text(`${sectionHeader("Themes")}\n${themeList}`, 0, 0));
				this.chatContainer.addChild(new Spacer(1));
			}
		}

		if (showDiagnostics) {
			const skillDiagnostics = skillsResult.diagnostics;
			if (skillDiagnostics.length > 0) {
				const warningLines = this.formatDiagnostics(skillDiagnostics, metadata);
				this.chatContainer.addChild(new Text(`${theme.fg("warning", "[Skill conflicts]")}\n${warningLines}`, 0, 0));
				this.chatContainer.addChild(new Spacer(1));
			}

			const promptDiagnostics = promptsResult.diagnostics;
			if (promptDiagnostics.length > 0) {
				const warningLines = this.formatDiagnostics(promptDiagnostics, metadata);
				this.chatContainer.addChild(
					new Text(`${theme.fg("warning", "[Prompt conflicts]")}\n${warningLines}`, 0, 0),
				);
				this.chatContainer.addChild(new Spacer(1));
			}

			const extensionDiagnostics: ResourceDiagnostic[] = [];
			const extensionErrors = this.session.resourceLoader.getExtensions().errors;
			if (extensionErrors.length > 0) {
				for (const error of extensionErrors) {
					extensionDiagnostics.push({ type: "error", message: error.error, path: error.path });
				}
			}

			const commandDiagnostics = this.session.extensionRunner?.getCommandDiagnostics() ?? [];
			extensionDiagnostics.push(...commandDiagnostics);

			const shortcutDiagnostics = this.session.extensionRunner?.getShortcutDiagnostics() ?? [];
			extensionDiagnostics.push(...shortcutDiagnostics);

			if (extensionDiagnostics.length > 0) {
				const warningLines = this.formatDiagnostics(extensionDiagnostics, metadata);
				this.chatContainer.addChild(
					new Text(`${theme.fg("warning", "[Extension issues]")}\n${warningLines}`, 0, 0),
				);
				this.chatContainer.addChild(new Spacer(1));
			}

			const themeDiagnostics = themesResult.diagnostics;
			if (themeDiagnostics.length > 0) {
				const warningLines = this.formatDiagnostics(themeDiagnostics, metadata);
				this.chatContainer.addChild(new Text(`${theme.fg("warning", "[Theme conflicts]")}\n${warningLines}`, 0, 0));
				this.chatContainer.addChild(new Spacer(1));
			}
		}
	}

	/**
	 * Initialize the extension system with TUI-based UI context.
	 */
	private async initExtensions(): Promise<void> {
		const uiContext = this.createExtensionUIContext();
		await this.session.bindExtensions({
			uiContext,
			commandContextActions: {
				waitForIdle: () => this.session.agent.waitForIdle(),
				newSession: async (options) => {
					this.specAutoContinuationActive = false;
					if (this.loadingAnimation) {
						this.loadingAnimation.stop();
						this.loadingAnimation = undefined;
					}
					this.statusContainer.clear();

					// Delegate to AgentSession (handles setup + agent state sync)
					const success = await this.session.newSession(options);
					if (!success) {
						return { cancelled: true };
					}
					this.resetWorkingSessionTimer();

					// Clear UI state
					this.chatContainer.clear();
					this.pendingMessagesContainer.clear();
					this.compactionQueuedMessages = [];
					this.streamingComponent = undefined;
					this.streamingMessage = undefined;
					this.pendingTools.clear();

					// Render any messages added via setup, or show empty session
					this.renderInitialMessages();
					this.ui.requestRender();

					return { cancelled: false };
				},
				fork: async (entryId) => {
					this.specAutoContinuationActive = false;
					const result = await this.session.fork(entryId);
					if (result.cancelled) {
						return { cancelled: true };
					}
					this.resetWorkingSessionTimer();

					this.chatContainer.clear();
					this.renderInitialMessages();
					this.editor.setText(result.selectedText);
					this.showStatus("Forked to new session");

					return { cancelled: false };
				},
				navigateTree: async (targetId, options) => {
					this.specAutoContinuationActive = false;
					const result = await this.session.navigateTree(targetId, {
						summarize: options?.summarize,
						customInstructions: options?.customInstructions,
						replaceInstructions: options?.replaceInstructions,
						label: options?.label,
					});
					if (result.cancelled) {
						return { cancelled: true };
					}
					this.resetWorkingSessionTimer();

					this.chatContainer.clear();
					this.renderInitialMessages();
					if (result.editorText && !this.editor.getText().trim()) {
						this.editor.setText(result.editorText);
					}
					this.showStatus("Navigated to selected point");

					return { cancelled: false };
				},
				switchSession: async (sessionPath) => {
					await this.handleResumeSession(sessionPath);
					return { cancelled: false };
				},
				reload: async () => {
					await this.handleReloadCommand();
				},
			},
			shutdownHandler: () => {
				this.shutdownRequested = true;
				if (!this.session.isStreaming) {
					void this.shutdown();
				}
			},
			onError: (error) => {
				this.showExtensionError(error.extensionPath, error.error, error.stack);
			},
		});

		setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
		this.setupAutocomplete(this.fdPath);

		const extensionRunner = this.session.extensionRunner;
		if (!extensionRunner) {
			this.showLoadedResources({ extensionPaths: [], force: false });
			return;
		}

		this.setupExtensionShortcuts(extensionRunner);
		this.showLoadedResources({ extensionPaths: extensionRunner.getExtensionPaths(), force: false });
	}

	/**
	 * Get a registered tool definition by name (for custom rendering).
	 */
	private getRegisteredToolDefinition(toolName: string) {
		return this.session.getToolDefinition(toolName);
	}

	/**
	 * Set up keyboard shortcuts registered by extensions.
	 */
	private setupExtensionShortcuts(extensionRunner: ExtensionRunner): void {
		const shortcuts = extensionRunner.getShortcuts(this.keybindings.getEffectiveConfig());
		if (shortcuts.size === 0) return;

		// Create a context for shortcut handlers
		const createContext = (): ExtensionContext => ({
			ui: this.createExtensionUIContext(),
			hasUI: true,
			cwd: process.cwd(),
			sessionManager: this.sessionManager,
			modelRegistry: this.session.modelRegistry,
			model: this.session.model,
			isIdle: () => !this.session.isStreaming,
			abort: () => this.session.abort(),
			hasPendingMessages: () => this.session.pendingMessageCount > 0,
			shutdown: () => {
				this.shutdownRequested = true;
			},
			getContextUsage: () => this.session.getContextUsage(),
			compact: (options) => {
				void (async () => {
					try {
						const result = await this.executeCompaction(options?.customInstructions, false);
						if (result) {
							options?.onComplete?.(result);
						}
					} catch (error) {
						const err = error instanceof Error ? error : new Error(String(error));
						options?.onError?.(err);
					}
				})();
			},
			getSystemPrompt: () => this.session.systemPrompt,
		});

		// Set up the extension shortcut handler on the default editor
		this.defaultEditor.onExtensionShortcut = (data: string) => {
			for (const [shortcutStr, shortcut] of shortcuts) {
				// Cast to KeyId - extension shortcuts use the same format
				if (matchesKey(data, shortcutStr as KeyId)) {
					// Run handler async, don't block input
					Promise.resolve(shortcut.handler(createContext())).catch((err) => {
						this.showError(`Shortcut handler error: ${err instanceof Error ? err.message : String(err)}`);
					});
					return true;
				}
			}
			return false;
		};
	}

	/**
	 * Set extension status text in the footer.
	 */
	private setExtensionStatus(key: string, text: string | undefined): void {
		this.footerDataProvider.setExtensionStatus(key, text);
		this.ui.requestRender();
	}

	/**
	 * Set an extension widget (string array or custom component).
	 */
	private setExtensionWidget(
		key: string,
		content: string[] | ((tui: TUI, thm: Theme) => Component & { dispose?(): void }) | undefined,
		options?: ExtensionWidgetOptions,
	): void {
		const placement = options?.placement ?? "aboveEditor";
		const removeExisting = (map: Map<string, Component & { dispose?(): void }>) => {
			const existing = map.get(key);
			if (existing?.dispose) existing.dispose();
			map.delete(key);
		};

		removeExisting(this.extensionWidgetsAbove);
		removeExisting(this.extensionWidgetsBelow);

		if (content === undefined) {
			this.renderWidgets();
			return;
		}

		let component: Component & { dispose?(): void };

		if (Array.isArray(content)) {
			// Wrap string array in a Container with Text components
			const container = new Container();
			for (const line of content.slice(0, InteractiveMode.MAX_WIDGET_LINES)) {
				container.addChild(new Text(line, 1, 0));
			}
			if (content.length > InteractiveMode.MAX_WIDGET_LINES) {
				container.addChild(new Text(theme.fg("muted", "... (widget truncated)"), 1, 0));
			}
			component = container;
		} else {
			// Factory function - create component
			component = content(this.ui, theme);
		}

		const targetMap = placement === "belowEditor" ? this.extensionWidgetsBelow : this.extensionWidgetsAbove;
		targetMap.set(key, component);
		this.renderWidgets();
	}

	private clearExtensionWidgets(): void {
		for (const widget of this.extensionWidgetsAbove.values()) {
			widget.dispose?.();
		}
		for (const widget of this.extensionWidgetsBelow.values()) {
			widget.dispose?.();
		}
		this.extensionWidgetsAbove.clear();
		this.extensionWidgetsBelow.clear();
		this.renderWidgets();
	}

	private resetExtensionUI(): void {
		if (this.extensionSelector) {
			this.hideExtensionSelector();
		}
		if (this.extensionInput) {
			this.hideExtensionInput();
		}
		if (this.extensionEditor) {
			this.hideExtensionEditor();
		}
		this.ui.hideOverlay();
		this.clearExtensionTerminalInputListeners();
		this.setExtensionFooter(undefined);
		this.setExtensionHeader(undefined);
		this.clearExtensionWidgets();
		this.footerDataProvider.clearExtensionStatuses();
		this.footer.invalidate();
		this.setCustomEditorComponent(undefined);
		this.defaultEditor.onExtensionShortcut = undefined;
		this.updateTerminalTitle();
		if (this.loadingAnimation) {
			this.loadingAnimation.setMessage(`${this.defaultWorkingMessage} (${keyText("app.interrupt")} to interrupt)`);
		}
	}

	// Maximum total widget lines to prevent viewport overflow
	private static readonly MAX_WIDGET_LINES = 10;

	/**
	 * Render all extension widgets to the widget container.
	 */
	private renderWidgets(): void {
		if (!this.widgetContainerAbove || !this.widgetContainerBelow) return;
		this.renderWidgetContainer(this.widgetContainerAbove, this.extensionWidgetsAbove, true, true);
		this.renderWidgetContainer(this.widgetContainerBelow, this.extensionWidgetsBelow, false, false);
		this.ui.requestRender();
	}

	private renderWidgetContainer(
		container: Container,
		widgets: Map<string, Component & { dispose?(): void }>,
		spacerWhenEmpty: boolean,
		leadingSpacer: boolean,
	): void {
		container.clear();

		if (widgets.size === 0) {
			if (spacerWhenEmpty) {
				container.addChild(new Spacer(1));
			}
			return;
		}

		if (leadingSpacer) {
			container.addChild(new Spacer(1));
		}
		for (const component of widgets.values()) {
			container.addChild(component);
		}
	}

	/**
	 * Set a custom footer component, or restore the built-in footer.
	 */
	private setExtensionFooter(
		factory:
			| ((tui: TUI, thm: Theme, footerData: ReadonlyFooterDataProvider) => Component & { dispose?(): void })
			| undefined,
	): void {
		// Dispose existing custom footer
		if (this.customFooter?.dispose) {
			this.customFooter.dispose();
		}

		// Remove current footer from UI
		if (this.customFooter) {
			this.ui.removeChild(this.customFooter);
		} else {
			this.ui.removeChild(this.footer);
		}

		if (factory) {
			// Create and add custom footer, passing the data provider
			this.customFooter = factory(this.ui, theme, this.footerDataProvider);
			this.ui.addChild(this.customFooter);
		} else {
			// Restore built-in footer
			this.customFooter = undefined;
			this.ui.addChild(this.footer);
		}

		this.ui.requestRender();
	}

	/**
	 * Set a custom header component, or restore the built-in header.
	 */
	private setExtensionHeader(factory: ((tui: TUI, thm: Theme) => Component & { dispose?(): void }) | undefined): void {
		// Header may not be initialized yet if called during early initialization
		if (!this.builtInHeader) {
			return;
		}

		// Dispose existing custom header
		if (this.customHeader?.dispose) {
			this.customHeader.dispose();
		}

		// Find the index of the current header in the header container
		const currentHeader = this.customHeader || this.builtInHeader;
		const index = this.headerContainer.children.indexOf(currentHeader);

		if (factory) {
			// Create and add custom header
			this.customHeader = factory(this.ui, theme);
			if (index !== -1) {
				this.headerContainer.children[index] = this.customHeader;
			} else {
				// If not found (e.g. builtInHeader was never added), add at the top
				this.headerContainer.children.unshift(this.customHeader);
			}
		} else {
			// Restore built-in header
			this.customHeader = undefined;
			if (index !== -1) {
				this.headerContainer.children[index] = this.builtInHeader;
			}
		}

		this.ui.requestRender();
	}

	private addExtensionTerminalInputListener(
		handler: (data: string) => { consume?: boolean; data?: string } | undefined,
	): () => void {
		const unsubscribe = this.ui.addInputListener(handler);
		this.extensionTerminalInputUnsubscribers.add(unsubscribe);
		return () => {
			unsubscribe();
			this.extensionTerminalInputUnsubscribers.delete(unsubscribe);
		};
	}

	private clearExtensionTerminalInputListeners(): void {
		for (const unsubscribe of this.extensionTerminalInputUnsubscribers) {
			unsubscribe();
		}
		this.extensionTerminalInputUnsubscribers.clear();
	}

	/**
	 * Create the ExtensionUIContext for extensions.
	 */
	private createExtensionUIContext(): ExtensionUIContext {
		return {
			select: (title, options, opts) => this.showExtensionSelector(title, options, opts),
			confirm: (title, message, opts) => this.showExtensionConfirm(title, message, opts),
			input: (title, placeholder, opts) => this.showExtensionInput(title, placeholder, opts),
			notify: (message, type) => this.showExtensionNotify(message, type),
			onTerminalInput: (handler) => this.addExtensionTerminalInputListener(handler),
			setStatus: (key, text) => this.setExtensionStatus(key, text),
			setWorkingMessage: (message) => {
				if (this.loadingAnimation) {
					if (message) {
						this.loadingAnimation.setMessage(message);
					} else {
						this.loadingAnimation.setMessage(
							`${this.defaultWorkingMessage} (${keyText("app.interrupt")} to interrupt)`,
						);
					}
				} else {
					// Queue message for when loadingAnimation is created (handles agent_start race)
					this.pendingWorkingMessage = message;
				}
			},
			setWidget: (key, content, options) => this.setExtensionWidget(key, content, options),
			setFooter: (factory) => this.setExtensionFooter(factory),
			setHeader: (factory) => this.setExtensionHeader(factory),
			setTitle: (title) => this.ui.terminal.setTitle(title),
			custom: (factory, options) => this.showExtensionCustom(factory, options),
			pasteToEditor: (text) => this.editor.handleInput(`\x1b[200~${text}\x1b[201~`),
			setEditorText: (text) => this.editor.setText(text),
			getEditorText: () => this.editor.getExpandedText?.() ?? this.editor.getText(),
			editor: (title, prefill) => this.showExtensionEditor(title, prefill),
			setEditorComponent: (factory) => this.setCustomEditorComponent(factory),
			get theme() {
				return theme;
			},
			getAllThemes: () => getAvailableThemesWithPaths(),
			getTheme: (name) => getThemeByName(name),
			setTheme: (themeOrName) => {
				if (themeOrName instanceof Theme) {
					setThemeInstance(themeOrName);
					this.ui.requestRender();
					return { success: true };
				}
				const result = setTheme(themeOrName, true);
				if (result.success) {
					if (this.settingsManager.getTheme() !== themeOrName) {
						this.settingsManager.setTheme(themeOrName);
					}
					this.ui.requestRender();
				}
				return result;
			},
			getToolsExpanded: () => this.toolOutputExpanded,
			setToolsExpanded: (expanded) => this.setToolsExpanded(expanded),
		};
	}

	/**
	 * Show a selector for extensions.
	 */
	private showExtensionSelector(
		title: string,
		options: string[],
		opts?: ExtensionUIDialogOptions,
		highlightColor: ThemeColor = "accent",
	): Promise<string | undefined> {
		return new Promise((resolve) => {
			if (opts?.signal?.aborted) {
				resolve(undefined);
				return;
			}

			const onAbort = () => {
				this.hideExtensionSelector();
				resolve(undefined);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			this.extensionSelector = new ExtensionSelectorComponent(
				title,
				options,
				(option) => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionSelector();
					resolve(option);
				},
				() => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionSelector();
					resolve(undefined);
				},
				{ tui: this.ui, timeout: opts?.timeout, highlightColor },
			);

			this.editorContainer.clear();
			this.editorContainer.addChild(this.extensionSelector);
			this.ui.setFocus(this.extensionSelector);
			this.ui.requestRender();
		});
	}

	/**
	 * Hide the extension selector.
	 */
	private hideExtensionSelector(): void {
		this.extensionSelector?.dispose();
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.extensionSelector = undefined;
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	/**
	 * Show a confirmation dialog for extensions.
	 */
	private async showExtensionConfirm(
		title: string,
		message: string,
		opts?: ExtensionUIDialogOptions,
	): Promise<boolean> {
		const result = await this.showExtensionSelector(`${title}\n${message}`, ["Yes", "No"], opts);
		return result === "Yes";
	}

	private async handleApprovalManagerEvent(event: ApprovalManagerEvent): Promise<void> {
		if (event.type === "requested") {
			this.showStatus(`Approval required: ${event.request.subject.displayTarget}`);
			if (!this.approvalFlowActive) {
				await this.openApprovalCenter(event.request.id);
			}
			return;
		}

		const prefix = event.result.allowed ? "Approved" : "Rejected";
		this.showStatus(`${prefix}: ${event.request.subject.displayTarget}`);
	}

	private async handleApprovalsCommand(): Promise<void> {
		const pending = this.safetyServices.approval.getPendingRequests();
		if (pending.length === 0) {
			this.showStatus("No pending approvals");
			return;
		}
		await this.openApprovalCenter();
	}

	private async handleMcpCommand(): Promise<void> {
		const mcpManager = this.session.mcpManager;
		const infos = mcpManager.getServerInfos();

		if (infos.length === 0) {
			this.showStatus("No MCP servers configured. Use `hirocode mcp add` to add servers.");
			return;
		}

		const items = infos.map((info) => {
			let icon: string;
			if (info.status.status === "connected") icon = "✓";
			else if (info.status.status === "disabled") icon = "○";
			else if (info.status.status === "needs_auth") icon = "⚠";
			else icon = "✗";
			const toolCount = info.tools.length;
			const statusText =
				info.status.status === "failed" ? `failed: ${(info.status as any).error}` : info.status.status;
			return `${icon} ${info.name} (${statusText}${toolCount > 0 ? `, ${toolCount} tools` : ""})`;
		});

		const result = await this.showExtensionSelector("MCP Servers", items);
		if (result === undefined) return;

		const idx = items.indexOf(result);
		if (idx < 0 || idx >= infos.length) return;

		const info = infos[idx];
		await this.handleMcpServerAction(info);
	}

	private async handleMcpServerAction(
		info: ReturnType<typeof this.session.mcpManager.getServerInfos>[number],
	): Promise<void> {
		const mcpManager = this.session.mcpManager;
		const isDisabled = info.config.disabled ?? false;
		const isHttp = info.config.type === "http";
		const needsAuth = info.status.status === "needs_auth";

		const { user: userConfig } = loadMcpConfig();
		const isUserServer = info.name in userConfig.mcpServers;

		const actions: string[] = [];
		actions.push(isDisabled ? "Enable" : "Disable");
		if (info.tools.length > 0) actions.push("View tools");
		if (isHttp && needsAuth) actions.push("Authenticate");
		if (isHttp) actions.push("Clear auth");
		if (isUserServer) actions.push("Remove");

		const action = await this.showExtensionSelector(`${info.name} — actions`, actions);
		if (action === undefined) return;

		if (action === "Enable" || action === "Disable") {
			this.showStatus(`${action === "Enable" ? "Enabling" : "Disabling"} ${info.name}...`);
			setUserMcpServerDisabled(info.name, action === "Disable");
			await mcpManager.reload(true);
			(this.session as any)._refreshToolRegistry();
			this.showStatus(`MCP server "${info.name}" ${action === "Enable" ? "enabled" : "disabled"}.`);
		} else if (action === "View tools") {
			const toolItems = info.tools.map((t) => `${t.name}${t.description ? ` — ${t.description}` : ""}`);
			if (toolItems.length === 0) {
				this.showStatus("No tools available.");
				return;
			}
			await this.showExtensionSelector(`${info.name} — ${toolItems.length} tools`, toolItems);
		} else if (action === "Authenticate") {
			this.showStatus(`Authenticating ${info.name}... Check your browser.`);
			try {
				const status = await mcpManager.authenticate(info.name);
				if (status.status === "connected") {
					(this.session as any)._refreshToolRegistry();
					this.showStatus(`MCP server "${info.name}" authenticated and connected.`);
				} else {
					this.showStatus(`Authentication result: ${status.status}`);
				}
			} catch (error) {
				this.showStatus(`Auth failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		} else if (action === "Clear auth") {
			await mcpManager.removeAuth(info.name);
			this.showStatus(`Cleared OAuth credentials for "${info.name}".`);
		} else if (action === "Remove") {
			const removed = removeUserMcpServer(info.name);
			if (removed) {
				await mcpManager.reload(true);
				(this.session as any)._refreshToolRegistry();
				this.showStatus(`Removed MCP server "${info.name}".`);
			} else {
				this.showStatus(`Cannot remove "${info.name}" — not in user config.`);
			}
		}
	}

	private async openApprovalCenter(preferredRequestId?: string): Promise<void> {
		if (this.approvalFlowActive) {
			return;
		}

		this.approvalFlowActive = true;
		try {
			let preferredId = preferredRequestId;
			while (true) {
				const pending = this.safetyServices.approval.getPendingRequests();
				if (pending.length === 0) {
					return;
				}

				let request = preferredId ? pending.find((item) => item.id === preferredId) : undefined;
				preferredId = undefined;

				if (!request) {
					if (pending.length === 1) {
						request = pending[0];
					} else {
						const labels = pending.map((item) => this.formatApprovalQueueLabel(item));
						const selected = await this.showExtensionSelector(
							"Approval Queue\nSelect a pending approval request to review.",
							labels,
						);
						if (!selected) {
							this.showStatus(
								`${pending.length} approval request${pending.length > 1 ? "s" : ""} still pending`,
							);
							return;
						}
						request = pending.find((item) => this.formatApprovalQueueLabel(item) === selected);
					}
				}

				if (!request) {
					return;
				}

				const decision = await this.showApprovalDecision(request, pending.length);
				if (!decision) {
					this.showStatus(`${pending.length} approval request${pending.length > 1 ? "s" : ""} still pending`);
					return;
				}

				this.safetyServices.approval.resolve(decision);
			}
		} finally {
			this.approvalFlowActive = false;
		}
	}

	private formatApprovalQueueLabel(request: ApprovalRequest): string {
		return `[${request.subject.level}] ${request.subject.permission} ${request.subject.displayTarget}`;
	}

	private async showApprovalDecision(
		request: ApprovalRequest,
		pendingCount: number,
	): Promise<ApprovalDecision | undefined> {
		const options = ["Allow once", "Allow for session", "Allow for project", "Allow globally", "Reject"];
		const selected = await this.showExtensionSelector(this.formatApprovalPrompt(request, pendingCount), options);
		if (!selected) {
			return undefined;
		}
		if (selected === "Reject") {
			return {
				requestId: request.id,
				action: "deny",
				scope: "once",
				reason: `Rejected in interactive approval queue for ${request.subject.displayTarget}`,
			};
		}
		const scope =
			selected === "Allow for session"
				? "session"
				: selected === "Allow for project"
					? "project"
					: selected === "Allow globally"
						? "global"
						: "once";
		return {
			requestId: request.id,
			action: "allow",
			scope,
			reason: `Approved in interactive approval queue for ${request.subject.displayTarget}`,
		};
	}

	private formatApprovalPrompt(request: ApprovalRequest, pendingCount: number): string {
		const lines = [
			`Approval Request ${pendingCount > 1 ? `(queue size ${pendingCount})` : ""}`,
			"",
			`Summary: ${request.subject.summary}`,
			`Permission: ${request.subject.permission}`,
			`Target: ${request.subject.displayTarget}`,
			`Risk: ${request.subject.level}`,
			`Why: ${request.subject.justification}`,
		];
		const command =
			typeof request.subject.metadata?.command === "string" ? request.subject.metadata.command : undefined;
		if (command) {
			lines.push("", `Command: ${command}`);
		}
		const directories = Array.isArray(request.subject.metadata?.externalDirectories)
			? request.subject.metadata.externalDirectories
			: [];
		if (directories.length > 0) {
			lines.push("", `External dirs: ${directories.join(", ")}`);
		}
		return lines.join("\n");
	}

	private loadMissionStateFromSession(): MissionRecord | undefined {
		const link = readMissionLink(this.sessionManager);
		if (!link) {
			return undefined;
		}
		return loadMission(this.sessionManager.getCwd(), link.missionId);
	}

	private async persistMissionState(mission: MissionRecord): Promise<void> {
		await saveMission(mission);
		writeMissionLink(this.sessionManager, mission);
		this.missionState = mission;
		this.syncInteractiveAskAvailability();
		this.updateMissionWidget();
		this.updateModeBanner();
	}

	private enqueueMissionRuntimeUpdate(mission: MissionRecord): void {
		this.missionRuntimeUpdateChain = this.missionRuntimeUpdateChain
			.then(async () => {
				if (!this.missionState && !this.missionOrchestrator) {
					return;
				}
				if (this.missionState && this.missionState.id !== mission.id) {
					return;
				}
				const merged = mergeMissionRuntimeSnapshot(this.missionState, mission);
				await this.persistMissionState(merged);
			})
			.catch((error: unknown) => {
				this.showError(error instanceof Error ? error.message : String(error));
			});
	}

	private reloadMissionStateFromSession(): void {
		this.missionState = this.loadMissionStateFromSession();
		this.syncInteractiveAskAvailability();
		this.updateMissionWidget();
		this.updateModeBanner();
	}

	private getAvailableSkillsForMission(): MissionPlanningSkill[] {
		return this.session.resourceLoader
			.getSkills()
			.skills.map((skill) => ({ name: skill.name, description: skill.description }));
	}

	private updateMissionWidget(): void {
		if (!this.missionState) {
			this.setExtensionWidget("__mission_control__", undefined);
			this.updateModeBanner();
			return;
		}
		this.setExtensionWidget("__mission_control__", this.formatMissionControlLines(this.missionState), {
			placement: "aboveEditor",
		});
		this.updateModeBanner();
	}

	private formatMissionControlLines(mission: MissionRecord): string[] {
		const lines = [
			`${theme.fg("accent", "Mission Control")} ${theme.fg("muted", mission.title)}`,
			`${theme.fg("muted", "Status:")} ${mission.status}${mission.currentMilestoneId ? `  ${theme.fg("muted", "Milestone:")} ${mission.currentMilestoneId}` : ""}`,
		];
		if (mission.status === "planning" && mission.plan) {
			lines.push(
				theme.fg(
					"muted",
					`Plan: ${mission.plan.features.length} features / ${mission.plan.milestones.length} milestones`,
				),
			);
		}
		const featureRuns = mission.plan?.features.map((feature) => {
			const run = mission.featureRuns[feature.id];
			const state = run?.status ?? "pending";
			const symbol =
				state === "completed"
					? theme.fg("success", "[ok]")
					: state === "running"
						? theme.fg("accent", "[..]")
						: state === "failed" || state === "blocked"
							? theme.fg("error", "[x]")
							: theme.fg("muted", "[ ]");
			return `${symbol} ${feature.title}`;
		});
		if (featureRuns && featureRuns.length > 0) {
			lines.push(...featureRuns.slice(0, 8));
			if (featureRuns.length > 8) {
				lines.push(theme.fg("muted", `... ${featureRuns.length - 8} more features`));
			}
		}
		const runningWorkers = Object.values(mission.workers).filter((worker) => worker.status === "running");
		if (runningWorkers.length > 0) {
			lines.push(theme.fg("muted", `Active workers: ${runningWorkers.length}`));
			for (const worker of runningWorkers.slice(0, 3)) {
				lines.push(
					theme.fg(
						"dim",
						`  ${worker.featureId}${worker.lastTool ? ` -> ${worker.lastTool}` : ""}${worker.branch ? ` (${worker.branch})` : ""}`,
					),
				);
			}
		}
		const pendingApprovals = this.safetyServices.approval.getPendingRequests().length;
		if (pendingApprovals > 0) {
			lines.push(theme.fg("warning", `Pending approvals: ${pendingApprovals}`));
		}
		const currentValidation = mission.currentMilestoneId
			? mission.validationReports[mission.currentMilestoneId]
			: undefined;
		if (currentValidation) {
			lines.push(
				currentValidation.status === "passed"
					? theme.fg("success", `Validation passed: ${mission.currentMilestoneId}`)
					: theme.fg("error", `Validation failed: ${mission.currentMilestoneId}`),
			);
		}
		if (mission.pausedReason) {
			lines.push(theme.fg("warning", mission.pausedReason));
		}
		lines.push(theme.fg("muted", "Use /mission for control actions"));
		return lines;
	}

	private buildMissionExecutionContext(mission: MissionRecord): string {
		const lines = [
			`[MISSION CONTROL ACTIVE]`,
			`Mission: ${mission.title}`,
			`Status: ${mission.status}`,
			mission.currentMilestoneId ? `Current milestone: ${mission.currentMilestoneId}` : undefined,
			mission.plan ? mission.plan.markdown : undefined,
		]
			.filter((line): line is string => Boolean(line))
			.join("\n\n");
		return lines;
	}

	private createMissionOrchestrator(): MissionOrchestrator {
		return new MissionOrchestrator(this.sessionManager, {
			onMissionUpdate: (mission, event) => {
				this.enqueueMissionRuntimeUpdate({ ...mission });
				if (event.type === "mission_paused") {
					this.showWarning(event.reason ?? "Mission paused");
				}
				if (event.type === "milestone_validated") {
					this.showStatus(`Milestone ${event.milestoneId} ${event.status}`);
				}
			},
			onDelegatedApproval: (request) => this.handleMissionDelegatedApproval(request),
		});
	}

	private isSpecMaskEnabled(state: SpecSessionState | undefined = this.specState): boolean {
		return Boolean(state && state.phase !== "inactive" && state.maskEnabled !== false);
	}

	private hasMissionModeIndicator(): boolean {
		return Boolean(this.missionState && ["planning", "running", "paused"].includes(this.missionState.status));
	}

	private getSpecThemeColor(): ThemeColor {
		return "customMessageLabel";
	}

	private clearWorkingSessionTimerInterval(): void {
		if (this.workingTimerInterval) {
			clearInterval(this.workingTimerInterval);
			this.workingTimerInterval = undefined;
		}
	}

	private refreshWorkingSessionTimerDisplay(): void {
		this.updateModeBanner();
		this.ui.requestRender();
	}

	private getWorkingSessionElapsedMs(): number {
		if (this.workingStartedAt === undefined) {
			return this.workingElapsedMs;
		}
		return this.workingElapsedMs + (Date.now() - this.workingStartedAt);
	}

	private getWorkingSessionTimerLabel(): string {
		const totalSeconds = Math.floor(this.getWorkingSessionElapsedMs() / 1000);
		if (totalSeconds < 60) {
			return `\u23F1\uFE0F${totalSeconds}s`;
		}
		if (totalSeconds < 3600) {
			const minutes = Math.floor(totalSeconds / 60);
			const seconds = totalSeconds % 60;
			return `\u23F1\uFE0F${minutes}m ${seconds}s`;
		}
		const hours = Math.floor(totalSeconds / 3600);
		const remainingSeconds = totalSeconds % 3600;
		const minutes = Math.floor(remainingSeconds / 60);
		const seconds = remainingSeconds % 60;
		return `\u23F1\uFE0F${hours}h ${minutes}m ${seconds}s`;
	}

	private startWorkingSessionTimer(): void {
		if (this.workingStartedAt !== undefined) {
			return;
		}

		this.workingStartedAt = Date.now();
		this.clearWorkingSessionTimerInterval();
		this.workingTimerInterval = setInterval(() => {
			if (this.workingStartedAt === undefined) {
				return;
			}
			this.refreshWorkingSessionTimerDisplay();
		}, 1000);
		this.refreshWorkingSessionTimerDisplay();
	}

	private stopWorkingSessionTimer(): void {
		if (this.workingStartedAt !== undefined) {
			this.workingElapsedMs += Date.now() - this.workingStartedAt;
			this.workingStartedAt = undefined;
		}
		this.clearWorkingSessionTimerInterval();
		this.refreshWorkingSessionTimerDisplay();
	}

	private resetWorkingSessionTimer(refresh = true): void {
		this.workingElapsedMs = 0;
		this.workingStartedAt = undefined;
		this.clearWorkingSessionTimerInterval();
		if (refresh) {
			this.refreshWorkingSessionTimerDisplay();
		}
	}

	private getSpecWidgetTitleLine(): string {
		if (!specHasPlan(this.specState)) {
			return theme.fg(this.getSpecThemeColor(), "Specification");
		}

		const title = this.specState.plan.title.trim();
		if (!title || title === "Specification Plan") {
			return theme.fg(this.getSpecThemeColor(), "Specification");
		}

		return `${theme.fg(this.getSpecThemeColor(), "Specification")} ${theme.fg("muted", title)}`;
	}

	private createInteractiveAskHandler() {
		return (questions: AskQuestion[]) =>
			this.showExtensionCustom<AskAnswer[]>(
				(_tui, _theme, _keybindings, done) =>
					new AskQuestionComponent({
						questions,
						onSubmit: (answers) => done(answers),
						onCancel: () => done(questions.map((q) => q.options[0]?.label ?? "")),
					}),
			);
	}

	private shouldEnableInteractiveAsk(): boolean {
		const missionPlanning = this.missionState?.status === "planning";
		const specPlanning = this.specState?.phase === "planning" && this.isSpecMaskEnabled();
		return Boolean(missionPlanning || specPlanning);
	}

	private syncInteractiveAskAvailability(): void {
		const currentTools = this.session.getActiveToolNames();
		if (this.shouldEnableInteractiveAsk()) {
			registerAskHandler(this.sessionManager, this.createInteractiveAskHandler());
			if (!currentTools.includes("ask")) {
				this.session.setActiveToolsByName([...currentTools, "ask"]);
			}
			return;
		}

		unregisterAskHandler(this.sessionManager);
		if (currentTools.includes("ask")) {
			this.session.setActiveToolsByName(currentTools.filter((name) => name !== "ask"));
		}
	}

	private getInteractiveAutonomyPreset(): InteractiveAutonomyPreset {
		return deriveInteractiveAutonomyPreset(
			this.settingsManager.getApprovalPolicy(),
			this.settingsManager.getAutonomyMode(),
		);
	}

	private setRuntimeInteractiveAutonomyPreset(preset: StandardInteractiveAutonomyPreset): void {
		this.settingsManager.applyOverrides(resolveInteractiveAutonomyPreset(preset));
		this.updateModeBanner();
	}

	private setPersistentInteractiveAutonomyPreset(
		preset: StandardInteractiveAutonomyPreset,
	): ReturnType<typeof resolveInteractiveAutonomyPreset> {
		const next = resolveInteractiveAutonomyPreset(preset);
		this.settingsManager.setApprovalPolicy(next.approvalPolicy);
		this.settingsManager.setAutonomyMode(next.autonomyMode);
		return next;
	}

	private getAutonomyModeDisplay(): { label: string; description: string } {
		if (this.specState?.phase === "planning" && this.isSpecMaskEnabled()) {
			return { label: "Auto (Spec)", description: "planning stays read-only under spec rules" };
		}

		return describeInteractiveAutonomyPreset(this.getInteractiveAutonomyPreset());
	}

	private getSpecModeDisplay(): string | undefined {
		if (!this.isSpecMaskEnabled()) {
			return undefined;
		}
		if (!this.specState || this.specState.phase === "inactive") {
			return undefined;
		}
		if (this.specState.phase === "planning") {
			return "Spec (Planning)";
		}
		if (this.specState.phase === "approved") {
			return "Spec (Approved)";
		}
		return "Spec (Executing)";
	}

	private updateModeBanner(): void {
		this.modeContainer.clear();
		const auto = this.getAutonomyModeDisplay();
		const segments: string[] = [];
		const spec = this.getSpecModeDisplay();
		if (spec) {
			segments.push(theme.fg(this.getSpecThemeColor(), spec));
		}
		segments.push(theme.fg(spec ? "muted" : "accent", `${auto.label} - ${auto.description}`));
		if (this.hasMissionModeIndicator() && this.missionState) {
			segments.push(theme.fg("warning", `Mission (${this.capitalize(this.missionState.status)})`));
		}

		this.modeContainer.addChild(new TruncatedText(segments.join(theme.fg("dim", " • ")), 1, 0));
		const hints = [
			theme.fg("muted", this.getWorkingSessionTimerLabel()),
			keyHint("app.spec.toggle", "toggle spec"),
			keyHint("app.autonomy.cycle", "cycle auto"),
		];
		if (this.hasMissionModeIndicator()) {
			hints.push(theme.fg("muted", "Use /mission for mission control"));
		}
		this.modeContainer.addChild(new TruncatedText(hints.join(theme.fg("dim", "  ")), 1, 0));
	}

	private async toggleSpecMask(): Promise<void> {
		if (this.hasMissionModeIndicator() && !this.specState) {
			this.showWarning("Mission is active. Use /mission to manage the mission before starting specification mode.");
			return;
		}

		if (!this.specState || this.specState.phase === "inactive") {
			await this.enterSpecMode();
			return;
		}

		if (this.isSpecMaskEnabled()) {
			await this.restoreSessionAfterSpec(this.specState);
			this.persistSpecState(createSpecState({ ...this.specState, maskEnabled: false }));
			await this.applySpecStateToSession(this.specState);
			this.showStatus("Specification mode disabled for future turns");
			return;
		}

		this.persistSpecState(createSpecState({ ...this.specState, maskEnabled: true }));
		if (this.specState.phase === "planning") {
			await this.applySpecStateToSession(this.specState);
		} else {
			this.updateModeBanner();
			this.showStatus(
				this.specState.phase === "approved"
					? "Specification mode re-enabled. Use /spec to review or approve the current plan."
					: "Specification execution context re-enabled.",
			);
		}
	}

	private cycleAutonomyMode(): void {
		const next = cycleInteractiveAutonomyPreset(this.getInteractiveAutonomyPreset());
		this.setRuntimeInteractiveAutonomyPreset(next);
		const auto = this.getAutonomyModeDisplay();
		this.showStatus(`${auto.label}: ${auto.description}`);
	}

	private updateSpecWidget(): void {
		if (!specHasPlan(this.specState) || this.missionState || !this.isSpecMaskEnabled()) {
			this.setExtensionWidget("__spec_card__", undefined);
			return;
		}
		this.setExtensionWidget(
			"__spec_card__",
			[
				this.getSpecWidgetTitleLine(),
				`${theme.fg("muted", "Use ")}${theme.fg(this.getSpecThemeColor(), "/spec")}${theme.fg("muted", " to review, approve, or iterate on the current plan")}`,
			],
			{ placement: "aboveEditor" },
		);
	}

	private async showSpecSelector(): Promise<void> {
		if (!specHasPlan(this.specState)) {
			this.handleSpecStatus();
			return;
		}

		const title = `Specification ready: ${this.specState.plan.title}`;
		const options =
			this.specState.phase === "executing"
				? ["Return to planning", "Clear specification mode"]
				: [
						"Proceed with implementation",
						"Proceed, and allow file edits and read-only commands (Low)",
						"Proceed, and allow reversible commands (Medium)",
						"Proceed, and allow all commands (High)",
						"Keep iterating on spec",
					];
		const choice = await this.showExtensionSelector(title, options, undefined, this.getSpecThemeColor());
		if (!choice) {
			return;
		}

		if (choice === "Proceed with implementation") {
			this.setRuntimeInteractiveAutonomyPreset("manual");
			await this.beginSpecExecution();
			return;
		}
		if (choice === "Proceed, and allow file edits and read-only commands (Low)") {
			this.setRuntimeInteractiveAutonomyPreset("auto-low");
			this.showStatus("Proceeding with approved spec using low autonomy for the rest of this session.");
			await this.beginSpecExecution();
			return;
		}
		if (choice === "Proceed, and allow reversible commands (Medium)") {
			this.setRuntimeInteractiveAutonomyPreset("auto-medium");
			this.showStatus("Proceeding with approved spec using medium autonomy for the rest of this session.");
			await this.beginSpecExecution();
			return;
		}
		if (choice === "Proceed, and allow all commands (High)") {
			this.setRuntimeInteractiveAutonomyPreset("auto-high");
			this.showStatus("Proceeding with approved spec using high autonomy for the rest of this session.");
			await this.beginSpecExecution();
			return;
		}
		if (choice === "Keep iterating on spec" || choice === "Return to planning") {
			if (this.specState) {
				if (this.specState.phase === "executing") {
					await this.restoreSessionAfterSpec(this.specState);
				}
				this.persistSpecState(
					createSpecState({
						...this.specState,
						phase: "planning",
						maskEnabled: true,
						planningStartedAt: undefined,
						planningTurnCount: undefined,
						planningEvidence: undefined,
					}),
				);
				await this.applySpecStateToSession(this.specState);
				this.showStatus("Specification plan unlocked for iteration");
			}
			return;
		}
		if (choice === "Clear specification mode") {
			await this.clearSpecMode();
		}
	}

	private getAssistantText(message: AssistantMessage): string {
		return message.content
			.filter((part): part is TextContent => part.type === "text")
			.map((part) => part.text)
			.join("\n");
	}

	private getLastAssistantMessage(messages: readonly AgentMessage[]): AssistantMessage | undefined {
		for (let index = messages.length - 1; index >= 0; index -= 1) {
			const message = messages[index];
			if (message.role === "assistant") {
				return message;
			}
		}
		return undefined;
	}

	private getLastPersistedAssistantMessageAfterLatestSpecState(): AssistantMessage | undefined {
		const entries = this.sessionManager.getEntries();
		let latestSpecStateIndex = -1;
		for (let index = entries.length - 1; index >= 0; index -= 1) {
			const entry = entries[index];
			if (entry.type === "custom" && getSpecStateEntry(entry)) {
				latestSpecStateIndex = index;
				break;
			}
		}

		for (let index = entries.length - 1; index > latestSpecStateIndex; index -= 1) {
			const entry = entries[index];
			if (entry.type === "message" && entry.message.role === "assistant") {
				return entry.message;
			}
		}

		return undefined;
	}

	private formatSpecPlanningGateStatus(missing: string[]): string {
		return [
			"Specification plan blocked until the planning prerequisites are complete:",
			...missing.map((item) => `- ${item}`),
		].join("\n");
	}

	private showSpecPlanningBlockedFeedback(missing: string[]): void {
		this.addMessageToChat({
			role: "custom",
			customType: "spec-plan-blocked",
			content: buildSpecPlanningBlockedMessage(missing),
			display: true,
			timestamp: Date.now(),
		});
	}

	private persistSpecState(state: SpecSessionState): void {
		const { updatedAt: _updatedAt, ...rest } = state;
		this.specState = writeSpecState(this.sessionManager, rest);
		this.syncInteractiveAskAvailability();
		this.updateSpecWidget();
		this.updateModeBanner();
	}

	private async restoreSessionAfterSpec(state: SpecSessionState | undefined): Promise<void> {
		if (!state) {
			return;
		}
		if (state.previousActiveTools && state.previousActiveTools.length > 0) {
			this.session.setActiveToolsByName(state.previousActiveTools);
		}
		if (state.previousModel?.provider && state.previousModel?.modelId) {
			const model = this.session.modelRegistry.find(state.previousModel.provider, state.previousModel.modelId);
			if (model) {
				await this.session.setModel(model);
				if (state.previousModel.thinkingLevel) {
					this.session.setThinkingLevel(state.previousModel.thinkingLevel);
				}
			}
		}
	}

	private createInterruptedSpecState(state: SpecSessionState): SpecSessionState {
		return createSpecState({
			...state,
			maskEnabled: false,
			phase: "approved",
		});
	}

	private async finalizeSpecExecutionState(
		state: SpecSessionState,
		nextState: SpecSessionState,
		statusMessage?: string,
	): Promise<void> {
		this.specAutoContinuationActive = false;
		await this.restoreSessionAfterSpec(state);
		this.persistSpecState(nextState);
		await this.applySpecStateToSession(this.specState);
		if (statusMessage) {
			this.showStatus(statusMessage);
		}
	}

	private async applySpecStateToSession(state: SpecSessionState | undefined): Promise<void> {
		this.specState = state;
		this.syncInteractiveAskAvailability();
		this.clearStreamingSpecPlan();
		this.session.removeCustomMessages(["spec-mode-context", "spec-approved", "spec-plan"]);
		this.updateSpecWidget();
		this.updateModeBanner();
		if (!state || state.phase === "inactive" || !this.isSpecMaskEnabled(state)) {
			return;
		}

		if (state.phase === "planning") {
			this.session.setActiveToolsByName(getSpecPlanningToolNames());
			if (state.planningModel?.provider && state.planningModel.modelId) {
				const model = this.session.modelRegistry.find(state.planningModel.provider, state.planningModel.modelId);
				if (model) {
					await this.session.setModel(model);
					if (state.planningModel.thinkingLevel) {
						this.session.setThinkingLevel(state.planningModel.thinkingLevel);
					}
				}
			}
			this.showStatus(`Specification mode active${state.title ? `: ${state.title}` : ""}`);
			return;
		}

		if (state.phase === "approved") {
			this.showStatus(`Specification ready for approval${state.title ? `: ${state.title}` : ""}`);
			return;
		}

		if (state.phase === "executing") {
			this.showStatus(`Executing approved spec${state.title ? `: ${state.title}` : ""}`);
		}
	}

	private async reloadSpecStateFromSession(options?: { restoreFallback?: boolean }): Promise<void> {
		const previous = this.specState;
		const next = readLatestSpecState(this.sessionManager);
		if (!next && options?.restoreFallback && previous) {
			await this.restoreSessionAfterSpec(previous);
		}
		if (next?.phase === "executing" && !this.session.isStreaming) {
			const recoveredAssistant = this.getLastPersistedAssistantMessageAfterLatestSpecState();
			const normalizedState =
				recoveredAssistant?.stopReason === "stop"
					? createInactiveSpecState(next)
					: this.createInterruptedSpecState(next);
			await this.finalizeSpecExecutionState(next, normalizedState);
			return;
		}
		await this.applySpecStateToSession(next);
	}

	private async withSpecContextPrompt(
		text: string,
		options?: { images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" },
	): Promise<void> {
		this.session.removeCustomMessages(["spec-mode-context", "mission-mode-context"]);
		if (this.missionState && ["planning", "running", "paused"].includes(this.missionState.status)) {
			const missionContext =
				this.missionState.status === "planning"
					? buildMissionPlanningContext(this.getAvailableSkillsForMission(), {
							userConfirmedReady: looksLikeMissionPlanReadySignal(text),
						})
					: this.buildMissionExecutionContext(this.missionState);
			const deliverAs =
				options?.streamingBehavior === "followUp"
					? "followUp"
					: options?.streamingBehavior === "steer"
						? "steer"
						: "nextTurn";
			await this.session.sendCustomMessage(
				{ customType: "mission-mode-context", content: missionContext, display: false },
				{ deliverAs },
			);
			await this.session.prompt(text, options);
			return;
		}

		if (!this.specState || this.specState.phase === "inactive" || !this.isSpecMaskEnabled()) {
			await this.session.prompt(text, options);
			return;
		}

		if (this.specState.phase === "approved") {
			this.persistSpecState(
				createSpecState({
					...this.specState,
					phase: "planning",
					planningStartedAt: undefined,
					planningTurnCount: undefined,
					planningEvidence: undefined,
				}),
			);
			await this.applySpecStateToSession(this.specState);
		}

		const context =
			this.specState.phase === "planning"
				? buildSpecPlanningContext()
				: specHasPlan(this.specState) && this.specState.phase === "executing"
					? buildSpecExecutionContext(this.specState.plan, this.specState.artifactPath)
					: undefined;

		if (context) {
			const deliverAs =
				options?.streamingBehavior === "followUp"
					? "followUp"
					: options?.streamingBehavior === "steer"
						? "steer"
						: "nextTurn";
			await this.session.sendCustomMessage(
				{ customType: "spec-mode-context", content: context, display: false },
				{ deliverAs },
			);
		}

		await this.session.prompt(text, options);
	}

	private async triggerSpecPlanningAutoContinuationTurn(missing: string[]): Promise<void> {
		this.specAutoContinuationActive = true;
		this.session.removeCustomMessages(["spec-mode-context", "mission-mode-context", "spec-planning-continuation"]);
		await this.session.sendCustomMessage(
			{ customType: "spec-mode-context", content: buildSpecPlanningContext(), display: false },
			{ deliverAs: "nextTurn" },
		);
		await this.session.sendCustomMessage(
			{
				customType: "spec-planning-continuation",
				content: buildSpecPlanningContinuationContext(missing),
				display: false,
			},
			{ triggerTurn: true },
		);
	}

	private async enterSpecMode(initialRequest?: string): Promise<void> {
		if (this.specState?.phase !== "planning") {
			const currentModel = this.session.model;
			const next = createSpecState({
				id: this.specState?.phase === "inactive" ? this.specState.id : undefined,
				maskEnabled: true,
				phase: "planning",
				request: initialRequest,
				previousActiveTools: this.session.getActiveToolNames(),
				planningModel: this.specState?.planningModel,
				previousModel: currentModel
					? {
							provider: currentModel.provider,
							modelId: currentModel.id,
							thinkingLevel: this.session.thinkingLevel,
						}
					: undefined,
			});
			this.persistSpecState(next);
			await this.applySpecStateToSession(this.specState);
		}

		if (initialRequest) {
			this.editor.setText("");
			this.editor.addToHistory?.(`/spec ${initialRequest}`);
			await this.withSpecContextPrompt(initialRequest);
			return;
		}

		this.showStatus("Specification mode enabled. Describe the feature to plan.");
	}

	private handleSpecStatus(): void {
		if (!this.specState || this.specState.phase === "inactive") {
			this.showStatus("No active specification plan");
			return;
		}

		const lines = [
			`Specification mode: ${this.specState.phase}`,
			this.specState.phase === "approved" ? "Plan is waiting for approval or iteration." : undefined,
			this.specState.title ? `Title: ${this.specState.title}` : undefined,
			this.specState.artifactPath ? `Artifact: ${this.specState.artifactPath}` : undefined,
		]
			.filter((line): line is string => Boolean(line))
			.join("\n");
		this.showStatus(lines);
	}

	private async clearSpecMode(): Promise<void> {
		await this.restoreSessionAfterSpec(this.specState);
		this.persistSpecState(createInactiveSpecState(this.specState));
		await this.applySpecStateToSession(this.specState);
		this.showStatus("Specification mode cleared");
	}

	private async beginSpecExecution(): Promise<void> {
		if (!specHasPlan(this.specState)) {
			this.showWarning("No specification plan available to execute");
			return;
		}
		if (this.specState.phase === "executing") {
			this.showStatus(`Already executing approved spec${this.specState.title ? `: ${this.specState.title}` : ""}`);
			return;
		}

		const artifactPath =
			this.specState.artifactPath ?? (await saveSpecArtifact(this.sessionManager.getCwd(), this.specState.plan));
		const approvedAt = new Date().toISOString();
		await this.restoreSessionAfterSpec(this.specState);
		this.persistSpecState(
			createSpecState({
				...this.specState,
				maskEnabled: true,
				phase: "executing",
				artifactPath,
				approvedAt,
			}),
		);

		await this.session.sendCustomMessage(
			{
				customType: "spec-approved",
				content: `Approved specification: ${this.specState.plan.title}\nSaved to ${artifactPath}`,
				display: true,
			},
			{ triggerTurn: false },
		);
		this.session.removeCustomMessages(["spec-mode-context", "mission-mode-context"]);
		await this.session.sendCustomMessage(
			{
				customType: "spec-mode-context",
				content: buildSpecExecutionContext(this.specState.plan, artifactPath),
				display: false,
			},
			{ triggerTurn: true },
		);
	}

	private async maybeHandleSpecExecutionCompletion(
		event: Extract<AgentSessionEvent, { type: "agent_end" }>,
	): Promise<void> {
		const state = this.specState;
		if (!state || state.phase !== "executing") {
			return;
		}

		const lastAssistant = this.getLastAssistantMessage(event.messages);
		if (lastAssistant?.stopReason === "stop") {
			await this.finalizeSpecExecutionState(
				state,
				createInactiveSpecState(state),
				"Specification execution completed. Specification mode cleared.",
			);
			return;
		}

		if (lastAssistant?.stopReason === "error" && this.session.isRetrying) {
			return;
		}

		await this.finalizeSpecExecutionState(
			state,
			this.createInterruptedSpecState(state),
			"Specification execution stopped before completion. Approved plan kept for review.",
		);
	}

	private async maybeHandleSpecRetryFailure(
		event: Extract<AgentSessionEvent, { type: "auto_retry_end" }>,
	): Promise<void> {
		const state = this.specState;
		if (!state || state.phase !== "executing" || event.success) {
			return;
		}

		await this.finalizeSpecExecutionState(
			state,
			this.createInterruptedSpecState(state),
			"Specification execution stopped before completion. Approved plan kept for review.",
		);
	}

	private async maybeHandleSpecPlan(event: Extract<AgentSessionEvent, { type: "agent_end" }>): Promise<void> {
		if (this.specState?.phase !== "planning") {
			return;
		}

		const autoContinuationActive = this.specAutoContinuationActive;
		this.specAutoContinuationActive = false;
		const priorPlanningTurns = this.specState.planningTurnCount ?? 0;
		const mergedEvidence = mergeSpecPlanningEvidence(
			this.specState.planningEvidence,
			collectSpecPlanningEvidence(event.messages),
		);
		const nextPlanningTurnCount = priorPlanningTurns + 1;
		const lastAssistant = this.getLastAssistantMessage(event.messages);
		const plan = lastAssistant ? parseSpecPlan(this.getAssistantText(lastAssistant)) : undefined;
		if (!plan || this.specState.plan?.markdown === plan.markdown) {
			this.persistSpecState(
				createSpecState({
					...this.specState,
					phase: "planning",
					planningTurnCount: nextPlanningTurnCount,
					planningEvidence: mergedEvidence,
				}),
			);
			return;
		}

		const gate = evaluateSpecPlanningGate({
			priorPlanningTurns,
			evidence: mergedEvidence,
			requestText: this.specState.request,
			planMarkdown: plan.markdown,
		});
		if (!gate.ready) {
			this.persistSpecState(
				createSpecState({
					...this.specState,
					phase: "planning",
					planningTurnCount: nextPlanningTurnCount,
					planningEvidence: mergedEvidence,
				}),
			);
			this.clearStreamingSpecPlan();
			if (!autoContinuationActive && shouldAutoContinueSpecPlanning(gate.missing)) {
				await this.triggerSpecPlanningAutoContinuationTurn(gate.missing);
				return;
			}
			this.showSpecPlanningBlockedFeedback(gate.missing);
			this.showStatus(this.formatSpecPlanningGateStatus(gate.missing));
			return;
		}

		this.persistSpecState(
			createSpecState({
				...this.specState,
				phase: "approved",
				title: plan.title,
				plan,
				planningTurnCount: nextPlanningTurnCount,
				planningEvidence: mergedEvidence,
			}),
		);

		await this.session.sendCustomMessage(
			{
				customType: "spec-plan",
				content: plan.markdown,
				display: true,
			},
			{ triggerTurn: false },
		);

		await this.showSpecSelector();
	}

	private async setSpecModel(modelReference: string): Promise<void> {
		const trimmed = modelReference.trim();
		const previous = this.specState;
		if (!trimmed || trimmed === "clear") {
			this.persistSpecState(
				createSpecState({
					...previous,
					planningModel: undefined,
					phase: previous?.phase ?? "inactive",
				}),
			);
			if (previous?.phase === "planning") {
				await this.restoreSessionAfterSpec(previous);
				this.session.setActiveToolsByName(getSpecPlanningToolNames());
			}
			this.showStatus("Cleared specification planning model");
			return;
		}

		const resolved = resolveCliModel({ cliModel: trimmed, modelRegistry: this.session.modelRegistry });
		if (!resolved.model) {
			this.showError(resolved.error ?? `Model "${trimmed}" not found`);
			return;
		}

		this.persistSpecState(
			createSpecState({
				...previous,
				phase: previous?.phase ?? "inactive",
				planningModel: {
					modelArg: `${resolved.model.provider}/${resolved.model.id}`,
					provider: resolved.model.provider,
					modelId: resolved.model.id,
					thinkingLevel: resolved.thinkingLevel,
				},
			}),
		);
		if (this.specState?.phase === "planning") {
			await this.applySpecStateToSession(this.specState);
		}
		this.showStatus(`Spec planning model: ${resolved.model.name || resolved.model.id}`);
	}

	private async handleAgentsCommand(): Promise<void> {
		const cwd = this.sessionManager.getCwd();
		const discovery = discoverAgents(cwd, "both");
		const visibleAgents = discovery.agents.filter((agent) => !agent.hidden);

		const ACTION_CREATE = "+ Create new agent";
		const ACTION_IMPORT = "⇩ Import from Claude Code";
		const ACTION_RELOAD = "↺ Reload";

		const agentLabels = visibleAgents.map((agent) => this.formatAgentOption(agent));
		const menuOptions = [ACTION_CREATE, ACTION_IMPORT, ACTION_RELOAD, ...agentLabels];

		const title = `Agents (${visibleAgents.length} available)`;
		const selected = await this.showExtensionSelector(title, menuOptions);
		if (!selected) return;

		if (selected === ACTION_CREATE) {
			await this.handleAgentCreate(cwd, discovery.projectAgentsDir);
			return;
		}
		if (selected === ACTION_IMPORT) {
			await this.handleAgentImport(cwd);
			return;
		}
		if (selected === ACTION_RELOAD) {
			const reloaded = discoverAgents(cwd, "both");
			const count = reloaded.agents.filter((a) => !a.hidden).length;
			this.showStatus(`Agents reloaded. ${count} agent${count !== 1 ? "s" : ""} available.`);
			return;
		}

		const agent = visibleAgents.find((item) => this.formatAgentOption(item) === selected);
		if (!agent) return;
		await this.handleAgentActions(agent, cwd);
	}

	private async handleAgentActions(agent: AgentConfig, _cwd: string): Promise<void> {
		const ACTION_VIEW = "View details";
		const ACTION_EDIT = "Edit (open in $EDITOR)";
		const ACTION_DELETE = "Delete";

		const canEdit = agent.source !== "built-in" && !!agent.filePath;
		const actions = [ACTION_VIEW, ...(canEdit ? [ACTION_EDIT, ACTION_DELETE] : [])];
		const action = await this.showExtensionSelector(`${agent.name} — actions`, actions);
		if (!action) return;

		if (action === ACTION_VIEW) {
			const toolsSummary = agent.tools?.length
				? `Tools: ${agent.tools.join(", ")}`
				: "Tools: inherit from parent session";
			const details = [
				`Agent: ${agent.name}`,
				`Source: ${agent.source}`,
				`Location: ${agent.filePath ?? "built-in"}`,
				`Mode: ${agent.mode ?? "subagent"}`,
				agent.specRole ? `Role: ${agent.specRole}` : undefined,
				agent.readOnly ? "Read-only: yes" : undefined,
				agent.model ? `Model: ${agent.model}` : "Model: inherit",
				agent.reasoningEffort ? `Thinking: ${agent.reasoningEffort}` : undefined,
				toolsSummary,
				`Description: ${agent.description}`,
			]
				.filter((line): line is string => Boolean(line))
				.join("\n");
			this.showStatus(details);
			return;
		}

		if (action === ACTION_EDIT && agent.filePath) {
			const editorCmd = process.env.VISUAL ?? process.env.EDITOR;
			if (!editorCmd) {
				this.showWarning("No editor configured. Set $VISUAL or $EDITOR environment variable.");
				return;
			}
			this.ui.stop();
			const [editor, ...editorArgs] = editorCmd.split(" ");
			spawnSync(editor, [...editorArgs, agent.filePath], {
				stdio: "inherit",
				shell: process.platform === "win32",
			});
			this.ui.start();
			this.ui.requestRender();
			this.showStatus(`Saved: ${agent.filePath}`);
			return;
		}

		if (action === ACTION_DELETE && agent.filePath) {
			const confirm = await this.showExtensionSelector(`Delete agent "${agent.name}"?`, [
				"No, keep it",
				"Yes, delete",
			]);
			if (confirm !== "Yes, delete") return;
			try {
				fs.unlinkSync(agent.filePath);
				this.showStatus(`Agent "${agent.name}" deleted.`);
			} catch (err) {
				this.showWarning(`Failed to delete agent: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	}

	private async handleAgentCreate(cwd: string, projectAgentsDir: string | null): Promise<void> {
		const userDir = getUserAgentsDir();
		const projDir = projectAgentsDir ?? getDefaultProjectAgentsDir(cwd);

		// Step 1: location
		const locUser = `User  (~/.hirocode/agent/agents/)`;
		const locProj = `Project  (.hirocode/agents/)`;
		const locChoice = await this.showExtensionSelector("Create agent — choose location", [locUser, locProj]);
		if (!locChoice) return;
		const targetDir = locChoice === locProj ? projDir : userDir;

		// Step 2: model — dynamically pulled from the registry (same source as /model)
		const MODEL_INHERIT = "inherit  (use parent session model)";
		this.session.modelRegistry.refresh();
		const availableModels = this.session.modelRegistry.getAvailable();
		const modelOptions = [MODEL_INHERIT, ...availableModels.map((m) => `${m.provider}/${m.id}`)];
		const modelChoice = await this.showExtensionSelector(
			`Create agent — choose model  (${availableModels.length} available)`,
			modelOptions,
		);
		if (!modelChoice) return;
		const modelValue = modelChoice === MODEL_INHERIT ? "inherit" : modelChoice;

		// Step 3: tools
		const TOOLS_ALL = "all tools  (no restriction)";
		const toolsChoice = await this.showExtensionSelector("Create agent — choose tools", [
			TOOLS_ALL,
			"read-only  (read, grep, find, ls)",
			"edit       (edit, write)",
			"execute    (bash)",
			"web        (webfetch, websearch)",
			"custom     (edit file manually)",
		]);
		if (!toolsChoice) return;

		const toolsMap: Record<string, string | undefined> = {
			[TOOLS_ALL]: undefined,
			"read-only  (read, grep, find, ls)": "read-only",
			"edit       (edit, write)": "edit",
			"execute    (bash)": "execute",
			"web        (webfetch, websearch)": "web",
			"custom     (edit file manually)": undefined,
		};
		const toolsValue = toolsMap[toolsChoice];

		// Build template frontmatter
		const toolsLine = toolsValue ? `tools: ${toolsValue}` : "# tools: read-only  # uncomment and adjust as needed";
		const template = [
			"---",
			"name: my-agent  # change to a unique lowercase name (letters, digits, hyphens)",
			"description: A brief description of what this agent does.",
			`model: ${modelValue}`,
			toolsLine,
			"---",
			"",
			"You are a specialized agent. Describe your role and behavior here.",
			"",
			"When done:",
			"1. State what you completed.",
			"2. List any files changed.",
			"3. Note follow-up work or risks.",
		].join("\n");

		// Write template and open in editor
		fs.mkdirSync(targetDir, { recursive: true });
		const tmpPath = path.join(targetDir, `new-agent-${Date.now()}.md`);
		fs.writeFileSync(tmpPath, template, { encoding: "utf-8" });

		const editorCmd = process.env.VISUAL ?? process.env.EDITOR;
		if (!editorCmd) {
			this.showStatus(`Template created at: ${tmpPath}\nSet $VISUAL or $EDITOR to edit it interactively.`);
			return;
		}

		this.ui.stop();
		const [editor, ...editorArgs] = editorCmd.split(" ");
		const result = spawnSync(editor, [...editorArgs, tmpPath], {
			stdio: "inherit",
			shell: process.platform === "win32",
		});
		this.ui.start();
		this.ui.requestRender();

		if (result.status !== 0) {
			this.showWarning(`Editor exited with error. Template saved at: ${tmpPath}`);
			return;
		}

		// Validate the saved file
		try {
			const saved = fs.readFileSync(tmpPath, "utf-8");
			// Try to detect the name from frontmatter for the rename
			const nameMatch = saved.match(/^name:\s*([a-z0-9][a-z0-9_-]*)/m);
			const agentName = nameMatch?.[1] ?? null;
			if (agentName && agentName !== "my-agent") {
				const finalPath = path.join(targetDir, `${agentName}.md`);
				fs.renameSync(tmpPath, finalPath);
				this.showStatus(`Agent "${agentName}" created at: ${finalPath}`);
			} else {
				this.showStatus(`Agent template saved at: ${tmpPath}\nRename the file to match the 'name' field.`);
			}
		} catch (err) {
			this.showWarning(`Could not finalize agent file: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private async handleAgentImport(cwd: string): Promise<void> {
		const claudeAgents = scanClaudeAgents(cwd);
		if (claudeAgents.length === 0) {
			this.showStatus("No Claude Code agents found in ~/.claude/agents/ or .claude/agents/");
			return;
		}

		const userDir = getUserAgentsDir();
		const agentOptions = claudeAgents.map((a) => {
			const exists = agentExistsInDir(a.name, userDir);
			const warning = a.invalidTools.length > 0 ? ` ⚠ unmapped: ${a.invalidTools.join(",")}` : "";
			return `${exists ? "◦" : "●"} ${a.name}${exists ? " (already exists)" : ""}${warning}`;
		});

		const selected = await this.showExtensionSelector(
			`Import from Claude Code  (${claudeAgents.length} found — ● new, ◦ exists)`,
			agentOptions,
		);
		if (!selected) return;

		const idx = agentOptions.indexOf(selected);
		if (idx < 0 || idx >= claudeAgents.length) return;
		const agent = claudeAgents[idx];

		// Confirm if agent already exists
		if (agentExistsInDir(agent.name, userDir)) {
			const confirm = await this.showExtensionSelector(`Agent "${agent.name}" already exists. Overwrite?`, [
				"No, keep existing",
				"Yes, overwrite",
			]);
			if (confirm !== "Yes, overwrite") return;
		}

		const { imported, failed } = importClaudeAgents([agent], userDir);
		if (imported.length > 0) {
			const warnings =
				agent.invalidTools.length > 0 ? `\nUnmapped tools skipped: ${agent.invalidTools.join(", ")}` : "";
			this.showStatus(`Imported "${imported[0]}" → ${userDir}/${imported[0]}.md${warnings}`);
		} else if (failed.length > 0) {
			this.showWarning(`Import failed: ${failed[0].error}`);
		}
	}

	private formatAgentOption(agent: AgentConfig): string {
		const source = agent.source === "built-in" ? "built-in" : agent.source === "project" ? "project" : "user";
		const model = agent.model ?? "inherit";
		const toolsSummary = agent.tools?.length
			? `${agent.tools.length} tool${agent.tools.length !== 1 ? "s" : ""}`
			: "all tools";
		const desc = agent.description.length > 50 ? `${agent.description.slice(0, 50)}...` : agent.description;
		return `${agent.name}  [${source}]  ${model}  ${toolsSummary}  — ${desc}`;
	}

	private clearStreamingSpecPlan(): void {
		if (!this.streamingSpecPlanComponent) {
			return;
		}
		this.chatContainer.removeChild(this.streamingSpecPlanComponent);
		this.streamingSpecPlanComponent = undefined;
	}

	private getCustomMessageRenderer(customType: string) {
		return this.session.extensionRunner?.getMessageRenderer(customType) ?? getBuiltinMessageRenderer(customType);
	}

	private buildVisibleAssistantMessage(message: AssistantMessage): AssistantMessage {
		const isMissionPlanning = Boolean(this.missionState && this.missionState.status === "planning");
		const isSpecPlanning = this.specState?.phase === "planning";

		if (!isMissionPlanning && !isSpecPlanning) {
			return message;
		}

		const content = message.content.map((part) => {
			if (part.type !== "text") {
				return part;
			}
			if (isSpecPlanning) {
				const state = extractProposedPlanDisplayState(part.text);
				return { ...part, text: state.visibleText };
			}
			// Mission planning: strip <mission_plan> from streaming display
			const state = extractMissionPlanDisplayState(part.text);
			return { ...part, text: state.visibleText };
		});

		return { ...message, content };
	}

	private async startMissionPlanning(goal: string): Promise<void> {
		if (this.specState?.phase && this.specState.phase !== "inactive") {
			await this.clearSpecMode();
		}
		const existing =
			this.missionState?.status === "planning"
				? this.missionState
				: createMissionRecord(goal, this.sessionManager.getCwd());
		const mission = {
			...existing,
			goal,
			title: existing.title || goal,
			status: "planning" as const,
			updatedAt: new Date().toISOString(),
		};
		await this.persistMissionState(mission);
		await appendMissionEvent(mission, {
			type: "mission_created",
			missionId: mission.id,
			goal,
			createdAt: mission.createdAt,
		});
		this.editor.addToHistory?.(`/mission ${goal}`);
		this.editor.setText("");
		this.syncInteractiveAskAvailability();
		await this.withSpecContextPrompt(goal);
	}

	private async maybeHandleMissionPlan(event: Extract<AgentSessionEvent, { type: "agent_end" }>): Promise<void> {
		if (!this.missionState || this.missionState.status !== "planning") {
			return;
		}
		const lastAssistant = [...event.messages]
			.reverse()
			.find((message): message is AssistantMessage => message.role === "assistant");
		if (!lastAssistant) {
			return;
		}
		const plan = parseMissionPlan(this.missionState.goal, this.getAssistantText(lastAssistant));
		if (!plan || this.missionState.plan?.markdown === plan.markdown) {
			return;
		}

		const scheduled = buildMissionSchedule(plan, 2);
		const nextMission: MissionRecord = {
			...this.missionState,
			title: plan.title,
			plan,
			schedule: scheduled,
			updatedAt: new Date().toISOString(),
		};
		const persisted = await saveMissionPlan(nextMission, plan);
		persisted.schedule = scheduled;
		await saveMission(persisted);
		await this.persistMissionState(persisted);
		await appendMissionEvent(persisted, {
			type: "mission_plan_saved",
			missionId: persisted.id,
			title: plan.title,
			createdAt: new Date().toISOString(),
		});
		const budgetLines = [
			`Mission plan ready: ${plan.title}`,
			`Features: ${plan.features.length}  Milestones: ${plan.milestones.length}`,
			`Estimated runs: ~${plan.budgetEstimate.estimatedRuns} (floor: ${plan.budgetEstimate.floorRuns})`,
			plan.budgetEstimate.reasoning,
		];
		await this.session.sendCustomMessage(
			{ customType: "mission-plan", content: persisted.plan!.markdown, display: true },
			{ triggerTurn: false },
		);
		await this.session.sendCustomMessage(
			{
				customType: "mission-plan-ready",
				content: budgetLines.join("\n"),
				display: true,
			},
			{ triggerTurn: false },
		);
		const choice = await this.showExtensionCustom<MissionPlanOverviewChoice | undefined>(
			(tui, _theme, _keybindings, done) =>
				new MissionPlanOverviewComponent({
					plan: persisted.plan!,
					tui,
					onSelect: (c) => done(c),
					onCancel: () => done(undefined),
				}),
			{ overlay: true, overlayOptions: { width: "100%" } },
		);
		if (!choice || choice === "iterate") {
			return;
		}
		if (choice === "clear") {
			await this.clearMission();
			return;
		}
		await this.startMissionExecution(persisted);
	}

	private async startMissionExecution(mission: MissionRecord): Promise<void> {
		this.missionOrchestrator = this.createMissionOrchestrator();
		const approved = await updateMissionStatus({ ...mission, status: "running" }, "running");
		await this.persistMissionState(approved);
		this.showStatus(`Starting mission: ${approved.title}`);
		void this.missionOrchestrator
			.start(approved)
			.then(async (result) => {
				this.missionState = result;
				this.syncInteractiveAskAvailability();
				writeMissionLink(this.sessionManager, result);
				this.updateMissionWidget();
				this.missionOrchestrator = undefined;
				if (result.status === "completed") {
					this.showStatus(`Mission completed: ${result.title}`);
				} else if (result.status === "aborted") {
					this.showWarning(`Mission aborted: ${result.title}`);
				}
			})
			.catch((error: unknown) => {
				this.missionOrchestrator = undefined;
				this.showError(error instanceof Error ? error.message : String(error));
			});
	}

	private async clearMission(): Promise<void> {
		if (this.missionOrchestrator) {
			this.missionOrchestrator.abort();
			this.missionOrchestrator = undefined;
		}
		this.missionState = undefined;
		this.missionRuntimeUpdateChain = Promise.resolve();
		this.syncInteractiveAskAvailability();
		clearMissionLink(this.sessionManager);
		this.session.removeCustomMessages(["mission-mode-context", "mission-plan-ready", "mission-plan"]);
		this.setExtensionWidget("__mission_control__", undefined);
		this.updateModeBanner();
		this.showStatus("Mission context cleared");
	}

	private async openMissionFeatureSession(
		featureId: string,
	): Promise<{ kind: "opened" } | { kind: "waiting" | "unavailable"; message: string }> {
		const navigation = resolveMissionFeatureSessionNavigation(this.missionState, featureId);
		switch (navigation.kind) {
			case "session":
				await this.openChildSession(navigation.sessionFile);
				return { kind: "opened" };
			case "waiting":
			case "unavailable":
				return { kind: navigation.kind, message: navigation.message };
		}
	}

	private async openChildSession(sessionFile: string): Promise<void> {
		const mode = resolveChildSessionOpenMode({
			isStreaming: this.session.isStreaming,
			activeSessionFile: this.activeSessionManager.getSessionFile(),
			targetSessionFile: sessionFile,
		});
		if (mode === "detached") {
			this.openDetachedSessionView(sessionFile);
			this.showStatus("Viewing detached child session while the active session keeps running");
			return;
		}
		await this.handleResumeSession(sessionFile);
	}

	private async handleMissionDelegatedApproval(request: DelegatedTaskApprovalRequest): Promise<{
		approved: boolean;
		reason?: string;
	}> {
		const approved = await this.showExtensionConfirm(
			`Mission worker approval\n${request.agent}`,
			`${request.kind}: ${request.summary}`,
		);
		if (approved) {
			this.showStatus(`Approved: ${request.summary}`);
			return { approved: true };
		}
		this.showWarning(`Rejected: ${request.summary}`);
		return { approved: false, reason: "Rejected from Mission Control" };
	}

	private buildRetryFailureContext(mission: MissionRecord): Record<string, string> {
		const context: Record<string, string> = {};
		for (const [milestoneId, report] of Object.entries(mission.validationReports)) {
			if (report.status !== "failed") continue;
			const lines: string[] = [];
			for (const check of report.structuredChecks) {
				if (check.exitCode !== 0) {
					lines.push(`Command "${check.command}" failed (exit ${check.exitCode}): ${check.output.slice(0, 300)}`);
				}
			}
			if (report.findings.length > 0) {
				lines.push(`Reviewer findings: ${report.findings.slice(0, 3).join("; ")}`);
			}
			const milestone = mission.plan?.milestones.find((m) => m.id === milestoneId);
			for (const featureId of milestone?.featureIds ?? []) {
				context[featureId] = lines.join("\n");
			}
		}
		return context;
	}

	private async retryMission(): Promise<void> {
		if (!this.missionState) {
			return;
		}
		const failureContext = this.buildRetryFailureContext(this.missionState);
		const featureRuns: Record<string, MissionFeatureRun> = Object.fromEntries(
			Object.entries(this.missionState.featureRuns).map(([featureId, run]) => [
				featureId,
				run.status === "failed" || run.status === "blocked"
					? ({
							...run,
							status: "pending",
							lastError: failureContext[featureId] ?? undefined,
						} as MissionFeatureRun)
					: run,
			]),
		);
		const workers: Record<string, MissionWorkerState> = Object.fromEntries(
			Object.entries(this.missionState.workers).map(([featureId, worker]) => [
				featureId,
				worker.status === "failed" || worker.status === "aborted"
					? ({ ...worker, status: "pending" } as MissionWorkerState)
					: worker,
			]),
		);
		const milestoneStatus = Object.fromEntries(
			Object.entries(this.missionState.milestoneStatus).map(([milestoneId, status]) => [
				milestoneId,
				status === "failed" ? "pending" : status,
			]),
		) as MissionRecord["milestoneStatus"];
		await this.startMissionExecution({
			...this.missionState,
			status: "paused",
			featureRuns,
			workers,
			milestoneStatus,
			pausedReason: undefined,
		});
	}

	private async openMissionControl(): Promise<void> {
		if (!this.missionState) {
			this.showStatus("No active mission. Use /mission <goal> to start planning.");
			return;
		}
		let selectedFeatureId: string | undefined;
		let notice: string | undefined;
		while (this.missionState) {
			const action = await this.showExtensionCustom<MissionControlAction | undefined>(
				(_tui, _theme, _keybindings, done) =>
					new MissionControlComponent({
						getMission: () => this.missionState,
						getPendingApprovals: () => this.safetyServices.approval.getPendingRequests().length,
						selectedFeatureId,
						notice,
						onSelect: (selected) => done(selected),
						onCancel: () => done(undefined),
					}),
				{
					overlay: true,
					overlayOptions: { width: "78%", maxHeight: "80%", anchor: "center" },
				},
			).catch(() => undefined);
			if (!action) {
				return;
			}
			if (action.type === "open-feature") {
				const result = await this.openMissionFeatureSession(action.featureId);
				if (result.kind === "opened") {
					return;
				}
				selectedFeatureId = action.featureId;
				notice = result.message;
				continue;
			}
			await this.handleMissionControlAction(action);
			return;
		}
	}

	private async handleMissionControlAction(action: MissionControlAction): Promise<void> {
		if (!this.missionState) {
			return;
		}
		switch (action.type) {
			case "status":
				this.showStatus(this.formatMissionControlLines(this.missionState).join("\n"));
				return;
			case "toggle-pause":
				if (this.missionState.status === "running") {
					this.missionOrchestrator?.pause();
					this.showStatus("Mission will pause after the current wave.");
					return;
				}
				if (this.missionOrchestrator) {
					this.missionOrchestrator.resume();
					this.showStatus("Mission resumed");
					return;
				}
				await this.startMissionExecution(this.missionState);
				return;
			case "retry":
				await this.retryMission();
				return;
			case "open-feature":
				return;
			case "abort":
				this.missionOrchestrator?.abort();
				this.showWarning("Mission abort requested.");
				return;
			case "clear":
				await this.clearMission();
				return;
		}
	}

	private async handleMissionCommand(text: string): Promise<void> {
		const rest = text.slice(8).trim();
		if (!rest) {
			await this.openMissionControl();
			return;
		}
		if (rest === "status") {
			await this.openMissionControl();
			return;
		}
		if (rest === "pause") {
			this.missionOrchestrator?.pause();
			this.showStatus("Mission will pause after the current wave.");
			return;
		}
		if (rest === "resume") {
			if (this.missionState) {
				await this.startMissionExecution(this.missionState);
			}
			return;
		}
		if (rest === "abort") {
			this.missionOrchestrator?.abort();
			this.showWarning("Mission abort requested.");
			return;
		}
		if (rest === "retry") {
			await this.retryMission();
			return;
		}
		if (rest.startsWith("open ")) {
			await this.openMissionFeatureSession(rest.slice(5).trim());
			return;
		}
		if (rest.startsWith("replan ")) {
			if (!this.missionState) {
				this.showWarning("No mission to re-plan.");
				return;
			}
			this.missionState = await updateMissionStatus(this.missionState, "planning");
			await this.persistMissionState(this.missionState);
			await this.withSpecContextPrompt(`Re-plan the mission. Additional direction: ${rest.slice(7).trim()}`);
			return;
		}
		await this.startMissionPlanning(rest);
	}

	private async handleMissionsCommand(): Promise<void> {
		const missions = listMissions(this.sessionManager.getCwd());
		const selected = await this.showExtensionCustom<MissionRecord | undefined>(
			(_tui, _theme, _keybindings, done) =>
				new MissionListComponent({
					getMissions: () => missions,
					onSelect: (mission) => done(mission),
					onCancel: () => done(undefined),
				}),
			{
				overlay: true,
				overlayOptions: { width: "78%", maxHeight: "80%", anchor: "center" },
			},
		);
		if (!selected) {
			return;
		}
		await this.persistMissionState(selected);
		await this.openMissionControl();
	}

	private async handleSpecCommand(text: string): Promise<void> {
		const rest = text.slice(5).trim();
		if (!rest) {
			if (this.specState?.phase && this.specState.phase !== "inactive" && specHasPlan(this.specState)) {
				await this.showSpecSelector();
				return;
			}
			await this.enterSpecMode();
			return;
		}

		if (rest === "status") {
			if (specHasPlan(this.specState)) {
				await this.showSpecSelector();
			} else {
				this.handleSpecStatus();
			}
			return;
		}

		if (rest === "approve") {
			await this.beginSpecExecution();
			return;
		}

		if (rest === "clear") {
			await this.clearSpecMode();
			return;
		}

		if (rest.startsWith("model ")) {
			await this.setSpecModel(rest.slice(6));
			return;
		}

		await this.enterSpecMode(rest);
	}

	/**
	 * Show a text input for extensions.
	 */
	private showExtensionInput(
		title: string,
		placeholder?: string,
		opts?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		return new Promise((resolve) => {
			if (opts?.signal?.aborted) {
				resolve(undefined);
				return;
			}

			const onAbort = () => {
				this.hideExtensionInput();
				resolve(undefined);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			this.extensionInput = new ExtensionInputComponent(
				title,
				placeholder,
				(value) => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionInput();
					resolve(value);
				},
				() => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionInput();
					resolve(undefined);
				},
				{ tui: this.ui, timeout: opts?.timeout },
			);

			this.editorContainer.clear();
			this.editorContainer.addChild(this.extensionInput);
			this.ui.setFocus(this.extensionInput);
			this.ui.requestRender();
		});
	}

	/**
	 * Hide the extension input.
	 */
	private hideExtensionInput(): void {
		this.extensionInput?.dispose();
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.extensionInput = undefined;
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	/**
	 * Show a multi-line editor for extensions (with Ctrl+G support).
	 */
	private showExtensionEditor(title: string, prefill?: string): Promise<string | undefined> {
		return new Promise((resolve) => {
			this.extensionEditor = new ExtensionEditorComponent(
				this.ui,
				this.keybindings,
				title,
				prefill,
				(value) => {
					this.hideExtensionEditor();
					resolve(value);
				},
				() => {
					this.hideExtensionEditor();
					resolve(undefined);
				},
			);

			this.editorContainer.clear();
			this.editorContainer.addChild(this.extensionEditor);
			this.ui.setFocus(this.extensionEditor);
			this.ui.requestRender();
		});
	}

	/**
	 * Hide the extension editor.
	 */
	private hideExtensionEditor(): void {
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.extensionEditor = undefined;
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	/**
	 * Set a custom editor component from an extension.
	 * Pass undefined to restore the default editor.
	 */
	private setCustomEditorComponent(
		factory: ((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => EditorComponent) | undefined,
	): void {
		// Save text from current editor before switching
		const currentText = this.editor.getText();

		this.editorContainer.clear();

		if (factory) {
			// Create the custom editor with tui, theme, and keybindings
			const newEditor = factory(this.ui, getEditorTheme(), this.keybindings);

			// Wire up callbacks from the default editor
			newEditor.onSubmit = this.defaultEditor.onSubmit;
			newEditor.onChange = this.defaultEditor.onChange;

			// Copy text from previous editor
			newEditor.setText(currentText);

			// Copy appearance settings if supported
			if (newEditor.borderColor !== undefined) {
				newEditor.borderColor = this.defaultEditor.borderColor;
			}
			if (newEditor.setPaddingX !== undefined) {
				newEditor.setPaddingX(this.defaultEditor.getPaddingX());
			}

			// Set autocomplete if supported
			if (newEditor.setAutocompleteProvider && this.autocompleteProvider) {
				newEditor.setAutocompleteProvider(this.autocompleteProvider);
			}

			// If extending CustomEditor, copy app-level handlers
			// Use duck typing since instanceof fails across jiti module boundaries
			const customEditor = newEditor as unknown as Record<string, unknown>;
			if ("actionHandlers" in customEditor && customEditor.actionHandlers instanceof Map) {
				if (!customEditor.onEscape) {
					customEditor.onEscape = () => this.defaultEditor.onEscape?.();
				}
				if (!customEditor.onCtrlD) {
					customEditor.onCtrlD = () => this.defaultEditor.onCtrlD?.();
				}
				if (!customEditor.onPasteImage) {
					customEditor.onPasteImage = () => this.defaultEditor.onPasteImage?.();
				}
				if (!customEditor.onExtensionShortcut) {
					customEditor.onExtensionShortcut = (data: string) => this.defaultEditor.onExtensionShortcut?.(data);
				}
				// Copy action handlers (clear, suspend, model switching, etc.)
				for (const [action, handler] of this.defaultEditor.actionHandlers) {
					(customEditor.actionHandlers as Map<string, () => void>).set(action, handler);
				}
			}

			this.editor = newEditor;
		} else {
			// Restore default editor with text from custom editor
			this.defaultEditor.setText(currentText);
			this.editor = this.defaultEditor;
		}

		this.editorContainer.addChild(this.editor as Component);
		this.ui.setFocus(this.editor as Component);
		this.ui.requestRender();
	}

	/**
	 * Show a notification for extensions.
	 */
	private showExtensionNotify(message: string, type?: "info" | "warning" | "error"): void {
		if (type === "error") {
			this.showError(message);
		} else if (type === "warning") {
			this.showWarning(message);
		} else {
			this.showStatus(message);
		}
	}

	/** Show a custom component with keyboard focus. Overlay mode renders on top of existing content. */
	private async showExtensionCustom<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
		options?: {
			overlay?: boolean;
			overlayOptions?: OverlayOptions | (() => OverlayOptions);
			onHandle?: (handle: OverlayHandle) => void;
		},
	): Promise<T> {
		const savedText = this.editor.getText();
		const isOverlay = options?.overlay ?? false;

		const restoreEditor = () => {
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.editor.setText(savedText);
			this.ui.setFocus(this.editor);
			this.ui.requestRender();
		};

		return new Promise((resolve, reject) => {
			let component: Component & { dispose?(): void };
			let closed = false;

			const close = (result: T) => {
				if (closed) return;
				closed = true;
				if (isOverlay) this.ui.hideOverlay();
				else restoreEditor();
				// Note: both branches above already call requestRender
				resolve(result);
				try {
					component?.dispose?.();
				} catch {
					/* ignore dispose errors */
				}
			};

			Promise.resolve(factory(this.ui, theme, this.keybindings, close))
				.then((c) => {
					if (closed) return;
					component = c;
					if (isOverlay) {
						// Resolve overlay options - can be static or dynamic function
						const resolveOptions = (): OverlayOptions | undefined => {
							if (options?.overlayOptions) {
								const opts =
									typeof options.overlayOptions === "function"
										? options.overlayOptions()
										: options.overlayOptions;
								return opts;
							}
							// Fallback: use component's width property if available
							const w = (component as { width?: number }).width;
							return w ? { width: w } : undefined;
						};
						const handle = this.ui.showOverlay(component, resolveOptions());
						// Expose handle to caller for visibility control
						options?.onHandle?.(handle);
					} else {
						this.editorContainer.clear();
						this.editorContainer.addChild(component);
						this.ui.setFocus(component);
						this.ui.requestRender();
					}
				})
				.catch((err) => {
					if (closed) return;
					if (!isOverlay) restoreEditor();
					reject(err);
				});
		});
	}

	/**
	 * Show an extension error in the UI.
	 */
	private showExtensionError(extensionPath: string, error: string, stack?: string): void {
		const errorMsg = `Extension "${extensionPath}" error: ${error}`;
		const errorText = new Text(theme.fg("error", errorMsg), 1, 0);
		this.chatContainer.addChild(errorText);
		if (stack) {
			// Show stack trace in dim color, indented
			const stackLines = stack
				.split("\n")
				.slice(1) // Skip first line (duplicates error message)
				.map((line) => theme.fg("dim", `  ${line.trim()}`))
				.join("\n");
			if (stackLines) {
				this.chatContainer.addChild(new Text(stackLines, 1, 0));
			}
		}
		this.ui.requestRender();
	}

	// =========================================================================
	// Key Handlers
	// =========================================================================

	private setupKeyHandlers(): void {
		// Set up handlers on defaultEditor - they use this.editor for text access
		// so they work correctly regardless of which editor is active
		this.defaultEditor.onEscape = () => {
			if (this.loadingAnimation) {
				this.restoreQueuedMessagesToEditor({ abort: true });
			} else if (this.session.isBashRunning) {
				this.session.abortBash();
			} else if (this.isBashMode) {
				this.editor.setText("");
				this.isBashMode = false;
				this.updateEditorBorderColor();
			} else if (!this.editor.getText().trim()) {
				// Double-escape with empty editor triggers /tree, /fork, or nothing based on setting
				const action = this.settingsManager.getDoubleEscapeAction();
				if (action !== "none") {
					const now = Date.now();
					if (now - this.lastEscapeTime < 500) {
						if (action === "tree") {
							this.showTreeSelector();
						} else {
							this.showUserMessageSelector();
						}
						this.lastEscapeTime = 0;
					} else {
						this.lastEscapeTime = now;
					}
				}
			}
		};

		// Register app action handlers
		this.defaultEditor.onAction("app.clear", () => this.handleCtrlC());
		this.defaultEditor.onCtrlD = () => this.handleCtrlD();
		this.defaultEditor.onAction("app.suspend", () => this.handleCtrlZ());
		this.defaultEditor.onAction("app.thinking.cycle", () => this.cycleThinkingLevel());
		this.defaultEditor.onAction("app.model.cycleForward", () => this.cycleModel("forward"));
		this.defaultEditor.onAction("app.model.cycleBackward", () => this.cycleModel("backward"));

		// Global debug handler on TUI (works regardless of focus)
		this.ui.onDebug = () => this.handleDebugCommand();
		this.defaultEditor.onAction("app.model.select", () => this.showModelSelector());
		this.defaultEditor.onAction("app.spec.toggle", () => {
			void this.toggleSpecMask();
		});
		this.defaultEditor.onAction("app.autonomy.cycle", () => this.cycleAutonomyMode());
		this.defaultEditor.onAction("app.tools.expand", () => this.toggleToolOutputExpansion());
		this.defaultEditor.onAction("app.thinking.toggle", () => this.toggleThinkingBlockVisibility());
		this.defaultEditor.onAction("app.editor.external", () => this.openExternalEditor());
		this.defaultEditor.onAction("app.message.followUp", () => this.handleFollowUp());
		this.defaultEditor.onAction("app.message.dequeue", () => this.handleDequeue());
		this.defaultEditor.onAction("app.session.new", () => this.handleClearCommand());
		this.defaultEditor.onAction("app.session.tree", () => this.showTreeSelector());
		this.defaultEditor.onAction("app.session.fork", () => this.showUserMessageSelector());
		this.defaultEditor.onAction("app.session.resume", () => this.showSessionSelector());

		this.defaultEditor.onChange = (text: string) => {
			const wasBashMode = this.isBashMode;
			this.isBashMode = text.trimStart().startsWith("!");
			if (wasBashMode !== this.isBashMode) {
				this.updateEditorBorderColor();
			}
		};

		// Handle clipboard image paste (triggered on Ctrl+V)
		this.defaultEditor.onPasteImage = () => {
			this.handleClipboardImagePaste();
		};
	}

	private async handleClipboardImagePaste(): Promise<void> {
		try {
			const image = await readClipboardImage();
			if (!image) {
				return;
			}

			// Write to temp file
			const tmpDir = os.tmpdir();
			const ext = extensionForImageMimeType(image.mimeType) ?? "png";
			const fileName = `hirocode-clipboard-${crypto.randomUUID()}.${ext}`;
			const filePath = path.join(tmpDir, fileName);
			fs.writeFileSync(filePath, Buffer.from(image.bytes));

			// Insert file path directly
			this.editor.insertTextAtCursor?.(filePath);
			this.ui.requestRender();
		} catch {
			// Silently ignore clipboard errors (may not have permission, etc.)
		}
	}

	private setupEditorSubmitHandler(): void {
		this.defaultEditor.onSubmit = async (text: string) => {
			text = text.trim();
			if (!text) return;

			// Handle commands
			if (text === "/settings") {
				this.showSettingsSelector();
				this.editor.setText("");
				return;
			}
			if (text === "/scoped-models") {
				this.editor.setText("");
				await this.showModelsSelector();
				return;
			}
			if (text === "/model" || text.startsWith("/model ")) {
				const searchTerm = text.startsWith("/model ") ? text.slice(7).trim() : undefined;
				this.editor.setText("");
				await this.handleModelCommand(searchTerm);
				return;
			}
			if (text.startsWith("/export")) {
				await this.handleExportCommand(text);
				this.editor.setText("");
				return;
			}
			if (text.startsWith("/import")) {
				await this.handleImportCommand(text);
				this.editor.setText("");
				return;
			}
			if (text === "/share") {
				await this.handleShareCommand();
				this.editor.setText("");
				return;
			}
			if (text === "/copy") {
				await this.handleCopyCommand();
				this.editor.setText("");
				return;
			}
			if (text === "/name" || text.startsWith("/name ")) {
				this.handleNameCommand(text);
				this.editor.setText("");
				return;
			}
			if (text === "/session") {
				this.handleSessionCommand();
				this.editor.setText("");
				return;
			}
			if (text === "/changelog") {
				this.handleChangelogCommand();
				this.editor.setText("");
				return;
			}
			if (text === "/hotkeys") {
				this.handleHotkeysCommand();
				this.editor.setText("");
				return;
			}
			if (text === "/fork") {
				this.showUserMessageSelector();
				this.editor.setText("");
				return;
			}
			if (text === "/tree") {
				this.showTreeSelector();
				this.editor.setText("");
				return;
			}
			if (text === "/login") {
				this.showOAuthSelector("login");
				this.editor.setText("");
				return;
			}
			if (text === "/logout") {
				this.showOAuthSelector("logout");
				this.editor.setText("");
				return;
			}
			if (text === "/new") {
				this.editor.setText("");
				await this.handleClearCommand();
				return;
			}
			if (text === "/compact" || text.startsWith("/compact ")) {
				const customInstructions = text.startsWith("/compact ") ? text.slice(9).trim() : undefined;
				this.editor.setText("");
				await this.handleCompactCommand(customInstructions);
				return;
			}
			if (text === "/reload") {
				this.editor.setText("");
				await this.handleReloadCommand();
				return;
			}
			if (text === "/debug") {
				this.handleDebugCommand();
				this.editor.setText("");
				return;
			}
			if (text === "/arminsayshi") {
				this.handleArminSaysHi();
				this.editor.setText("");
				return;
			}
			if (text === "/resume") {
				this.showSessionSelector();
				this.editor.setText("");
				return;
			}
			if (text === "/subagents" || text.startsWith("/subagents ")) {
				this.editor.setText("");
				await this.handleSubagentsCommand(text);
				return;
			}
			if (text === "/mission" || text.startsWith("/mission ")) {
				this.editor.setText("");
				await this.handleMissionCommand(text);
				return;
			}
			if (text === "/enter-mission" || text.startsWith("/enter-mission ")) {
				const goal = text.slice("/enter-mission".length).trim();
				this.editor.setText("");
				await this.handleMissionCommand(goal ? `/mission ${goal}` : "/mission");
				return;
			}
			if (text === "/missions") {
				this.editor.setText("");
				await this.handleMissionsCommand();
				return;
			}
			if (text === "/agents") {
				this.editor.setText("");
				await this.handleAgentsCommand();
				return;
			}
			if (text === "/spec" || text.startsWith("/spec ")) {
				this.editor.setText("");
				await this.handleSpecCommand(text);
				return;
			}
			if (text === "/approvals") {
				this.editor.setText("");
				await this.handleApprovalsCommand();
				return;
			}
			if (text === "/mcp") {
				this.editor.setText("");
				await this.handleMcpCommand();
				return;
			}
			if (text === "/quit") {
				this.editor.setText("");
				await this.shutdown();
				return;
			}

			if (this.isViewingDetachedSession()) {
				this.showWarning(
					"Viewing a detached child session. Use /subagents to switch views or /resume to attach before sending new input.",
				);
				return;
			}

			// Handle bash command (! for normal, !! for excluded from context)
			if (text.startsWith("!")) {
				const isExcluded = text.startsWith("!!");
				const command = isExcluded ? text.slice(2).trim() : text.slice(1).trim();
				if (command) {
					if (this.session.isBashRunning) {
						this.showWarning("A bash command is already running. Press Esc to cancel it first.");
						this.editor.setText(text);
						return;
					}
					this.editor.addToHistory?.(text);
					await this.handleBashCommand(command, isExcluded);
					this.isBashMode = false;
					this.updateEditorBorderColor();
					return;
				}
			}

			// Queue input during compaction (extension commands execute immediately)
			if (this.session.isCompacting) {
				if (this.isExtensionCommand(text)) {
					this.editor.addToHistory?.(text);
					this.editor.setText("");
					await this.session.prompt(text);
				} else {
					this.queueCompactionMessage(text, "steer");
				}
				return;
			}

			// If streaming, use prompt() with steer behavior
			// This handles extension commands (execute immediately), prompt template expansion, and queueing
			if (this.session.isStreaming) {
				this.editor.addToHistory?.(text);
				this.editor.setText("");
				await this.withSpecContextPrompt(text, { streamingBehavior: "steer" });
				this.updatePendingMessagesDisplay();
				this.ui.requestRender();
				return;
			}

			// Normal message submission
			// First, move any pending bash components to chat
			this.flushPendingBashComponents();

			if (this.onInputCallback) {
				this.onInputCallback(text);
			}
			this.editor.addToHistory?.(text);
		};
	}

	private subscribeToAgent(): void {
		this.unsubscribe = this.session.subscribe(async (event) => {
			await this.handleEvent(event);
		});
	}

	private async handleEvent(event: AgentSessionEvent): Promise<void> {
		if (!this.isInitialized) {
			await this.init();
		}

		if (
			this.isViewingDetachedSession() &&
			(event.type === "message_start" ||
				event.type === "message_update" ||
				event.type === "message_end" ||
				event.type === "tool_execution_start" ||
				event.type === "tool_execution_update" ||
				event.type === "tool_execution_end")
		) {
			this.captureDetachedActiveSessionEvent(event);
			return;
		}

		this.footer.invalidate();

		switch (event.type) {
			case "agent_start":
				// Restore main escape handler if retry handler is still active
				// (retry success event fires later, but we need main handler now)
				if (this.retryEscapeHandler) {
					this.defaultEditor.onEscape = this.retryEscapeHandler;
					this.retryEscapeHandler = undefined;
				}
				if (this.retryLoader) {
					this.retryLoader.stop();
					this.retryLoader = undefined;
				}
				if (this.loadingAnimation) {
					this.loadingAnimation.stop();
				}
				this.statusContainer.clear();
				this.loadingAnimation = new Loader(
					this.ui,
					(spinner) => theme.fg("accent", spinner),
					(text) => theme.fg("muted", text),
					this.defaultWorkingMessage,
				);
				this.statusContainer.addChild(this.loadingAnimation);
				// Apply any pending working message queued before loader existed
				if (this.pendingWorkingMessage !== undefined) {
					if (this.pendingWorkingMessage) {
						this.loadingAnimation.setMessage(this.pendingWorkingMessage);
					}
					this.pendingWorkingMessage = undefined;
				}
				this.startWorkingSessionTimer();
				this.ui.requestRender();
				break;

			case "message_start":
				if (event.message.role === "custom") {
					if (event.message.customType === "spec-plan") {
						this.clearStreamingSpecPlan();
					}
					this.addMessageToChat(event.message);
					this.ui.requestRender();
				} else if (event.message.role === "user") {
					this.addMessageToChat(event.message);
					this.updatePendingMessagesDisplay();
					this.ui.requestRender();
				} else if (event.message.role === "assistant") {
					this.clearStreamingSpecPlan();
					this.streamingComponent = new AssistantMessageComponent(
						undefined,
						this.hideThinkingBlock,
						this.getMarkdownThemeWithSettings(),
					);
					this.streamingMessage = this.buildVisibleAssistantMessage(event.message);
					this.chatContainer.addChild(this.streamingComponent);
					this.streamingComponent.updateContent(this.streamingMessage);
					this.ui.requestRender();
				}
				break;

			case "message_update":
				if (this.streamingComponent && event.message.role === "assistant") {
					this.streamingMessage = this.buildVisibleAssistantMessage(event.message);
					this.streamingComponent.updateContent(this.streamingMessage);

					for (const content of this.streamingMessage.content) {
						if (content.type === "toolCall") {
							if (!this.pendingTools.has(content.id)) {
								const component = new ToolExecutionComponent(
									content.name,
									content.id,
									content.arguments,
									{
										showImages: this.settingsManager.getShowImages(),
									},
									this.getRegisteredToolDefinition(content.name),
									this.ui,
								);
								component.setExpanded(this.toolOutputExpanded);
								this.chatContainer.addChild(component);
								this.pendingTools.set(content.id, component);
							} else {
								const component = this.pendingTools.get(content.id);
								if (component) {
									component.updateArgs(content.arguments);
								}
							}
						}
					}
					this.ui.requestRender();
				}
				break;

			case "message_end":
				if (event.message.role === "user") break;
				if (this.streamingComponent && event.message.role === "assistant") {
					this.streamingMessage = this.buildVisibleAssistantMessage(event.message);
					let errorMessage: string | undefined;
					if (this.streamingMessage.stopReason === "aborted") {
						const retryAttempt = this.session.retryAttempt;
						errorMessage =
							retryAttempt > 0
								? `Aborted after ${retryAttempt} retry attempt${retryAttempt > 1 ? "s" : ""}`
								: "Operation aborted";
						this.streamingMessage.errorMessage = errorMessage;
					}
					this.streamingComponent.updateContent(this.streamingMessage);

					if (this.streamingMessage.stopReason === "aborted" || this.streamingMessage.stopReason === "error") {
						if (!errorMessage) {
							errorMessage = this.streamingMessage.errorMessage || "Error";
						}
						for (const [, component] of this.pendingTools.entries()) {
							component.updateResult({
								content: [{ type: "text", text: errorMessage }],
								isError: true,
							});
						}
						this.pendingTools.clear();
					} else {
						// Args are now complete - trigger diff computation for edit tools
						for (const [, component] of this.pendingTools.entries()) {
							component.setArgsComplete();
						}
					}
					this.streamingComponent = undefined;
					this.streamingMessage = undefined;
					if (event.message.stopReason === "aborted" || event.message.stopReason === "error") {
						this.clearStreamingSpecPlan();
					}
					this.footer.invalidate();
				}
				this.ui.requestRender();
				break;

			case "tool_execution_start": {
				let component = this.pendingTools.get(event.toolCallId);
				if (!component) {
					component = new ToolExecutionComponent(
						event.toolName,
						event.toolCallId,
						event.args,
						{
							showImages: this.settingsManager.getShowImages(),
						},
						this.getRegisteredToolDefinition(event.toolName),
						this.ui,
					);
					component.setExpanded(this.toolOutputExpanded);
					this.chatContainer.addChild(component);
					this.pendingTools.set(event.toolCallId, component);
				}
				component.markExecutionStarted();
				this.ui.requestRender();
				break;
			}

			case "tool_execution_update": {
				const component = this.pendingTools.get(event.toolCallId);
				if (component) {
					component.updateResult({ ...event.partialResult, isError: false }, true);
					this.ui.requestRender();
				}
				break;
			}

			case "tool_execution_end": {
				const component = this.pendingTools.get(event.toolCallId);
				if (component) {
					component.updateResult({ ...event.result, isError: event.isError });
					this.pendingTools.delete(event.toolCallId);
					this.ui.requestRender();
				}
				break;
			}

			case "agent_end":
				this.stopWorkingSessionTimer();
				if (this.loadingAnimation) {
					this.loadingAnimation.stop();
					this.loadingAnimation = undefined;
					this.statusContainer.clear();
				}
				if (this.streamingComponent) {
					this.chatContainer.removeChild(this.streamingComponent);
					this.streamingComponent = undefined;
					this.streamingMessage = undefined;
				}
				this.pendingTools.clear();
				this.clearDetachedActiveSessionState();
				await this.maybeHandleMissionPlan(event);
				await this.maybeHandleSpecExecutionCompletion(event);
				await this.maybeHandleSpecPlan(event);

				await this.checkShutdownRequested();

				this.ui.requestRender();
				break;

			case "auto_compaction_start": {
				// Keep editor active; submissions are queued during compaction.
				// Set up escape to abort auto-compaction
				this.autoCompactionEscapeHandler = this.defaultEditor.onEscape;
				this.defaultEditor.onEscape = () => {
					this.session.abortCompaction();
				};
				// Show compacting indicator with reason
				this.statusContainer.clear();
				const reasonText = event.reason === "overflow" ? "Context overflow detected, " : "";
				this.autoCompactionLoader = new Loader(
					this.ui,
					(spinner) => theme.fg("accent", spinner),
					(text) => theme.fg("muted", text),
					`${reasonText}Auto-compacting... (${keyText("app.interrupt")} to cancel)`,
				);
				this.statusContainer.addChild(this.autoCompactionLoader);
				this.ui.requestRender();
				break;
			}

			case "auto_compaction_end": {
				// Restore escape handler
				if (this.autoCompactionEscapeHandler) {
					this.defaultEditor.onEscape = this.autoCompactionEscapeHandler;
					this.autoCompactionEscapeHandler = undefined;
				}
				// Stop loader
				if (this.autoCompactionLoader) {
					this.autoCompactionLoader.stop();
					this.autoCompactionLoader = undefined;
					this.statusContainer.clear();
				}
				if (this.isViewingDetachedSession()) {
					void this.flushCompactionQueue({ willRetry: event.willRetry });
					this.ui.requestRender();
					break;
				}
				// Handle result
				if (event.aborted) {
					this.showStatus("Auto-compaction cancelled");
				} else if (event.result) {
					// Rebuild chat to show compacted state
					this.chatContainer.clear();
					this.rebuildChatFromMessages();
					// Add compaction component at bottom so user sees it without scrolling
					this.addMessageToChat({
						role: "compactionSummary",
						tokensBefore: event.result.tokensBefore,
						summary: event.result.summary,
						timestamp: Date.now(),
					});
					this.footer.invalidate();
				} else if (event.errorMessage) {
					// Compaction failed (e.g., quota exceeded, API error)
					this.chatContainer.addChild(new Spacer(1));
					this.chatContainer.addChild(new Text(theme.fg("error", event.errorMessage), 1, 0));
				}
				void this.flushCompactionQueue({ willRetry: event.willRetry });
				this.ui.requestRender();
				break;
			}

			case "auto_retry_start": {
				// Set up escape to abort retry
				this.retryEscapeHandler = this.defaultEditor.onEscape;
				this.defaultEditor.onEscape = () => {
					this.session.abortRetry();
				};
				// Show retry indicator
				this.statusContainer.clear();
				const delaySeconds = Math.round(event.delayMs / 1000);
				this.retryLoader = new Loader(
					this.ui,
					(spinner) => theme.fg("warning", spinner),
					(text) => theme.fg("muted", text),
					`Retrying (${event.attempt}/${event.maxAttempts}) in ${delaySeconds}s... (${keyText("app.interrupt")} to cancel)`,
				);
				this.statusContainer.addChild(this.retryLoader);
				this.ui.requestRender();
				break;
			}

			case "auto_retry_end": {
				// Restore escape handler
				if (this.retryEscapeHandler) {
					this.defaultEditor.onEscape = this.retryEscapeHandler;
					this.retryEscapeHandler = undefined;
				}
				// Stop loader
				if (this.retryLoader) {
					this.retryLoader.stop();
					this.retryLoader = undefined;
					this.statusContainer.clear();
				}
				// Show error only on final failure (success shows normal response)
				if (!event.success) {
					this.showError(`Retry failed after ${event.attempt} attempts: ${event.finalError || "Unknown error"}`);
				}
				await this.maybeHandleSpecRetryFailure(event);
				this.ui.requestRender();
				break;
			}
		}
	}

	/** Extract text content from a user message */
	private getUserMessageText(message: Message): string {
		if (message.role !== "user") return "";
		const textBlocks =
			typeof message.content === "string"
				? [{ type: "text", text: message.content }]
				: message.content.filter((c: { type: string }) => c.type === "text");
		return textBlocks.map((c) => (c as { text: string }).text).join("");
	}

	/**
	 * Show a status message in the chat.
	 *
	 * If multiple status messages are emitted back-to-back (without anything else being added to the chat),
	 * we update the previous status line instead of appending new ones to avoid log spam.
	 */
	private showStatus(message: string): void {
		const children = this.chatContainer.children;
		const last = children.length > 0 ? children[children.length - 1] : undefined;
		const secondLast = children.length > 1 ? children[children.length - 2] : undefined;

		if (last && secondLast && last === this.lastStatusText && secondLast === this.lastStatusSpacer) {
			this.lastStatusText.setText(theme.fg("dim", message));
			this.ui.requestRender();
			return;
		}

		const spacer = new Spacer(1);
		const text = new Text(theme.fg("dim", message), 1, 0);
		this.chatContainer.addChild(spacer);
		this.chatContainer.addChild(text);
		this.lastStatusSpacer = spacer;
		this.lastStatusText = text;
		this.ui.requestRender();
	}

	private addMessageToChat(message: AgentMessage, options?: { populateHistory?: boolean }): void {
		switch (message.role) {
			case "bashExecution": {
				const component = new BashExecutionComponent(message.command, this.ui, message.excludeFromContext);
				if (message.output) {
					component.appendOutput(message.output);
				}
				component.setComplete(
					message.exitCode,
					message.cancelled,
					message.truncated ? ({ truncated: true } as TruncationResult) : undefined,
					message.fullOutputPath,
				);
				this.chatContainer.addChild(component);
				break;
			}
			case "custom": {
				if (message.display) {
					const renderer = this.getCustomMessageRenderer(message.customType);
					const component = new CustomMessageComponent(message, renderer, this.getMarkdownThemeWithSettings());
					component.setExpanded(this.toolOutputExpanded);
					this.chatContainer.addChild(component);
				}
				break;
			}
			case "compactionSummary": {
				this.chatContainer.addChild(new Spacer(1));
				const component = new CompactionSummaryMessageComponent(message, this.getMarkdownThemeWithSettings());
				component.setExpanded(this.toolOutputExpanded);
				this.chatContainer.addChild(component);
				break;
			}
			case "branchSummary": {
				this.chatContainer.addChild(new Spacer(1));
				const component = new BranchSummaryMessageComponent(message, this.getMarkdownThemeWithSettings());
				component.setExpanded(this.toolOutputExpanded);
				this.chatContainer.addChild(component);
				break;
			}
			case "user": {
				const textContent = this.getUserMessageText(message);
				if (textContent) {
					const skillBlock = parseSkillBlock(textContent);
					if (skillBlock) {
						// Render skill block (collapsible)
						this.chatContainer.addChild(new Spacer(1));
						const component = new SkillInvocationMessageComponent(
							skillBlock,
							this.getMarkdownThemeWithSettings(),
						);
						component.setExpanded(this.toolOutputExpanded);
						this.chatContainer.addChild(component);
						// Render user message separately if present
						if (skillBlock.userMessage) {
							const userComponent = new UserMessageComponent(
								skillBlock.userMessage,
								this.getMarkdownThemeWithSettings(),
							);
							this.chatContainer.addChild(userComponent);
						}
					} else {
						const userComponent = new UserMessageComponent(textContent, this.getMarkdownThemeWithSettings());
						this.chatContainer.addChild(userComponent);
					}
					if (options?.populateHistory) {
						this.editor.addToHistory?.(textContent);
					}
				}
				break;
			}
			case "assistant": {
				const assistantComponent = new AssistantMessageComponent(
					message,
					this.hideThinkingBlock,
					this.getMarkdownThemeWithSettings(),
				);
				this.chatContainer.addChild(assistantComponent);
				break;
			}
			case "toolResult": {
				// Tool results are rendered inline with tool calls, handled separately
				break;
			}
			default: {
				const _exhaustive: never = message;
			}
		}
	}

	/**
	 * Render session context to chat. Used for initial load and rebuild after compaction.
	 * @param sessionContext Session context to render
	 * @param options.updateFooter Update footer state
	 * @param options.populateHistory Add user messages to editor history
	 */
	private renderSessionContext(
		sessionContext: SessionContext,
		options: { updateFooter?: boolean; populateHistory?: boolean } = {},
	): void {
		this.pendingTools.clear();

		if (options.updateFooter) {
			this.footer.invalidate();
			this.updateEditorBorderColor();
		}

		for (const message of sessionContext.messages) {
			// Assistant messages need special handling for tool calls
			if (message.role === "assistant") {
				this.addMessageToChat(message);
				// Render tool call components
				for (const content of message.content) {
					if (content.type === "toolCall") {
						const component = new ToolExecutionComponent(
							content.name,
							content.id,
							content.arguments,
							{ showImages: this.settingsManager.getShowImages() },
							this.getRegisteredToolDefinition(content.name),
							this.ui,
						);
						component.setExpanded(this.toolOutputExpanded);
						this.chatContainer.addChild(component);

						if (message.stopReason === "aborted" || message.stopReason === "error") {
							let errorMessage: string;
							if (message.stopReason === "aborted") {
								const retryAttempt = this.session.retryAttempt;
								errorMessage =
									retryAttempt > 0
										? `Aborted after ${retryAttempt} retry attempt${retryAttempt > 1 ? "s" : ""}`
										: "Operation aborted";
							} else {
								errorMessage = message.errorMessage || "Error";
							}
							component.updateResult({ content: [{ type: "text", text: errorMessage }], isError: true });
						} else {
							this.pendingTools.set(content.id, component);
						}
					}
				}
			} else if (message.role === "toolResult") {
				// Match tool results to pending tool components
				const component = this.pendingTools.get(message.toolCallId);
				if (component) {
					component.updateResult(message);
					this.pendingTools.delete(message.toolCallId);
				}
			} else {
				// All other messages use standard rendering
				this.addMessageToChat(message, options);
			}
		}

		this.pendingTools.clear();
		this.ui.requestRender();
	}

	renderInitialMessages(): void {
		const renderSessionManager = this.getDisplaySessionManager();
		this.chatContainer.clear();
		if (this.isViewingDetachedSession()) {
			this.renderDetachedSessionBanner();
		}

		const context = renderSessionManager.buildSessionContext();
		this.renderSessionContext(context, {
			updateFooter: !this.isViewingDetachedSession(),
			populateHistory: !this.isViewingDetachedSession(),
		});

		// Show compaction info if session was compacted
		const allEntries = renderSessionManager.getEntries();
		const compactionCount = allEntries.filter((e) => e.type === "compaction").length;
		if (compactionCount > 0) {
			const times = compactionCount === 1 ? "1 time" : `${compactionCount} times`;
			this.showStatus(`Session compacted ${times}`);
		}
	}

	async getUserInput(): Promise<string> {
		return new Promise((resolve) => {
			this.onInputCallback = (text: string) => {
				this.onInputCallback = undefined;
				resolve(text);
			};
		});
	}

	private rebuildChatFromMessages(): void {
		this.chatContainer.clear();
		if (this.isViewingDetachedSession()) {
			this.renderDetachedSessionBanner();
		}
		const context = this.getDisplaySessionManager().buildSessionContext();
		this.renderSessionContext(context);
	}

	// =========================================================================
	// Key handlers
	// =========================================================================

	private handleCtrlC(): void {
		const now = Date.now();
		if (now - this.lastSigintTime < 500) {
			void this.shutdown();
		} else {
			this.clearEditor();
			this.lastSigintTime = now;
		}
	}

	private handleCtrlD(): void {
		// Only called when editor is empty (enforced by CustomEditor)
		void this.shutdown();
	}

	/**
	 * Gracefully shutdown the agent.
	 * Emits shutdown event to extensions, then exits.
	 */
	private isShuttingDown = false;

	private async shutdown(): Promise<void> {
		if (this.isShuttingDown) return;
		this.isShuttingDown = true;

		// Emit shutdown event to extensions
		const extensionRunner = this.session.extensionRunner;
		if (extensionRunner?.hasHandlers("session_shutdown")) {
			await extensionRunner.emit({
				type: "session_shutdown",
			});
		}

		// Wait for any pending renders to complete
		// requestRender() uses process.nextTick(), so we wait one tick
		await new Promise((resolve) => process.nextTick(resolve));

		// Drain any in-flight Kitty key release events before stopping.
		// This prevents escape sequences from leaking to the parent shell over slow SSH.
		await this.ui.terminal.drainInput(1000);

		this.stop();
		process.exit(0);
	}

	/**
	 * Check if shutdown was requested and perform shutdown if so.
	 */
	private async checkShutdownRequested(): Promise<void> {
		if (!this.shutdownRequested) return;
		await this.shutdown();
	}

	private handleCtrlZ(): void {
		// Keep the event loop alive while suspended. Without this, stopping the TUI
		// can leave Node with no ref'ed handles, causing the process to exit on fg
		// before the SIGCONT handler gets a chance to restore the terminal.
		const suspendKeepAlive = setInterval(() => {}, 2 ** 30);

		// Ignore SIGINT while suspended so Ctrl+C in the terminal does not
		// kill the backgrounded process. The handler is removed on resume.
		const ignoreSigint = () => {};
		process.on("SIGINT", ignoreSigint);

		// Set up handler to restore TUI when resumed
		process.once("SIGCONT", () => {
			clearInterval(suspendKeepAlive);
			process.removeListener("SIGINT", ignoreSigint);
			this.ui.start();
			this.ui.requestRender(true);
		});

		try {
			// Stop the TUI (restore terminal to normal mode)
			this.ui.stop();

			// Send SIGTSTP to process group (pid=0 means all processes in group)
			process.kill(0, "SIGTSTP");
		} catch (error) {
			clearInterval(suspendKeepAlive);
			process.removeListener("SIGINT", ignoreSigint);
			throw error;
		}
	}

	private async handleFollowUp(): Promise<void> {
		const text = (this.editor.getExpandedText?.() ?? this.editor.getText()).trim();
		if (!text) return;

		// Queue input during compaction (extension commands execute immediately)
		if (this.session.isCompacting) {
			if (this.isExtensionCommand(text)) {
				this.editor.addToHistory?.(text);
				this.editor.setText("");
				await this.session.prompt(text);
			} else {
				this.queueCompactionMessage(text, "followUp");
			}
			return;
		}

		// Alt+Enter queues a follow-up message (waits until agent finishes)
		// This handles extension commands (execute immediately), prompt template expansion, and queueing
		if (this.session.isStreaming) {
			this.editor.addToHistory?.(text);
			this.editor.setText("");
			await this.withSpecContextPrompt(text, { streamingBehavior: "followUp" });
			this.updatePendingMessagesDisplay();
			this.ui.requestRender();
		}
		// If not streaming, Alt+Enter acts like regular Enter (trigger onSubmit)
		else if (this.editor.onSubmit) {
			this.editor.onSubmit(text);
		}
	}

	private handleDequeue(): void {
		const restored = this.restoreQueuedMessagesToEditor();
		if (restored === 0) {
			this.showStatus("No queued messages to restore");
		} else {
			this.showStatus(`Restored ${restored} queued message${restored > 1 ? "s" : ""} to editor`);
		}
	}

	private updateEditorBorderColor(): void {
		if (this.isBashMode) {
			this.editor.borderColor = theme.getBashModeBorderColor();
		} else if (this.isSpecMaskEnabled()) {
			this.editor.borderColor = (text: string) => theme.fg(this.getSpecThemeColor(), text);
		} else {
			const level = this.session.thinkingLevel || "off";
			this.editor.borderColor = theme.getThinkingBorderColor(level);
		}
		this.ui.requestRender();
	}

	private cycleThinkingLevel(): void {
		const newLevel = this.session.cycleThinkingLevel();
		if (newLevel === undefined) {
			this.showStatus("Current model does not support thinking");
		} else {
			this.footer.invalidate();
			this.updateEditorBorderColor();
			this.showStatus(`Thinking level: ${newLevel}`);
		}
	}

	private async cycleModel(direction: "forward" | "backward"): Promise<void> {
		try {
			const result = await this.session.cycleModel(direction);
			if (result === undefined) {
				const msg = this.session.scopedModels.length > 0 ? "Only one model in scope" : "Only one model available";
				this.showStatus(msg);
			} else {
				this.footer.invalidate();
				this.updateEditorBorderColor();
				const thinkingStr =
					result.model.reasoning && result.thinkingLevel !== "off" ? ` (thinking: ${result.thinkingLevel})` : "";
				this.showStatus(`Switched to ${result.model.name || result.model.id}${thinkingStr}`);
			}
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private toggleToolOutputExpansion(): void {
		this.setToolsExpanded(!this.toolOutputExpanded);
	}

	private setToolsExpanded(expanded: boolean): void {
		this.toolOutputExpanded = expanded;
		for (const child of this.chatContainer.children) {
			if (isExpandable(child)) {
				child.setExpanded(expanded);
			}
		}
		this.ui.requestRender();
	}

	private toggleThinkingBlockVisibility(): void {
		this.hideThinkingBlock = !this.hideThinkingBlock;
		this.settingsManager.setHideThinkingBlock(this.hideThinkingBlock);

		// Rebuild chat from session messages
		this.chatContainer.clear();
		this.rebuildChatFromMessages();

		// If streaming, re-add the streaming component with updated visibility and re-render
		if (this.streamingComponent && this.streamingMessage) {
			this.streamingComponent.setHideThinkingBlock(this.hideThinkingBlock);
			this.streamingComponent.updateContent(this.streamingMessage);
			this.chatContainer.addChild(this.streamingComponent);
		}

		this.showStatus(`Thinking blocks: ${this.hideThinkingBlock ? "hidden" : "visible"}`);
	}

	private openExternalEditor(): void {
		// Determine editor (respect $VISUAL, then $EDITOR)
		const editorCmd = process.env.VISUAL || process.env.EDITOR;
		if (!editorCmd) {
			this.showWarning("No editor configured. Set $VISUAL or $EDITOR environment variable.");
			return;
		}

		const currentText = this.editor.getExpandedText?.() ?? this.editor.getText();
		const tmpFile = path.join(os.tmpdir(), `hirocode-editor-${Date.now()}.hirocode.md`);

		try {
			// Write current content to temp file
			fs.writeFileSync(tmpFile, currentText, "utf-8");

			// Stop TUI to release terminal
			this.ui.stop();

			// Split by space to support editor arguments (e.g., "code --wait")
			const [editor, ...editorArgs] = editorCmd.split(" ");

			// Spawn editor synchronously with inherited stdio for interactive editing
			const result = spawnSync(editor, [...editorArgs, tmpFile], {
				stdio: "inherit",
				shell: process.platform === "win32",
			});

			// On successful exit (status 0), replace editor content
			if (result.status === 0) {
				const newContent = fs.readFileSync(tmpFile, "utf-8").replace(/\n$/, "");
				this.editor.setText(newContent);
			}
			// On non-zero exit, keep original text (no action needed)
		} finally {
			// Clean up temp file
			try {
				fs.unlinkSync(tmpFile);
			} catch {
				// Ignore cleanup errors
			}

			// Restart TUI
			this.ui.start();
			// Force full re-render since external editor uses alternate screen
			this.ui.requestRender(true);
		}
	}

	// =========================================================================
	// UI helpers
	// =========================================================================

	clearEditor(): void {
		this.editor.setText("");
		this.ui.requestRender();
	}

	showError(errorMessage: string): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg("error", `Error: ${errorMessage}`), 1, 0));
		this.ui.requestRender();
	}

	showWarning(warningMessage: string): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg("warning", `Warning: ${warningMessage}`), 1, 0));
		this.ui.requestRender();
	}

	showNewVersionNotification(newVersion: string): void {
		const action = theme.fg("accent", getUpdateInstruction(PACKAGE_NAME));
		const updateInstruction = theme.fg("muted", `New version ${newVersion} is available. `) + action;
		const changelogLine = theme.fg("muted", "Changelog: use /changelog in the CLI for details.");

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
		this.chatContainer.addChild(
			new Text(
				`${theme.bold(theme.fg("warning", "Update Available"))}\n${updateInstruction}\n${changelogLine}`,
				1,
				0,
			),
		);
		this.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
		this.ui.requestRender();
	}

	showPackageUpdateNotification(packages: string[]): void {
		const action = theme.fg("accent", `${APP_NAME} update`);
		const updateInstruction = theme.fg("muted", "Package updates are available. Run ") + action;
		const packageLines = packages.map((pkg) => `- ${pkg}`).join("\n");

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
		this.chatContainer.addChild(
			new Text(
				`${theme.bold(theme.fg("warning", "Package Updates Available"))}\n${updateInstruction}\n${theme.fg("muted", "Packages:")}\n${packageLines}`,
				1,
				0,
			),
		);
		this.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
		this.ui.requestRender();
	}

	/**
	 * Get all queued messages (read-only).
	 * Combines session queue and compaction queue.
	 */
	private getAllQueuedMessages(): { steering: string[]; followUp: string[] } {
		return {
			steering: [
				...this.session.getSteeringMessages(),
				...this.compactionQueuedMessages.filter((msg) => msg.mode === "steer").map((msg) => msg.text),
			],
			followUp: [
				...this.session.getFollowUpMessages(),
				...this.compactionQueuedMessages.filter((msg) => msg.mode === "followUp").map((msg) => msg.text),
			],
		};
	}

	/**
	 * Clear all queued messages and return their contents.
	 * Clears both session queue and compaction queue.
	 */
	private clearAllQueues(): { steering: string[]; followUp: string[] } {
		const { steering, followUp } = this.session.clearQueue();
		const compactionSteering = this.compactionQueuedMessages
			.filter((msg) => msg.mode === "steer")
			.map((msg) => msg.text);
		const compactionFollowUp = this.compactionQueuedMessages
			.filter((msg) => msg.mode === "followUp")
			.map((msg) => msg.text);
		this.compactionQueuedMessages = [];
		return {
			steering: [...steering, ...compactionSteering],
			followUp: [...followUp, ...compactionFollowUp],
		};
	}

	private updatePendingMessagesDisplay(): void {
		this.pendingMessagesContainer.clear();
		const { steering: steeringMessages, followUp: followUpMessages } = this.getAllQueuedMessages();
		if (steeringMessages.length > 0 || followUpMessages.length > 0) {
			this.pendingMessagesContainer.addChild(new Spacer(1));
			for (const message of steeringMessages) {
				const text = theme.fg("dim", `Steering: ${message}`);
				this.pendingMessagesContainer.addChild(new TruncatedText(text, 1, 0));
			}
			for (const message of followUpMessages) {
				const text = theme.fg("dim", `Follow-up: ${message}`);
				this.pendingMessagesContainer.addChild(new TruncatedText(text, 1, 0));
			}
			const dequeueHint = this.getAppKeyDisplay("app.message.dequeue");
			const hintText = theme.fg("dim", `↳ ${dequeueHint} to edit all queued messages`);
			this.pendingMessagesContainer.addChild(new TruncatedText(hintText, 1, 0));
		}
	}

	private restoreQueuedMessagesToEditor(options?: { abort?: boolean; currentText?: string }): number {
		const { steering, followUp } = this.clearAllQueues();
		const allQueued = [...steering, ...followUp];
		if (allQueued.length === 0) {
			this.updatePendingMessagesDisplay();
			if (options?.abort) {
				this.agent.abort();
			}
			return 0;
		}
		const queuedText = allQueued.join("\n\n");
		const currentText = options?.currentText ?? this.editor.getText();
		const combinedText = [queuedText, currentText].filter((t) => t.trim()).join("\n\n");
		this.editor.setText(combinedText);
		this.updatePendingMessagesDisplay();
		if (options?.abort) {
			this.agent.abort();
		}
		return allQueued.length;
	}

	private queueCompactionMessage(text: string, mode: "steer" | "followUp"): void {
		this.compactionQueuedMessages.push({ text, mode });
		this.editor.addToHistory?.(text);
		this.editor.setText("");
		this.updatePendingMessagesDisplay();
		this.showStatus("Queued message for after compaction");
	}

	private isExtensionCommand(text: string): boolean {
		if (!text.startsWith("/")) return false;

		const extensionRunner = this.session.extensionRunner;
		if (!extensionRunner) return false;

		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		return !!extensionRunner.getCommand(commandName);
	}

	private async flushCompactionQueue(options?: { willRetry?: boolean }): Promise<void> {
		if (this.compactionQueuedMessages.length === 0) {
			return;
		}

		const queuedMessages = [...this.compactionQueuedMessages];
		this.compactionQueuedMessages = [];
		this.updatePendingMessagesDisplay();

		const restoreQueue = (error: unknown) => {
			this.session.clearQueue();
			this.compactionQueuedMessages = queuedMessages;
			this.updatePendingMessagesDisplay();
			this.showError(
				`Failed to send queued message${queuedMessages.length > 1 ? "s" : ""}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		};

		try {
			if (options?.willRetry) {
				// When retry is pending, queue messages for the retry turn
				for (const message of queuedMessages) {
					if (this.isExtensionCommand(message.text)) {
						await this.session.prompt(message.text);
					} else {
						await this.withSpecContextPrompt(message.text, {
							streamingBehavior: message.mode === "followUp" ? "followUp" : "steer",
						});
					}
				}
				this.updatePendingMessagesDisplay();
				return;
			}

			// Find first non-extension-command message to use as prompt
			const firstPromptIndex = queuedMessages.findIndex((message) => !this.isExtensionCommand(message.text));
			if (firstPromptIndex === -1) {
				// All extension commands - execute them all
				for (const message of queuedMessages) {
					await this.session.prompt(message.text);
				}
				return;
			}

			// Execute any extension commands before the first prompt
			const preCommands = queuedMessages.slice(0, firstPromptIndex);
			const firstPrompt = queuedMessages[firstPromptIndex];
			const rest = queuedMessages.slice(firstPromptIndex + 1);

			for (const message of preCommands) {
				await this.session.prompt(message.text);
			}

			// Send first prompt (starts streaming)
			const promptPromise = this.withSpecContextPrompt(firstPrompt.text).catch((error) => {
				restoreQueue(error);
			});

			// Queue remaining messages
			for (const message of rest) {
				if (this.isExtensionCommand(message.text)) {
					await this.session.prompt(message.text);
				} else {
					await this.withSpecContextPrompt(message.text, {
						streamingBehavior: message.mode === "followUp" ? "followUp" : "steer",
					});
				}
			}
			this.updatePendingMessagesDisplay();
			void promptPromise;
		} catch (error) {
			restoreQueue(error);
		}
	}

	/** Move pending bash components from pending area to chat */
	private flushPendingBashComponents(): void {
		for (const component of this.pendingBashComponents) {
			this.pendingMessagesContainer.removeChild(component);
			this.chatContainer.addChild(component);
		}
		this.pendingBashComponents = [];
	}

	// =========================================================================
	// Selectors
	// =========================================================================

	/**
	 * Shows a selector component in place of the editor.
	 * @param create Factory that receives a `done` callback and returns the component and focus target
	 */
	private showSelector(create: (done: () => void) => { component: Component; focus: Component }): void {
		const done = () => {
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.ui.setFocus(this.editor);
		};
		const { component, focus } = create(done);
		this.editorContainer.clear();
		this.editorContainer.addChild(component);
		this.ui.setFocus(focus);
		this.ui.requestRender();
	}

	private showSettingsSelector(): void {
		this.showSelector((done) => {
			const selector = new SettingsSelectorComponent(
				{
					autoCompact: this.session.autoCompactionEnabled,
					interactiveAutonomyPreset: this.getInteractiveAutonomyPreset(),
					approvalPolicy: this.settingsManager.getApprovalPolicy(),
					sandboxAdapter: this.settingsManager.getSandboxPolicy().adapter ?? "local",
					sandboxEnabled: this.settingsManager.getSandboxPolicy().enabled ?? false,
					showImages: this.settingsManager.getShowImages(),
					autoResizeImages: this.settingsManager.getImageAutoResize(),
					blockImages: this.settingsManager.getBlockImages(),
					enableSkillCommands: this.settingsManager.getEnableSkillCommands(),
					steeringMode: this.session.steeringMode,
					followUpMode: this.session.followUpMode,
					transport: this.settingsManager.getTransport(),
					thinkingLevel: this.session.thinkingLevel,
					availableThinkingLevels: this.session.getAvailableThinkingLevels(),
					currentTheme: this.settingsManager.getTheme() || "dark",
					availableThemes: getAvailableThemes(),
					hideThinkingBlock: this.hideThinkingBlock,
					collapseChangelog: this.settingsManager.getCollapseChangelog(),
					doubleEscapeAction: this.settingsManager.getDoubleEscapeAction(),
					treeFilterMode: this.settingsManager.getTreeFilterMode(),
					showHardwareCursor: this.settingsManager.getShowHardwareCursor(),
					editorPaddingX: this.settingsManager.getEditorPaddingX(),
					autocompleteMaxVisible: this.settingsManager.getAutocompleteMaxVisible(),
					quietStartup: this.settingsManager.getQuietStartup(),
					clearOnShrink: this.settingsManager.getClearOnShrink(),
				},
				{
					onAutoCompactChange: (enabled) => {
						this.session.setAutoCompactionEnabled(enabled);
						this.footer.setAutoCompactEnabled(enabled);
					},
					onInteractiveAutonomyPresetChange: (preset) => {
						const next = this.setPersistentInteractiveAutonomyPreset(preset);
						selector.getSettingsList().updateValue("auto-run", preset);
						selector.getSettingsList().updateValue("approval-policy", next.approvalPolicy);
						this.updateModeBanner();
						this.ui.requestRender();
					},
					onApprovalPolicyChange: (policy) => {
						this.settingsManager.setApprovalPolicy(policy);
						selector
							.getSettingsList()
							.updateValue(
								"auto-run",
								deriveInteractiveAutonomyPreset(policy, this.settingsManager.getAutonomyMode()),
							);
						this.updateModeBanner();
						this.ui.requestRender();
					},
					onSandboxEnabledChange: (enabled) => {
						const current = this.settingsManager.getSandboxPolicy();
						this.settingsManager.setSandboxPolicy({ ...current, enabled });
					},
					onSandboxAdapterChange: (adapter) => {
						const current = this.settingsManager.getSandboxPolicy();
						this.settingsManager.setSandboxPolicy({ ...current, adapter });
					},
					onShowImagesChange: (enabled) => {
						this.settingsManager.setShowImages(enabled);
						for (const child of this.chatContainer.children) {
							if (child instanceof ToolExecutionComponent) {
								child.setShowImages(enabled);
							}
						}
					},
					onAutoResizeImagesChange: (enabled) => {
						this.settingsManager.setImageAutoResize(enabled);
					},
					onBlockImagesChange: (blocked) => {
						this.settingsManager.setBlockImages(blocked);
					},
					onEnableSkillCommandsChange: (enabled) => {
						this.settingsManager.setEnableSkillCommands(enabled);
						this.setupAutocomplete(this.fdPath);
					},
					onSteeringModeChange: (mode) => {
						this.session.setSteeringMode(mode);
					},
					onFollowUpModeChange: (mode) => {
						this.session.setFollowUpMode(mode);
					},
					onTransportChange: (transport) => {
						this.settingsManager.setTransport(transport);
						this.session.agent.setTransport(transport);
					},
					onThinkingLevelChange: (level) => {
						this.session.setThinkingLevel(level);
						this.footer.invalidate();
						this.updateEditorBorderColor();
					},
					onThemeChange: (themeName) => {
						const result = setTheme(themeName, true);
						this.settingsManager.setTheme(themeName);
						this.updateModeBanner();
						this.ui.invalidate();
						if (!result.success) {
							this.showError(`Failed to load theme "${themeName}": ${result.error}\nFell back to dark theme.`);
						}
					},
					onThemePreview: (themeName) => {
						const result = setTheme(themeName, true);
						if (result.success) {
							this.updateModeBanner();
							this.ui.invalidate();
							this.ui.requestRender();
						}
					},
					onHideThinkingBlockChange: (hidden) => {
						this.hideThinkingBlock = hidden;
						this.settingsManager.setHideThinkingBlock(hidden);
						for (const child of this.chatContainer.children) {
							if (child instanceof AssistantMessageComponent) {
								child.setHideThinkingBlock(hidden);
							}
						}
						this.chatContainer.clear();
						this.rebuildChatFromMessages();
					},
					onCollapseChangelogChange: (collapsed) => {
						this.settingsManager.setCollapseChangelog(collapsed);
					},
					onQuietStartupChange: (enabled) => {
						this.settingsManager.setQuietStartup(enabled);
					},
					onDoubleEscapeActionChange: (action) => {
						this.settingsManager.setDoubleEscapeAction(action);
					},
					onTreeFilterModeChange: (mode) => {
						this.settingsManager.setTreeFilterMode(mode);
					},
					onShowHardwareCursorChange: (enabled) => {
						this.settingsManager.setShowHardwareCursor(enabled);
						this.ui.setShowHardwareCursor(enabled);
					},
					onEditorPaddingXChange: (padding) => {
						this.settingsManager.setEditorPaddingX(padding);
						this.defaultEditor.setPaddingX(padding);
						if (this.editor !== this.defaultEditor && this.editor.setPaddingX !== undefined) {
							this.editor.setPaddingX(padding);
						}
					},
					onAutocompleteMaxVisibleChange: (maxVisible) => {
						this.settingsManager.setAutocompleteMaxVisible(maxVisible);
						this.defaultEditor.setAutocompleteMaxVisible(maxVisible);
						if (this.editor !== this.defaultEditor && this.editor.setAutocompleteMaxVisible !== undefined) {
							this.editor.setAutocompleteMaxVisible(maxVisible);
						}
					},
					onClearOnShrinkChange: (enabled) => {
						this.settingsManager.setClearOnShrink(enabled);
						this.ui.setClearOnShrink(enabled);
					},
					onCancel: () => {
						done();
						this.ui.requestRender();
					},
				},
			);
			return { component: selector, focus: selector.getSettingsList() };
		});
	}

	private async handleModelCommand(searchTerm?: string): Promise<void> {
		if (!searchTerm) {
			this.showModelSelector();
			return;
		}

		const model = await this.findExactModelMatch(searchTerm);
		if (model) {
			try {
				await this.session.setModel(model);
				this.footer.invalidate();
				this.updateEditorBorderColor();
				this.showStatus(`Model: ${model.id}`);
				this.checkDaxnutsEasterEgg(model);
			} catch (error) {
				this.showError(error instanceof Error ? error.message : String(error));
			}
			return;
		}

		this.showModelSelector(searchTerm);
	}

	private async findExactModelMatch(searchTerm: string): Promise<Model<any> | undefined> {
		const models = await this.getModelCandidates();
		return findExactModelReferenceMatch(searchTerm, models);
	}

	private async getModelCandidates(): Promise<Model<any>[]> {
		if (this.session.scopedModels.length > 0) {
			return this.session.scopedModels.map((scoped) => scoped.model);
		}

		this.session.modelRegistry.refresh();
		try {
			return await this.session.modelRegistry.getAvailable();
		} catch {
			return [];
		}
	}

	/** Update the footer's available provider count from current model candidates */
	private async updateAvailableProviderCount(): Promise<void> {
		const models = await this.getModelCandidates();
		const uniqueProviders = new Set(models.map((m) => m.provider));
		this.footerDataProvider.setAvailableProviderCount(uniqueProviders.size);
	}

	private showModelSelector(initialSearchInput?: string): void {
		this.showSelector((done) => {
			const selector = new ModelSelectorComponent(
				this.ui,
				this.session.model,
				this.settingsManager,
				this.session.modelRegistry,
				this.session.scopedModels,
				async (model) => {
					try {
						await this.session.setModel(model);
						this.footer.invalidate();
						this.updateEditorBorderColor();
						done();
						this.showStatus(`Model: ${model.id}`);
						this.checkDaxnutsEasterEgg(model);
					} catch (error) {
						done();
						this.showError(error instanceof Error ? error.message : String(error));
					}
				},
				() => {
					done();
					this.ui.requestRender();
				},
				initialSearchInput,
			);
			return { component: selector, focus: selector };
		});
	}

	private async showModelsSelector(): Promise<void> {
		// Get all available models
		this.session.modelRegistry.refresh();
		const allModels = this.session.modelRegistry.getAvailable();

		if (allModels.length === 0) {
			this.showStatus("No models available");
			return;
		}

		// Check if session has scoped models (from previous session-only changes or CLI --models)
		const sessionScopedModels = this.session.scopedModels;
		const hasSessionScope = sessionScopedModels.length > 0;

		// Build enabled model IDs from session state or settings
		const enabledModelIds = new Set<string>();
		let hasFilter = false;

		if (hasSessionScope) {
			// Use current session's scoped models
			for (const sm of sessionScopedModels) {
				enabledModelIds.add(`${sm.model.provider}/${sm.model.id}`);
			}
			hasFilter = true;
		} else {
			// Fall back to settings
			const patterns = this.settingsManager.getEnabledModels();
			if (patterns !== undefined && patterns.length > 0) {
				hasFilter = true;
				const scopedModels = await resolveModelScope(patterns, this.session.modelRegistry);
				for (const sm of scopedModels) {
					enabledModelIds.add(`${sm.model.provider}/${sm.model.id}`);
				}
			}
		}

		// Track current enabled state (session-only until persisted)
		const currentEnabledIds = new Set(enabledModelIds);
		let currentHasFilter = hasFilter;

		// Helper to update session's scoped models (session-only, no persist)
		const updateSessionModels = async (enabledIds: Set<string>) => {
			if (enabledIds.size > 0 && enabledIds.size < allModels.length) {
				const newScopedModels = await resolveModelScope(Array.from(enabledIds), this.session.modelRegistry);
				this.session.setScopedModels(
					newScopedModels.map((sm) => ({
						model: sm.model,
						thinkingLevel: sm.thinkingLevel,
					})),
				);
			} else {
				// All enabled or none enabled = no filter
				this.session.setScopedModels([]);
			}
			await this.updateAvailableProviderCount();
			this.ui.requestRender();
		};

		this.showSelector((done) => {
			const selector = new ScopedModelsSelectorComponent(
				{
					allModels,
					enabledModelIds: currentEnabledIds,
					hasEnabledModelsFilter: currentHasFilter,
				},
				{
					onModelToggle: async (modelId, enabled) => {
						if (enabled) {
							currentEnabledIds.add(modelId);
						} else {
							currentEnabledIds.delete(modelId);
						}
						currentHasFilter = true;
						await updateSessionModels(currentEnabledIds);
					},
					onEnableAll: async (allModelIds) => {
						currentEnabledIds.clear();
						for (const id of allModelIds) {
							currentEnabledIds.add(id);
						}
						currentHasFilter = false;
						await updateSessionModels(currentEnabledIds);
					},
					onClearAll: async () => {
						currentEnabledIds.clear();
						currentHasFilter = true;
						await updateSessionModels(currentEnabledIds);
					},
					onToggleProvider: async (_provider, modelIds, enabled) => {
						for (const id of modelIds) {
							if (enabled) {
								currentEnabledIds.add(id);
							} else {
								currentEnabledIds.delete(id);
							}
						}
						currentHasFilter = true;
						await updateSessionModels(currentEnabledIds);
					},
					onPersist: (enabledIds) => {
						// Persist to settings
						const newPatterns =
							enabledIds.length === allModels.length
								? undefined // All enabled = clear filter
								: enabledIds;
						this.settingsManager.setEnabledModels(newPatterns);
						this.showStatus("Model selection saved to settings");
					},
					onCancel: () => {
						done();
						this.ui.requestRender();
					},
				},
			);
			return { component: selector, focus: selector };
		});
	}

	private showUserMessageSelector(): void {
		const userMessages = this.session.getUserMessagesForForking();

		if (userMessages.length === 0) {
			this.showStatus("No messages to fork from");
			return;
		}

		this.showSelector((done) => {
			const selector = new UserMessageSelectorComponent(
				userMessages.map((m) => ({ id: m.entryId, text: m.text })),
				async (entryId) => {
					const result = await this.session.fork(entryId);
					if (result.cancelled) {
						// Extension cancelled the fork
						done();
						this.ui.requestRender();
						return;
					}

					this.chatContainer.clear();
					this.renderInitialMessages();
					this.editor.setText(result.selectedText);
					done();
					this.showStatus("Branched to new session");
				},
				() => {
					done();
					this.ui.requestRender();
				},
			);
			return { component: selector, focus: selector.getMessageList() };
		});
	}

	private showTreeSelector(initialSelectedId?: string): void {
		const tree = this.sessionManager.getTree();
		const realLeafId = this.sessionManager.getLeafId();
		const initialFilterMode = this.settingsManager.getTreeFilterMode();

		if (tree.length === 0) {
			this.showStatus("No entries in session");
			return;
		}

		this.showSelector((done) => {
			const selector = new TreeSelectorComponent(
				tree,
				realLeafId,
				this.ui.terminal.rows,
				async (entryId) => {
					// Selecting the current leaf is a no-op (already there)
					if (entryId === realLeafId) {
						done();
						this.showStatus("Already at this point");
						return;
					}

					// Ask about summarization
					done(); // Close selector first

					// Loop until user makes a complete choice or cancels to tree
					let wantsSummary = false;
					let customInstructions: string | undefined;

					// Check if we should skip the prompt (user preference to always default to no summary)
					if (!this.settingsManager.getBranchSummarySkipPrompt()) {
						while (true) {
							const summaryChoice = await this.showExtensionSelector("Summarize branch?", [
								"No summary",
								"Summarize",
								"Summarize with custom prompt",
							]);

							if (summaryChoice === undefined) {
								// User pressed escape - re-show tree selector with same selection
								this.showTreeSelector(entryId);
								return;
							}

							wantsSummary = summaryChoice !== "No summary";

							if (summaryChoice === "Summarize with custom prompt") {
								customInstructions = await this.showExtensionEditor("Custom summarization instructions");
								if (customInstructions === undefined) {
									// User cancelled - loop back to summary selector
									continue;
								}
							}

							// User made a complete choice
							break;
						}
					}

					// Set up escape handler and loader if summarizing
					let summaryLoader: Loader | undefined;
					const originalOnEscape = this.defaultEditor.onEscape;

					if (wantsSummary) {
						this.defaultEditor.onEscape = () => {
							this.session.abortBranchSummary();
						};
						this.chatContainer.addChild(new Spacer(1));
						summaryLoader = new Loader(
							this.ui,
							(spinner) => theme.fg("accent", spinner),
							(text) => theme.fg("muted", text),
							`Summarizing branch... (${keyText("app.interrupt")} to cancel)`,
						);
						this.statusContainer.addChild(summaryLoader);
						this.ui.requestRender();
					}

					try {
						const result = await this.session.navigateTree(entryId, {
							summarize: wantsSummary,
							customInstructions,
						});

						if (result.aborted) {
							// Summarization aborted - re-show tree selector with same selection
							this.showStatus("Branch summarization cancelled");
							this.showTreeSelector(entryId);
							return;
						}
						if (result.cancelled) {
							this.showStatus("Navigation cancelled");
							return;
						}

						// Update UI
						this.chatContainer.clear();
						this.renderInitialMessages();
						if (result.editorText && !this.editor.getText().trim()) {
							this.editor.setText(result.editorText);
						}
						this.showStatus("Navigated to selected point");
					} catch (error) {
						this.showError(error instanceof Error ? error.message : String(error));
					} finally {
						if (summaryLoader) {
							summaryLoader.stop();
							this.statusContainer.clear();
						}
						this.defaultEditor.onEscape = originalOnEscape;
					}
				},
				() => {
					done();
					this.ui.requestRender();
				},
				(entryId, label) => {
					this.sessionManager.appendLabelChange(entryId, label);
					this.ui.requestRender();
				},
				initialSelectedId,
				initialFilterMode,
			);
			return { component: selector, focus: selector };
		});
	}

	private formatSubagentSessionOption(session: LocatedTaskSession): string {
		const status = session.state?.status ?? "completed";
		const icon = status === "running" ? "⏳" : status === "completed" ? "✓" : status === "aborted" ? "⏹" : "✗";
		const label = session.metadata?.title ?? `${session.metadata?.agent ?? session.reference.taskId} subagent`;
		const preview = session.state?.task ?? label;
		const trimmed = preview.length > 70 ? `${preview.slice(0, 70)}...` : preview;
		const depth = "depth" in session && typeof session.depth === "number" ? session.depth : 1;
		const prefix = depth > 1 ? `${"  ".repeat(depth - 1)}↳ ` : "";
		return `${prefix}${icon} ${session.metadata?.agent ?? session.reference.taskId} - ${trimmed}`;
	}

	private matchesSubagentQuery(session: LocatedTaskSession, query: string): boolean {
		const normalized = query.trim().toLowerCase();
		if (!normalized) {
			return true;
		}
		return [
			session.metadata?.agent,
			session.metadata?.title,
			session.state?.task,
			session.reference.taskId,
			session.state?.status,
		]
			.filter((value): value is string => Boolean(value))
			.some((value) => value.toLowerCase().includes(normalized));
	}

	private async handleSubagentsCommand(text: string): Promise<void> {
		const query = text.startsWith("/subagents ") ? text.slice(11).trim() : "";
		const navigation = buildTaskNavigationContext(this.activeSessionManager);
		const sessions = navigation.sessions.filter((session) => this.matchesSubagentQuery(session, query));

		const options: string[] = [];
		const returnToActive = this.isViewingDetachedSession();
		if (returnToActive) {
			options.push("← Return to active session");
		}
		const returnToRoot =
			!returnToActive &&
			navigation.currentIsTaskSession &&
			navigation.rootSessionFile &&
			navigation.rootSessionFile !== navigation.currentSessionFile;
		if (returnToRoot) {
			options.push("← Return to root session");
		}
		options.push(...sessions.map((session) => this.formatSubagentSessionOption(session)));

		if (options.length === 0) {
			this.showStatus(query ? `No subagents matched: ${query}` : "No delegated child sessions");
			return;
		}

		const selected = await this.showExtensionSelector("Subagent Sessions", options);
		if (!selected) {
			return;
		}

		if (selected === "← Return to active session") {
			this.stopDetachedSessionView();
			this.chatContainer.clear();
			this.renderInitialMessages();
			this.restoreDetachedActiveSessionState();
			this.showStatus("Returned to active session");
			return;
		}

		if (selected === "← Return to root session") {
			if (navigation.rootSessionFile) {
				await this.handleResumeSession(navigation.rootSessionFile);
			}
			return;
		}

		const selectedSession = sessions.find((session) => this.formatSubagentSessionOption(session) === selected);
		if (!selectedSession) {
			return;
		}

		await this.openChildSession(selectedSession.reference.sessionFile);
	}

	private showSessionSelector(): void {
		this.showSelector((done) => {
			const selector = new SessionSelectorComponent(
				(onProgress) =>
					SessionManager.list(this.sessionManager.getCwd(), this.sessionManager.getSessionDir(), onProgress),
				SessionManager.listAll,
				async (sessionPath) => {
					done();
					await this.handleResumeSession(sessionPath);
				},
				() => {
					done();
					this.ui.requestRender();
				},
				() => {
					void this.shutdown();
				},
				() => this.ui.requestRender(),
				{
					renameSession: async (sessionFilePath: string, nextName: string | undefined) => {
						const next = (nextName ?? "").trim();
						if (!next) return;
						const mgr = SessionManager.open(sessionFilePath);
						mgr.appendSessionInfo(next);
					},
					showRenameHint: true,
					keybindings: this.keybindings,
				},

				this.sessionManager.getSessionFile(),
			);
			return { component: selector, focus: selector };
		});
	}

	private async handleResumeSession(sessionPath: string): Promise<void> {
		this.specAutoContinuationActive = false;
		this.stopDetachedSessionView();
		this.clearDetachedActiveSessionState();
		this.missionOrchestrator?.abort();
		this.missionOrchestrator = undefined;
		await this.restoreSessionAfterSpec(this.specState);

		// Stop loading animation
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
		}
		this.statusContainer.clear();

		// Clear UI state
		this.pendingMessagesContainer.clear();
		this.compactionQueuedMessages = [];
		this.streamingComponent = undefined;
		this.streamingMessage = undefined;
		this.pendingTools.clear();

		// Switch session via AgentSession (emits extension session events)
		await this.session.switchSession(sessionPath);
		this.resetWorkingSessionTimer();
		await this.reloadSpecStateFromSession({ restoreFallback: true });
		this.reloadMissionStateFromSession();

		// Clear and re-render the chat
		this.chatContainer.clear();
		this.renderInitialMessages();
		this.showStatus("Resumed session");
	}

	private async showOAuthSelector(mode: "login" | "logout"): Promise<void> {
		if (mode === "logout") {
			const providers = this.session.modelRegistry.authStorage.list();
			const loggedInProviders = providers.filter(
				(p) => this.session.modelRegistry.authStorage.get(p)?.type === "oauth",
			);
			if (loggedInProviders.length === 0) {
				this.showStatus("No OAuth providers logged in. Use /login first.");
				return;
			}
		}

		this.showSelector((done) => {
			const selector = new OAuthSelectorComponent(
				mode,
				this.session.modelRegistry.authStorage,
				async (providerId: string) => {
					done();

					if (mode === "login") {
						await this.showLoginDialog(providerId);
					} else {
						// Logout flow
						const providerInfo = this.session.modelRegistry.authStorage
							.getOAuthProviders()
							.find((p) => p.id === providerId);
						const providerName = providerInfo?.name || providerId;

						try {
							this.session.modelRegistry.authStorage.logout(providerId);
							this.session.modelRegistry.refresh();
							await this.updateAvailableProviderCount();
							this.showStatus(`Logged out of ${providerName}`);
						} catch (error: unknown) {
							this.showError(`Logout failed: ${error instanceof Error ? error.message : String(error)}`);
						}
					}
				},
				() => {
					done();
					this.ui.requestRender();
				},
			);
			return { component: selector, focus: selector };
		});
	}

	private async showLoginDialog(providerId: string): Promise<void> {
		const providerInfo = this.session.modelRegistry.authStorage.getOAuthProviders().find((p) => p.id === providerId);
		const providerName = providerInfo?.name || providerId;

		// Providers that use callback servers (can paste redirect URL)
		const usesCallbackServer = providerInfo?.usesCallbackServer ?? false;

		// Create login dialog component
		const dialog = new LoginDialogComponent(this.ui, providerId, (_success, _message) => {
			// Completion handled below
		});

		// Show dialog in editor container
		this.editorContainer.clear();
		this.editorContainer.addChild(dialog);
		this.ui.setFocus(dialog);
		this.ui.requestRender();

		// Promise for manual code input (racing with callback server)
		let manualCodeResolve: ((code: string) => void) | undefined;
		let manualCodeReject: ((err: Error) => void) | undefined;
		const manualCodePromise = new Promise<string>((resolve, reject) => {
			manualCodeResolve = resolve;
			manualCodeReject = reject;
		});

		// Restore editor helper
		const restoreEditor = () => {
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.ui.setFocus(this.editor);
			this.ui.requestRender();
		};

		try {
			await this.session.modelRegistry.authStorage.login(providerId as OAuthProviderId, {
				onAuth: (info: { url: string; instructions?: string }) => {
					dialog.showAuth(info.url, info.instructions);

					if (usesCallbackServer) {
						// Show input for manual paste, racing with callback
						dialog
							.showManualInput("Paste redirect URL below, or complete login in browser:")
							.then((value) => {
								if (value && manualCodeResolve) {
									manualCodeResolve(value);
									manualCodeResolve = undefined;
								}
							})
							.catch(() => {
								if (manualCodeReject) {
									manualCodeReject(new Error("Login cancelled"));
									manualCodeReject = undefined;
								}
							});
					} else if (providerId === "github-copilot") {
						// GitHub Copilot polls after onAuth
						dialog.showWaiting("Waiting for browser authentication...");
					}
					// For Anthropic: onPrompt is called immediately after
				},

				onPrompt: async (prompt: { message: string; placeholder?: string }) => {
					return dialog.showPrompt(prompt.message, prompt.placeholder);
				},

				onProgress: (message: string) => {
					dialog.showProgress(message);
				},

				onManualCodeInput: () => manualCodePromise,

				signal: dialog.signal,
			});

			// Success
			restoreEditor();
			this.session.modelRegistry.refresh();
			await this.updateAvailableProviderCount();
			this.showStatus(`Logged in to ${providerName}. Credentials saved to ${getAuthPath()}`);
		} catch (error: unknown) {
			restoreEditor();
			const errorMsg = error instanceof Error ? error.message : String(error);
			if (errorMsg !== "Login cancelled") {
				this.showError(`Failed to login to ${providerName}: ${errorMsg}`);
			}
		}
	}

	// =========================================================================
	// Command handlers
	// =========================================================================

	private async handleReloadCommand(): Promise<void> {
		if (this.session.isStreaming) {
			this.showWarning("Wait for the current response to finish before reloading.");
			return;
		}
		if (this.session.isCompacting) {
			this.showWarning("Wait for compaction to finish before reloading.");
			return;
		}

		this.resetExtensionUI();

		const loader = new BorderedLoader(
			this.ui,
			theme,
			"Reloading keybindings, extensions, skills, prompts, themes...",
			{
				cancellable: false,
			},
		);
		const previousEditor = this.editor;
		this.editorContainer.clear();
		this.editorContainer.addChild(loader);
		this.ui.setFocus(loader);
		this.ui.requestRender();

		const dismissLoader = (editor: Component) => {
			loader.dispose();
			this.editorContainer.clear();
			this.editorContainer.addChild(editor);
			this.ui.setFocus(editor);
			this.ui.requestRender();
		};

		try {
			await this.session.reload();
			this.keybindings.reload();
			setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
			this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();
			const themeName = this.settingsManager.getTheme();
			const themeResult = themeName ? setTheme(themeName, true) : { success: true };
			if (!themeResult.success) {
				this.showError(`Failed to load theme "${themeName}": ${themeResult.error}\nFell back to dark theme.`);
			}
			const editorPaddingX = this.settingsManager.getEditorPaddingX();
			const autocompleteMaxVisible = this.settingsManager.getAutocompleteMaxVisible();
			this.defaultEditor.setPaddingX(editorPaddingX);
			this.defaultEditor.setAutocompleteMaxVisible(autocompleteMaxVisible);
			if (this.editor !== this.defaultEditor) {
				this.editor.setPaddingX?.(editorPaddingX);
				this.editor.setAutocompleteMaxVisible?.(autocompleteMaxVisible);
			}
			this.ui.setShowHardwareCursor(this.settingsManager.getShowHardwareCursor());
			this.ui.setClearOnShrink(this.settingsManager.getClearOnShrink());
			this.setupAutocomplete(this.fdPath);
			this.reloadMissionStateFromSession();
			await this.reloadSpecStateFromSession();
			this.updateModeBanner();
			const runner = this.session.extensionRunner;
			if (runner) {
				this.setupExtensionShortcuts(runner);
			}
			this.rebuildChatFromMessages();
			dismissLoader(this.editor as Component);
			this.showLoadedResources({
				extensionPaths: runner?.getExtensionPaths() ?? [],
				force: false,
				showDiagnosticsWhenQuiet: true,
			});
			const modelsJsonError = this.session.modelRegistry.getError();
			if (modelsJsonError) {
				this.showError(`models.json error: ${modelsJsonError}`);
			}
			this.showStatus("Reloaded keybindings, extensions, skills, prompts, themes");
		} catch (error) {
			dismissLoader(previousEditor as Component);
			this.showError(`Reload failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async handleExportCommand(text: string): Promise<void> {
		const parts = text.split(/\s+/);
		const outputPath = parts.length > 1 ? parts[1] : undefined;

		try {
			if (outputPath?.endsWith(".jsonl")) {
				const filePath = this.session.exportToJsonl(outputPath);
				this.showStatus(`Session exported to: ${filePath}`);
			} else {
				const filePath = await this.session.exportToHtml(outputPath);
				this.showStatus(`Session exported to: ${filePath}`);
			}
		} catch (error: unknown) {
			this.showError(`Failed to export session: ${error instanceof Error ? error.message : "Unknown error"}`);
		}
	}

	private async handleImportCommand(text: string): Promise<void> {
		const parts = text.split(/\s+/);
		if (parts.length < 2 || !parts[1]) {
			this.showError("Usage: /import <path.jsonl>");
			return;
		}
		const inputPath = parts[1];

		const confirmed = await this.showExtensionConfirm("Import session", `Replace current session with ${inputPath}?`);
		if (!confirmed) {
			this.showStatus("Import cancelled");
			return;
		}

		try {
			// Stop loading animation
			if (this.loadingAnimation) {
				this.loadingAnimation.stop();
				this.loadingAnimation = undefined;
			}
			this.statusContainer.clear();

			// Clear UI state
			this.pendingMessagesContainer.clear();
			this.compactionQueuedMessages = [];
			this.streamingComponent = undefined;
			this.streamingMessage = undefined;
			this.pendingTools.clear();

			const success = await this.session.importFromJsonl(inputPath);
			if (!success) {
				this.showWarning("Import cancelled");
				return;
			}

			// Clear and re-render the chat
			this.chatContainer.clear();
			this.renderInitialMessages();
			await this.reloadSpecStateFromSession();
			this.reloadMissionStateFromSession();
			this.showStatus(`Session imported from: ${inputPath}`);
		} catch (error: unknown) {
			this.showError(`Failed to import session: ${error instanceof Error ? error.message : "Unknown error"}`);
		}
	}

	private async handleShareCommand(): Promise<void> {
		// Check if gh is available and logged in
		try {
			const authResult = spawnSync("gh", ["auth", "status"], { encoding: "utf-8" });
			if (authResult.status !== 0) {
				this.showError("GitHub CLI is not logged in. Run 'gh auth login' first.");
				return;
			}
		} catch {
			this.showError("GitHub CLI (gh) is not installed. Install it from https://cli.github.com/");
			return;
		}

		// Export to a temp file
		const tmpFile = path.join(os.tmpdir(), "session.html");
		try {
			await this.session.exportToHtml(tmpFile);
		} catch (error: unknown) {
			this.showError(`Failed to export session: ${error instanceof Error ? error.message : "Unknown error"}`);
			return;
		}

		// Show cancellable loader, replacing the editor
		const loader = new BorderedLoader(this.ui, theme, "Creating gist...");
		this.editorContainer.clear();
		this.editorContainer.addChild(loader);
		this.ui.setFocus(loader);
		this.ui.requestRender();

		const restoreEditor = () => {
			loader.dispose();
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.ui.setFocus(this.editor);
			try {
				fs.unlinkSync(tmpFile);
			} catch {
				// Ignore cleanup errors
			}
		};

		// Create a secret gist asynchronously
		let proc: ReturnType<typeof spawn> | null = null;

		loader.onAbort = () => {
			proc?.kill();
			restoreEditor();
			this.showStatus("Share cancelled");
		};

		try {
			const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
				proc = spawn("gh", ["gist", "create", "--public=false", tmpFile]);
				let stdout = "";
				let stderr = "";
				proc.stdout?.on("data", (data) => {
					stdout += data.toString();
				});
				proc.stderr?.on("data", (data) => {
					stderr += data.toString();
				});
				proc.on("close", (code) => resolve({ stdout, stderr, code }));
			});

			if (loader.signal.aborted) return;

			restoreEditor();

			if (result.code !== 0) {
				const errorMsg = result.stderr?.trim() || "Unknown error";
				this.showError(`Failed to create gist: ${errorMsg}`);
				return;
			}

			// Extract gist ID from the URL returned by gh
			// gh returns something like: https://gist.github.com/username/GIST_ID
			const gistUrl = result.stdout?.trim();
			const gistId = gistUrl?.split("/").pop();
			if (!gistId) {
				this.showError("Failed to parse gist ID from gh output");
				return;
			}

			// Create the preview URL
			const previewUrl = getShareViewerUrl(gistId);
			this.showStatus(`Share URL: ${previewUrl}\nGist: ${gistUrl}`);
		} catch (error: unknown) {
			if (!loader.signal.aborted) {
				restoreEditor();
				this.showError(`Failed to create gist: ${error instanceof Error ? error.message : "Unknown error"}`);
			}
		}
	}

	private async handleCopyCommand(): Promise<void> {
		const text = this.session.getLastAssistantText();
		if (!text) {
			this.showError("No agent messages to copy yet.");
			return;
		}

		try {
			await copyToClipboard(text);
			this.showStatus("Copied last agent message to clipboard");
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private handleNameCommand(text: string): void {
		const name = text.replace(/^\/name\s*/, "").trim();
		if (!name) {
			const currentName = this.sessionManager.getSessionName();
			if (currentName) {
				this.chatContainer.addChild(new Spacer(1));
				this.chatContainer.addChild(new Text(theme.fg("dim", `Session name: ${currentName}`), 1, 0));
			} else {
				this.showWarning("Usage: /name <name>");
			}
			this.ui.requestRender();
			return;
		}

		this.sessionManager.appendSessionInfo(name);
		this.updateTerminalTitle();
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg("dim", `Session name set: ${name}`), 1, 0));
		this.ui.requestRender();
	}

	private handleSessionCommand(): void {
		const stats = this.session.getSessionStats();
		const sessionName = this.sessionManager.getSessionName();

		let info = `${theme.bold("Session Info")}\n\n`;
		if (sessionName) {
			info += `${theme.fg("dim", "Name:")} ${sessionName}\n`;
		}
		info += `${theme.fg("dim", "File:")} ${stats.sessionFile ?? "In-memory"}\n`;
		info += `${theme.fg("dim", "ID:")} ${stats.sessionId}\n\n`;
		info += `${theme.bold("Messages")}\n`;
		info += `${theme.fg("dim", "User:")} ${stats.userMessages}\n`;
		info += `${theme.fg("dim", "Assistant:")} ${stats.assistantMessages}\n`;
		info += `${theme.fg("dim", "Tool Calls:")} ${stats.toolCalls}\n`;
		info += `${theme.fg("dim", "Tool Results:")} ${stats.toolResults}\n`;
		info += `${theme.fg("dim", "Total:")} ${stats.totalMessages}\n\n`;
		info += `${theme.bold("Tokens")}\n`;
		info += `${theme.fg("dim", "Input:")} ${stats.tokens.input.toLocaleString()}\n`;
		info += `${theme.fg("dim", "Output:")} ${stats.tokens.output.toLocaleString()}\n`;
		if (stats.tokens.cacheRead > 0) {
			info += `${theme.fg("dim", "Cache Read:")} ${stats.tokens.cacheRead.toLocaleString()}\n`;
		}
		if (stats.tokens.cacheWrite > 0) {
			info += `${theme.fg("dim", "Cache Write:")} ${stats.tokens.cacheWrite.toLocaleString()}\n`;
		}
		info += `${theme.fg("dim", "Total:")} ${stats.tokens.total.toLocaleString()}\n`;

		if (stats.cost > 0) {
			info += `\n${theme.bold("Cost")}\n`;
			info += `${theme.fg("dim", "Total:")} ${stats.cost.toFixed(4)}`;
		}

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(info, 1, 0));
		this.ui.requestRender();
	}

	private handleChangelogCommand(): void {
		const changelogPath = getChangelogPath();
		const allEntries = parseChangelog(changelogPath);

		const changelogMarkdown =
			allEntries.length > 0
				? allEntries
						.reverse()
						.map((e) => e.content)
						.join("\n\n")
				: "No changelog entries found.";

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DynamicBorder());
		this.chatContainer.addChild(new Text(theme.bold(theme.fg("accent", "What's New")), 1, 0));
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Markdown(changelogMarkdown, 1, 1, this.getMarkdownThemeWithSettings()));
		this.chatContainer.addChild(new DynamicBorder());
		this.ui.requestRender();
	}

	/**
	 * Capitalize keybinding for display (e.g., "ctrl+c" -> "Ctrl+C").
	 */
	private capitalizeKey(key: string): string {
		return key
			.split("/")
			.map((k) =>
				k
					.split("+")
					.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
					.join("+"),
			)
			.join("/");
	}

	private capitalize(text: string): string {
		return text.length > 0 ? text.charAt(0).toUpperCase() + text.slice(1) : text;
	}

	/**
	 * Get capitalized display string for an app keybinding action.
	 */
	private getAppKeyDisplay(action: AppKeybinding): string {
		return this.capitalizeKey(keyText(action));
	}

	/**
	 * Get capitalized display string for an editor keybinding action.
	 */
	private getEditorKeyDisplay(action: Keybinding): string {
		return this.capitalizeKey(keyText(action));
	}

	private handleHotkeysCommand(): void {
		// Navigation keybindings
		const cursorUp = this.getEditorKeyDisplay("tui.editor.cursorUp");
		const cursorDown = this.getEditorKeyDisplay("tui.editor.cursorDown");
		const cursorLeft = this.getEditorKeyDisplay("tui.editor.cursorLeft");
		const cursorRight = this.getEditorKeyDisplay("tui.editor.cursorRight");
		const cursorWordLeft = this.getEditorKeyDisplay("tui.editor.cursorWordLeft");
		const cursorWordRight = this.getEditorKeyDisplay("tui.editor.cursorWordRight");
		const cursorLineStart = this.getEditorKeyDisplay("tui.editor.cursorLineStart");
		const cursorLineEnd = this.getEditorKeyDisplay("tui.editor.cursorLineEnd");
		const jumpForward = this.getEditorKeyDisplay("tui.editor.jumpForward");
		const jumpBackward = this.getEditorKeyDisplay("tui.editor.jumpBackward");
		const pageUp = this.getEditorKeyDisplay("tui.editor.pageUp");
		const pageDown = this.getEditorKeyDisplay("tui.editor.pageDown");

		// Editing keybindings
		const submit = this.getEditorKeyDisplay("tui.input.submit");
		const newLine = this.getEditorKeyDisplay("tui.input.newLine");
		const deleteWordBackward = this.getEditorKeyDisplay("tui.editor.deleteWordBackward");
		const deleteWordForward = this.getEditorKeyDisplay("tui.editor.deleteWordForward");
		const deleteToLineStart = this.getEditorKeyDisplay("tui.editor.deleteToLineStart");
		const deleteToLineEnd = this.getEditorKeyDisplay("tui.editor.deleteToLineEnd");
		const yank = this.getEditorKeyDisplay("tui.editor.yank");
		const yankPop = this.getEditorKeyDisplay("tui.editor.yankPop");
		const undo = this.getEditorKeyDisplay("tui.editor.undo");
		const tab = this.getEditorKeyDisplay("tui.input.tab");

		// App keybindings
		const interrupt = this.getAppKeyDisplay("app.interrupt");
		const clear = this.getAppKeyDisplay("app.clear");
		const exit = this.getAppKeyDisplay("app.exit");
		const suspend = this.getAppKeyDisplay("app.suspend");
		const cycleThinkingLevel = this.getAppKeyDisplay("app.thinking.cycle");
		const cycleModelForward = this.getAppKeyDisplay("app.model.cycleForward");
		const selectModel = this.getAppKeyDisplay("app.model.select");
		const toggleSpec = this.getAppKeyDisplay("app.spec.toggle");
		const cycleAutonomy = this.getAppKeyDisplay("app.autonomy.cycle");
		const expandTools = this.getAppKeyDisplay("app.tools.expand");
		const toggleThinking = this.getAppKeyDisplay("app.thinking.toggle");
		const externalEditor = this.getAppKeyDisplay("app.editor.external");
		const cycleModelBackward = this.getAppKeyDisplay("app.model.cycleBackward");
		const followUp = this.getAppKeyDisplay("app.message.followUp");
		const dequeue = this.getAppKeyDisplay("app.message.dequeue");
		const pasteImage = this.getAppKeyDisplay("app.clipboard.pasteImage");

		let hotkeys = `
**Navigation**
| Key | Action |
|-----|--------|
| \`${cursorUp}\` / \`${cursorDown}\` / \`${cursorLeft}\` / \`${cursorRight}\` | Move cursor / browse history (Up when empty) |
| \`${cursorWordLeft}\` / \`${cursorWordRight}\` | Move by word |
| \`${cursorLineStart}\` | Start of line |
| \`${cursorLineEnd}\` | End of line |
| \`${jumpForward}\` | Jump forward to character |
| \`${jumpBackward}\` | Jump backward to character |
| \`${pageUp}\` / \`${pageDown}\` | Scroll by page |

**Editing**
| Key | Action |
|-----|--------|
| \`${submit}\` | Send message |
| \`${newLine}\` | New line${process.platform === "win32" ? " (Ctrl+Enter on Windows Terminal)" : ""} |
| \`${deleteWordBackward}\` | Delete word backwards |
| \`${deleteWordForward}\` | Delete word forwards |
| \`${deleteToLineStart}\` | Delete to start of line |
| \`${deleteToLineEnd}\` | Delete to end of line |
| \`${yank}\` | Paste the most-recently-deleted text |
| \`${yankPop}\` | Cycle through the deleted text after pasting |
| \`${undo}\` | Undo |

**Other**
| Key | Action |
|-----|--------|
| \`${tab}\` | Path completion / accept autocomplete |
| \`${interrupt}\` | Cancel autocomplete / abort streaming |
| \`${clear}\` | Clear editor (first) / exit (second) |
| \`${exit}\` | Exit (when editor is empty) |
| \`${suspend}\` | Suspend to background |
| \`${cycleThinkingLevel}\` | Cycle thinking level |
| \`${cycleModelForward}\` / \`${cycleModelBackward}\` | Cycle models |
| \`${selectModel}\` | Open model selector |
| \`${toggleSpec}\` | Toggle specification mode |
| \`${cycleAutonomy}\` | Cycle autonomy mode |
| \`${expandTools}\` | Toggle tool output expansion |
| \`${toggleThinking}\` | Toggle thinking block visibility |
| \`${externalEditor}\` | Edit message in external editor |
| \`${followUp}\` | Queue follow-up message |
| \`${dequeue}\` | Restore queued messages |
| \`${pasteImage}\` | Paste image from clipboard |
| \`/\` | Slash commands |
| \`!\` | Run bash command |
| \`!!\` | Run bash command (excluded from context) |
`;

		// Add extension-registered shortcuts
		const extensionRunner = this.session.extensionRunner;
		if (extensionRunner) {
			const shortcuts = extensionRunner.getShortcuts(this.keybindings.getEffectiveConfig());
			if (shortcuts.size > 0) {
				hotkeys += `
**Extensions**
| Key | Action |
|-----|--------|
`;
				for (const [key, shortcut] of shortcuts) {
					const description = shortcut.description ?? shortcut.extensionPath;
					const keyDisplay = key.replace(/\b\w/g, (c) => c.toUpperCase());
					hotkeys += `| \`${keyDisplay}\` | ${description} |\n`;
				}
			}
		}

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DynamicBorder());
		this.chatContainer.addChild(new Text(theme.bold(theme.fg("accent", "Keyboard Shortcuts")), 1, 0));
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Markdown(hotkeys.trim(), 1, 1, this.getMarkdownThemeWithSettings()));
		this.chatContainer.addChild(new DynamicBorder());
		this.ui.requestRender();
	}

	private async handleClearCommand(): Promise<void> {
		this.specAutoContinuationActive = false;
		this.missionOrchestrator?.abort();
		this.missionOrchestrator = undefined;
		await this.restoreSessionAfterSpec(this.specState);
		// Stop loading animation
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
		}
		this.statusContainer.clear();

		// New session via session (emits extension session events)
		await this.session.newSession();
		this.resetWorkingSessionTimer();
		await this.reloadSpecStateFromSession({ restoreFallback: true });
		this.reloadMissionStateFromSession();

		// Clear UI state
		this.headerContainer.clear();
		this.chatContainer.clear();
		this.pendingMessagesContainer.clear();
		this.compactionQueuedMessages = [];
		this.streamingComponent = undefined;
		this.streamingMessage = undefined;
		this.pendingTools.clear();

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(`${theme.fg("accent", "✓ New session started")}`, 1, 1));
		this.ui.requestRender();
	}

	private handleDebugCommand(): void {
		const width = this.ui.terminal.columns;
		const height = this.ui.terminal.rows;
		const allLines = this.ui.render(width);

		const debugLogPath = getDebugLogPath();
		const debugData = [
			`Debug output at ${new Date().toISOString()}`,
			`Terminal: ${width}x${height}`,
			`Total lines: ${allLines.length}`,
			"",
			"=== All rendered lines with visible widths ===",
			...allLines.map((line, idx) => {
				const vw = visibleWidth(line);
				const escaped = JSON.stringify(line);
				return `[${idx}] (w=${vw}) ${escaped}`;
			}),
			"",
			"=== Agent messages (JSONL) ===",
			...this.session.messages.map((msg) => JSON.stringify(msg)),
			"",
		].join("\n");

		fs.mkdirSync(path.dirname(debugLogPath), { recursive: true });
		fs.writeFileSync(debugLogPath, debugData);

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(
			new Text(`${theme.fg("accent", "✓ Debug log written")}\n${theme.fg("muted", debugLogPath)}`, 1, 1),
		);
		this.ui.requestRender();
	}

	private handleArminSaysHi(): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new ArminComponent(this.ui));
		this.ui.requestRender();
	}

	private handleDaxnuts(): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DaxnutsComponent(this.ui));
		this.ui.requestRender();
	}

	private checkDaxnutsEasterEgg(model: { provider: string; id: string }): void {
		if (model.provider === "opencode" && model.id.toLowerCase().includes("kimi-k2.5")) {
			this.handleDaxnuts();
		}
	}

	private async handleBashCommand(command: string, excludeFromContext = false): Promise<void> {
		const extensionRunner = this.session.extensionRunner;

		// Emit user_bash event to let extensions intercept
		const eventResult = extensionRunner
			? await extensionRunner.emitUserBash({
					type: "user_bash",
					command,
					excludeFromContext,
					cwd: process.cwd(),
				})
			: undefined;

		// If extension returned a full result, use it directly
		if (eventResult?.result) {
			const result = eventResult.result;

			// Create UI component for display
			this.bashComponent = new BashExecutionComponent(command, this.ui, excludeFromContext);
			if (this.session.isStreaming) {
				this.pendingMessagesContainer.addChild(this.bashComponent);
				this.pendingBashComponents.push(this.bashComponent);
			} else {
				this.chatContainer.addChild(this.bashComponent);
			}

			// Show output and complete
			if (result.output) {
				this.bashComponent.appendOutput(result.output);
			}
			this.bashComponent.setComplete(
				result.exitCode,
				result.cancelled,
				result.truncated ? ({ truncated: true, content: result.output } as TruncationResult) : undefined,
				result.fullOutputPath,
			);

			// Record the result in session
			this.session.recordBashResult(command, result, { excludeFromContext });
			this.bashComponent = undefined;
			this.ui.requestRender();
			return;
		}

		// Normal execution path (possibly with custom operations)
		const isDeferred = this.session.isStreaming;
		this.bashComponent = new BashExecutionComponent(command, this.ui, excludeFromContext);

		if (isDeferred) {
			// Show in pending area when agent is streaming
			this.pendingMessagesContainer.addChild(this.bashComponent);
			this.pendingBashComponents.push(this.bashComponent);
		} else {
			// Show in chat immediately when agent is idle
			this.chatContainer.addChild(this.bashComponent);
		}
		this.ui.requestRender();

		try {
			const result = await this.session.executeBash(
				command,
				(chunk) => {
					if (this.bashComponent) {
						this.bashComponent.appendOutput(chunk);
						this.ui.requestRender();
					}
				},
				{ excludeFromContext, operations: eventResult?.operations },
			);

			if (this.bashComponent) {
				this.bashComponent.setComplete(
					result.exitCode,
					result.cancelled,
					result.truncated ? ({ truncated: true, content: result.output } as TruncationResult) : undefined,
					result.fullOutputPath,
				);
			}
		} catch (error) {
			if (this.bashComponent) {
				this.bashComponent.setComplete(undefined, false);
			}
			this.showError(`Bash command failed: ${error instanceof Error ? error.message : "Unknown error"}`);
		}

		this.bashComponent = undefined;
		this.ui.requestRender();
	}

	private async handleCompactCommand(customInstructions?: string): Promise<void> {
		const entries = this.sessionManager.getEntries();
		const messageCount = entries.filter((e) => e.type === "message").length;

		if (messageCount < 2) {
			this.showWarning("Nothing to compact (no messages yet)");
			return;
		}

		await this.executeCompaction(customInstructions, false);
	}

	private async executeCompaction(customInstructions?: string, isAuto = false): Promise<CompactionResult | undefined> {
		// Stop loading animation
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
		}
		this.statusContainer.clear();

		// Set up escape handler during compaction
		const originalOnEscape = this.defaultEditor.onEscape;
		this.defaultEditor.onEscape = () => {
			this.session.abortCompaction();
		};

		// Show compacting status
		this.chatContainer.addChild(new Spacer(1));
		const cancelHint = `(${keyText("app.interrupt")} to cancel)`;
		const label = isAuto ? `Auto-compacting context... ${cancelHint}` : `Compacting context... ${cancelHint}`;
		const compactingLoader = new Loader(
			this.ui,
			(spinner) => theme.fg("accent", spinner),
			(text) => theme.fg("muted", text),
			label,
		);
		this.statusContainer.addChild(compactingLoader);
		this.ui.requestRender();

		let result: CompactionResult | undefined;

		try {
			result = await this.session.compact(customInstructions);

			// Rebuild UI
			this.rebuildChatFromMessages();

			// Add compaction component at bottom so user sees it without scrolling
			const msg = createCompactionSummaryMessage(result.summary, result.tokensBefore, new Date().toISOString());
			this.addMessageToChat(msg);

			this.footer.invalidate();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (message === "Compaction cancelled" || (error instanceof Error && error.name === "AbortError")) {
				this.showError("Compaction cancelled");
			} else {
				this.showError(`Compaction failed: ${message}`);
			}
		} finally {
			compactingLoader.stop();
			this.statusContainer.clear();
			this.defaultEditor.onEscape = originalOnEscape;
		}
		void this.flushCompactionQueue({ willRetry: false });
		return result;
	}

	stop(): void {
		this.specAutoContinuationActive = false;
		this.stopDetachedSessionView();
		this.missionOrchestrator?.abort();
		this.missionOrchestrator = undefined;
		unregisterSessionSafetyServices(this.sessionManager);
		void this.safetyServices.dispose();
		this.resetWorkingSessionTimer(false);
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
		}
		this.clearExtensionTerminalInputListeners();
		this.footer.dispose();
		this.footerDataProvider.dispose();
		if (this.unsubscribe) {
			this.unsubscribe();
		}
		if (this.isInitialized) {
			this.ui.stop();
			this.isInitialized = false;
		}
	}
}
