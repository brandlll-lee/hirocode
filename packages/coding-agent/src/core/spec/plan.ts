import type { AgentMessage } from "@hirocode/agent-core";
import type { SpecPlan, SpecPlanningEvidence, SpecPlanSection, SpecPlanSections } from "./types.js";

const PLAN_TAG_PATTERN = /<proposed_plan>([\s\S]*?)<\/proposed_plan>/i;
const OPEN_TAG = "<proposed_plan>";
const CLOSE_TAG = "</proposed_plan>";
const LOCAL_GROUNDING_TOOL_NAMES = new Set(["read", "bash", "grep", "find", "ls", "task"]);

type SpecPlanBucket = keyof Omit<SpecPlanSections, "title" | "sections" | "markdown">;

const SECTION_ALIASES: Record<string, SpecPlanBucket> = {
	summary: "summary",
	overview: "summary",
	background: "summary",
	goals: "goals",
	goal: "goals",
	constraints: "constraints",
	constraint: "constraints",
	"acceptance criteria": "acceptanceCriteria",
	"acceptance criterion": "acceptanceCriteria",
	acceptance: "acceptanceCriteria",
	"technical details": "technicalDetails",
	technical: "technicalDetails",
	"root cause": "technicalDetails",
	"root cause analysis": "technicalDetails",
	"bug trace": "technicalDetails",
	"bug tracing": "technicalDetails",
	"call chain": "technicalDetails",
	"file changes": "fileChanges",
	"file-by-file breakdown": "fileChanges",
	"affected files": "fileChanges",
	"change surface": "fileChanges",
	files: "fileChanges",
	"user journey": "userJourney",
	"error scenarios": "errorScenarios",
	"error handling": "errorScenarios",
	"security / compliance": "securityCompliance",
	"security and compliance": "securityCompliance",
	security: "securityCompliance",
	compliance: "securityCompliance",
	"scale / performance": "scalePerformance",
	"scale and performance": "scalePerformance",
	scale: "scalePerformance",
	performance: "scalePerformance",
	"implementation plan": "implementationPlan",
	"implementation changes": "implementationPlan",
	"key changes": "implementationPlan",
	implementation: "implementationPlan",
	"fix plan": "implementationPlan",
	"change plan": "implementationPlan",
	"verification plan": "verificationPlan",
	"test plan": "verificationPlan",
	"testing strategy": "verificationPlan",
	"verification steps": "verificationPlan",
	verification: "verificationPlan",
	validation: "verificationPlan",
	assumptions: "assumptions",
	根因分析: "technicalDetails",
	根本原因: "technicalDetails",
	"bug 追踪链": "technicalDetails",
	调用链: "technicalDetails",
	修改方案: "implementationPlan",
	修复方案: "implementationPlan",
	改动方案: "implementationPlan",
	实施方案: "implementationPlan",
	实施顺序: "implementationPlan",
	修改顺序: "implementationPlan",
	文件变更清单: "fileChanges",
	涉及文件: "fileChanges",
	改动汇总表: "fileChanges",
	改动范围: "fileChanges",
	影响范围: "fileChanges",
	验证方案: "verificationPlan",
	验证计划: "verificationPlan",
	各场景验证: "verificationPlan",
	测试计划: "verificationPlan",
	测试与验证: "verificationPlan",
	验证: "verificationPlan",
	测试: "verificationPlan",
	预期效果: "acceptanceCriteria",
	假设: "assumptions",
};

const IMPLEMENTATION_TITLE_HINT =
	/(implementation|change plan|fix plan|rollout|execution|approach|修改|修复|实施|方案|顺序|阶段)/iu;
const FILE_CHANGE_TITLE_HINT =
	/(affected files|file|files|path|paths|surface|scope|breakdown|涉及文件|文件|路径|改动汇总|改动范围|影响范围)/iu;
const VERIFICATION_TITLE_HINT = /(verification|validation|test|tests|qa|检查|验证|测试|回归)/iu;
const VERIFICATION_CONTENT_HINT =
	/(verify|verification|validate|validation|test|tests|check|checks|测试|验证|检查|回归)/iu;
const CHANGE_SURFACE_HINT =
	/(api|ui|module|component|page|state|service|worker|timeline|storage|registry|parser|agent|工具|模块|组件|页面|状态|服务|渲染|持久化|工作流)/iu;
const FILE_PATH_HINT = /(?:[A-Za-z]:\\|\.{0,2}[\\/])?[\w@.-]+(?:[\\/][\w@.-]+)+(?:\.[A-Za-z0-9_-]+)?/;

export function extractProposedPlanMarkdown(text: string): string | undefined {
	const tagged = text.match(PLAN_TAG_PATTERN)?.[1]?.trim();
	if (tagged) {
		return normalizeMarkdown(tagged);
	}

	if (!/^#\s+/m.test(text) && !/^##\s+/m.test(text)) {
		return undefined;
	}

	return normalizeMarkdown(text);
}

export function stripProposedPlanBlocks(text: string): string {
	if (!text.includes("<proposed_plan>")) {
		return text;
	}

	const stripped = text.replace(/\n?<proposed_plan>[\s\S]*?<\/proposed_plan>\n?/gi, "\n");
	return stripped.replace(/\n{3,}/g, "\n\n").trim();
}

export interface ProposedPlanDisplayState {
	visibleText: string;
	planText?: string;
	complete: boolean;
}

export interface SpecPlanningGateEvaluation {
	ready: boolean;
	missing: string[];
}

const BLOCKED_MESSAGE_TITLE = "# Specification Still In Progress";

const AGENTS_GUIDANCE_HINT =
	/\b(?:agents|claude)\.md\b|project instructions|development rules|coding standards|implementation rules/i;
const DEPENDENCY_REVIEW_HINT =
	/\b(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|npm-shrinkwrap\.json|requirements\.txt|pyproject\.toml|poetry\.lock|cargo\.toml|cargo\.lock|go\.mod|go\.sum|gemfile(?:\.lock)?|pom\.xml|build\.gradle(?:\.kts)?|gradle\.lockfile|composer\.(?:json|lock))\b/i;
const DEPENDENCY_REVIEW_GENERIC_HINT =
	/\b(?:package manifests?|lockfiles?|dependency declarations?|dependency baseline)\b/i;
const NEGATIVE_DEPENDENCY_REVIEW_HINT =
	/\b(?:no files found(?: matching pattern)?|not found|does not exist|no such file|empty directory|empty repo(?:sitory)?|no dependency baseline)\b/i;
const VERSION_RESEARCH_HINT = /\b(?:latest|stable|current|version|versions|release|releases)\b/i;
const FRAMEWORK_OR_PACKAGE_HINT =
	/\b(?:react|react-dom|vite|next(?:\.js)?|vue|angular|svelte|tailwind|solid|astro|nuxt|remix|electron|expo|typescript|node(?:\.js)?|npm|pnpm|yarn|bun)\b/i;
const VERSION_SENSITIVE_TASK_HINT =
	/\b(?:new project|greenfield|scaffold|scaffolding|bootstrap|starter|package\.json|lockfile|dependencies?|dependency|install|upgrade|upgrading|bump|framework|version|versions|package manager|create (?:a |an )?(?:new )?(?:project|app)|init(?:ialize)? (?:a |an )?(?:new )?(?:project|app))\b/i;
const MISSING_LOCAL_GROUNDING = "inspect the local codebase, files, and established implementation patterns";
const MISSING_AGENTS_GUIDANCE = "read AGENTS.md, CLAUDE.md, or equivalent project instructions";
const MISSING_DEPENDENCY_REVIEW = "review package manifests, lockfiles, or equivalent dependency declarations";
const MISSING_ASK =
	"use the ask tool in at least two separate calls to clarify scope, constraints, and version choices";
const MISSING_WEBSEARCH = "run websearch against current official docs, release notes, or authoritative sources";
const MISSING_WEBFETCH = "use webfetch to read a concrete authoritative page";
const MISSING_VERSION_RESEARCH =
	"research official current stable dependency or framework versions relevant to this task";
const AUTO_CONTINUABLE_SPEC_MISSING = new Set([
	MISSING_LOCAL_GROUNDING,
	MISSING_AGENTS_GUIDANCE,
	MISSING_DEPENDENCY_REVIEW,
	MISSING_WEBSEARCH,
	MISSING_WEBFETCH,
	MISSING_VERSION_RESEARCH,
]);

export function createEmptySpecPlanningEvidence(): SpecPlanningEvidence {
	return {
		hasGrounding: false,
		hasAsk: false,
		hasAgentsGuidance: false,
		hasDependencyReview: false,
		askCount: 0,
		hasWebSearch: false,
		hasWebFetch: false,
		hasVersionResearch: false,
	};
}

export function normalizeSpecPlanningEvidence(
	evidence: Partial<SpecPlanningEvidence> | undefined,
): SpecPlanningEvidence {
	const askCount = evidence?.askCount ?? (evidence?.hasAsk ? 1 : 0);
	return {
		hasGrounding: Boolean(evidence?.hasGrounding),
		hasAsk: askCount > 0 || Boolean(evidence?.hasAsk),
		hasAgentsGuidance: Boolean(evidence?.hasAgentsGuidance),
		hasDependencyReview: Boolean(evidence?.hasDependencyReview),
		askCount,
		hasWebSearch: Boolean(evidence?.hasWebSearch),
		hasWebFetch: Boolean(evidence?.hasWebFetch),
		hasVersionResearch: Boolean(evidence?.hasVersionResearch),
	};
}

function collectStringLeaves(value: unknown, output: string[], depth = 0): void {
	if (depth > 3 || value === undefined || value === null) {
		return;
	}
	if (typeof value === "string") {
		output.push(value);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) {
			collectStringLeaves(item, output, depth + 1);
		}
		return;
	}
	if (typeof value === "object") {
		for (const item of Object.values(value)) {
			collectStringLeaves(item, output, depth + 1);
		}
	}
}

function getMessageTextContent(message: Extract<AgentMessage, { role: "toolResult" }>): string {
	return message.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function indexToolCalls(messages: AgentMessage[]): Map<string, { name: string; arguments: Record<string, unknown> }> {
	const calls = new Map<string, { name: string; arguments: Record<string, unknown> }>();
	for (const message of messages) {
		if (message.role !== "assistant") {
			continue;
		}
		for (const part of message.content) {
			if (part.type !== "toolCall") {
				continue;
			}
			calls.set(part.id, { name: part.name, arguments: part.arguments });
		}
	}
	return calls;
}

function buildToolEvidenceContext(input: {
	toolCall?: { name: string; arguments: Record<string, unknown> };
	result: Extract<AgentMessage, { role: "toolResult" }>;
}): string {
	const strings: string[] = [];
	if (input.toolCall) {
		strings.push(input.toolCall.name);
		collectStringLeaves(input.toolCall.arguments, strings);
	}
	collectStringLeaves(input.result.details, strings);
	strings.push(getMessageTextContent(input.result));
	return strings.join("\n");
}

function isAgentsGuidanceEvidence(context: string): boolean {
	return AGENTS_GUIDANCE_HINT.test(context);
}

function isDependencyReviewEvidence(context: string): boolean {
	if (DEPENDENCY_REVIEW_HINT.test(context)) {
		return true;
	}
	return DEPENDENCY_REVIEW_GENERIC_HINT.test(context) && NEGATIVE_DEPENDENCY_REVIEW_HINT.test(context);
}

function isVersionResearchEvidence(input: { toolName: string; context: string }): boolean {
	if (input.toolName !== "websearch" && input.toolName !== "webfetch") {
		return false;
	}
	return VERSION_RESEARCH_HINT.test(input.context) && FRAMEWORK_OR_PACKAGE_HINT.test(input.context);
}

function requiresVersionResearch(input: { requestText?: string; planMarkdown?: string }): boolean {
	const haystack = [input.requestText, input.planMarkdown].filter(Boolean).join("\n");
	if (!haystack) {
		return false;
	}
	if (DEPENDENCY_REVIEW_HINT.test(haystack)) {
		return true;
	}
	return VERSION_SENSITIVE_TASK_HINT.test(haystack) && FRAMEWORK_OR_PACKAGE_HINT.test(haystack);
}

export function collectSpecPlanningEvidence(messages: AgentMessage[]): SpecPlanningEvidence {
	const evidence = createEmptySpecPlanningEvidence();
	const toolCalls = indexToolCalls(messages);

	for (const message of messages) {
		if (message.role !== "toolResult") {
			continue;
		}

		const toolCall = toolCalls.get(message.toolCallId);
		const context = buildToolEvidenceContext({ toolCall, result: message });

		if (LOCAL_GROUNDING_TOOL_NAMES.has(message.toolName)) {
			evidence.hasGrounding = true;
		}
		if (message.toolName === "ask") {
			evidence.hasAsk = true;
			evidence.askCount += 1;
		}
		if (message.toolName === "websearch") {
			evidence.hasWebSearch = true;
		}
		if (message.toolName === "webfetch") {
			evidence.hasWebFetch = true;
		}
		if (isAgentsGuidanceEvidence(context)) {
			evidence.hasAgentsGuidance = true;
		}
		if (isDependencyReviewEvidence(context)) {
			evidence.hasDependencyReview = true;
		}
		if (isVersionResearchEvidence({ toolName: message.toolName, context })) {
			evidence.hasVersionResearch = true;
		}
	}

	return normalizeSpecPlanningEvidence(evidence);
}

export function mergeSpecPlanningEvidence(
	base: SpecPlanningEvidence | undefined,
	delta: SpecPlanningEvidence | undefined,
): SpecPlanningEvidence {
	const normalizedBase = normalizeSpecPlanningEvidence(base);
	const normalizedDelta = normalizeSpecPlanningEvidence(delta);
	return {
		hasGrounding: Boolean(normalizedBase.hasGrounding || normalizedDelta.hasGrounding),
		hasAsk: Boolean(normalizedBase.hasAsk || normalizedDelta.hasAsk),
		hasAgentsGuidance: Boolean(normalizedBase.hasAgentsGuidance || normalizedDelta.hasAgentsGuidance),
		hasDependencyReview: Boolean(normalizedBase.hasDependencyReview || normalizedDelta.hasDependencyReview),
		askCount: normalizedBase.askCount + normalizedDelta.askCount,
		hasWebSearch: Boolean(normalizedBase.hasWebSearch || normalizedDelta.hasWebSearch),
		hasWebFetch: Boolean(normalizedBase.hasWebFetch || normalizedDelta.hasWebFetch),
		hasVersionResearch: Boolean(normalizedBase.hasVersionResearch || normalizedDelta.hasVersionResearch),
	};
}

export function evaluateSpecPlanningGate(input: {
	priorPlanningTurns: number;
	evidence: SpecPlanningEvidence;
	requestText?: string;
	planMarkdown?: string;
}): SpecPlanningGateEvaluation {
	const normalized = normalizeSpecPlanningEvidence(input.evidence);
	const missing: string[] = [];

	if (!normalized.hasGrounding) {
		missing.push(MISSING_LOCAL_GROUNDING);
	}
	if (!normalized.hasAgentsGuidance) {
		missing.push(MISSING_AGENTS_GUIDANCE);
	}
	if (!normalized.hasDependencyReview) {
		missing.push(MISSING_DEPENDENCY_REVIEW);
	}
	if (normalized.askCount < 2) {
		missing.push(MISSING_ASK);
	}
	if (!normalized.hasWebSearch) {
		missing.push(MISSING_WEBSEARCH);
	}
	if (!normalized.hasWebFetch) {
		missing.push(MISSING_WEBFETCH);
	}
	if (
		requiresVersionResearch({
			requestText: input.requestText,
			planMarkdown: input.planMarkdown,
		}) &&
		!normalized.hasVersionResearch
	) {
		missing.push(MISSING_VERSION_RESEARCH);
	}

	return {
		ready: missing.length === 0,
		missing,
	};
}

function getSpecPlanningContinuationSteps(missing: string[]): string[] {
	const steps: string[] = [];

	if (missing.includes(MISSING_ASK)) {
		steps.push("Use the ask tool again to resolve the remaining scope, constraint, or version decisions.");
	}
	if (missing.includes(MISSING_AGENTS_GUIDANCE)) {
		steps.push("Read AGENTS.md, CLAUDE.md, or equivalent project instructions before you draft the next plan.");
	}
	if (missing.includes(MISSING_DEPENDENCY_REVIEW)) {
		steps.push(
			"Review the dependency baseline in package manifests or lockfiles before committing to versions or scaffolding. If the repository is greenfield or empty, explicitly confirm that no dependency baseline exists yet.",
		);
	}
	if (missing.includes(MISSING_LOCAL_GROUNDING)) {
		steps.push("Inspect the local repository structure and established implementation patterns before finalizing.");
	}
	if (missing.includes(MISSING_WEBSEARCH)) {
		steps.push(
			"Search the current official docs, release notes, or equivalent authoritative sources before the next draft.",
		);
	}
	if (missing.includes(MISSING_WEBFETCH)) {
		steps.push(
			"Read at least one concrete authoritative page with webfetch so the next plan is grounded in primary-source details.",
		);
	}
	if (missing.includes(MISSING_VERSION_RESEARCH)) {
		steps.push(
			"Verify the official current stable framework or dependency versions, then confirm any non-default version choice with the user.",
		);
	}
	if (steps.length === 0) {
		steps.push(
			"Continue the planning conversation in read-only mode and gather the remaining evidence before emitting another <proposed_plan>.",
		);
	}

	return [...new Set(steps)];
}

export function shouldAutoContinueSpecPlanning(missing: string[]): boolean {
	return missing.length > 0 && missing.every((item) => AUTO_CONTINUABLE_SPEC_MISSING.has(item));
}

export function buildSpecPlanningContinuationContext(missing: string[]): string {
	const lines = [
		"[SPEC PLANNING CONTINUATION]",
		'Continue specification planning automatically in read-only mode. Do not wait for the user to type "continue".',
		"Gather the missing evidence now, then decide whether <proposed_plan> is finally allowed.",
		"",
		"## Missing Evidence",
		...missing.map((item) => `- ${item}`),
		"",
		"## Requirements For This Turn",
		"- Prioritize read-only investigation over more user questions when the missing evidence is discoverable.",
		"- If dependency review is missing, inspect package manifests and lockfiles now. For an empty or greenfield repository, explicitly state that no dependency baseline exists yet once you have verified that.",
		"- If all required evidence is complete by the end of this turn, emit exactly one <proposed_plan> block.",
		"- If a user decision is still genuinely missing after investigation, explain that specific gap instead of pretending the evidence is complete.",
	];
	return lines.join("\n");
}

export function buildSpecPlanningBlockedMessage(missing: string[]): string {
	const steps = getSpecPlanningContinuationSteps(missing);
	return [
		BLOCKED_MESSAGE_TITLE,
		"",
		"The current specification draft is not ready for approval yet.",
		"",
		"## Missing Prerequisites",
		...missing.map((item) => `- ${item}`),
		"",
		"## Next Step",
		...steps.map((item) => `- ${item}`),
		"",
		"Continue the planning conversation in read-only mode before emitting another `<proposed_plan>`.",
	].join("\n");
}

export function extractProposedPlanDisplayState(text: string): ProposedPlanDisplayState {
	const startIndex = text.indexOf(OPEN_TAG);
	if (startIndex === -1) {
		const partialOpenLength = longestSuffixPrefix(text, OPEN_TAG);
		return {
			visibleText: text.slice(0, text.length - partialOpenLength),
			planText: undefined,
			complete: false,
		};
	}

	const before = text.slice(0, startIndex);
	const afterOpen = text.slice(startIndex + OPEN_TAG.length);
	const closeIndex = afterOpen.indexOf(CLOSE_TAG);

	if (closeIndex === -1) {
		const partialCloseLength = longestSuffixPrefix(afterOpen, CLOSE_TAG);
		return {
			visibleText: before,
			planText: normalizePlanDisplayText(afterOpen.slice(0, afterOpen.length - partialCloseLength)),
			complete: false,
		};
	}

	return {
		visibleText: `${before}${afterOpen.slice(closeIndex + CLOSE_TAG.length)}`,
		planText: normalizePlanDisplayText(afterOpen.slice(0, closeIndex)),
		complete: true,
	};
}

export function extractSpecPlanSections(markdown: string): SpecPlanSection[] {
	const sections: SpecPlanSection[] = [];
	const lines = normalizeMarkdown(markdown).split(/\r?\n/);
	let currentTitle: string | undefined;
	let currentLines: string[] = [];
	let sawTitle = false;

	const pushSection = () => {
		const content = currentLines.join("\n").trim();
		if (!currentTitle && !content) {
			currentLines = [];
			return;
		}
		sections.push({
			title: currentTitle,
			content,
			items: content
				.split(/\r?\n/)
				.map((line) => normalizePlanItem(line))
				.filter((item): item is string => Boolean(item)),
		});
		currentTitle = undefined;
		currentLines = [];
	};

	for (const rawLine of lines) {
		const trimmed = rawLine.trim();
		if (!sawTitle && trimmed.startsWith("# ")) {
			sawTitle = true;
			continue;
		}

		const sectionMatch = trimmed.match(/^##\s+(.+)$/);
		if (sectionMatch) {
			pushSection();
			currentTitle = sectionMatch[1].trim();
			continue;
		}

		currentLines.push(rawLine);
	}

	pushSection();
	return sections;
}

export function parseSpecPlan(message: string): SpecPlan | undefined {
	const markdown = extractProposedPlanMarkdown(message);
	if (!markdown) {
		return undefined;
	}

	const lines = markdown.split(/\r?\n/);
	const sections = extractSpecPlanSections(markdown);
	const buckets = createEmptyBuckets();
	let title = "Specification Plan";

	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (!line) {
			continue;
		}

		if (line.startsWith("# ") && title === "Specification Plan") {
			title = line.slice(2).trim();
			break;
		}
	}

	for (const section of sections) {
		if (!section.title) {
			buckets.summary.push(...section.items);
			continue;
		}

		const bucket = resolveSectionBucket(section);
		if (bucket) {
			buckets[bucket].push(...section.items);
			continue;
		}

		if (buckets.summary.length === 0) {
			buckets.summary.push(...section.items);
		}
	}

	if (!isDecisionCompleteSpec(markdown, sections, buckets)) {
		return undefined;
	}

	return {
		title,
		sections,
		summary: buckets.summary,
		goals: buckets.goals,
		constraints: buckets.constraints,
		acceptanceCriteria: buckets.acceptanceCriteria,
		technicalDetails: buckets.technicalDetails,
		fileChanges: buckets.fileChanges,
		userJourney: buckets.userJourney,
		errorScenarios: buckets.errorScenarios,
		securityCompliance: buckets.securityCompliance,
		scalePerformance: buckets.scalePerformance,
		implementationPlan: buckets.implementationPlan,
		verificationPlan: buckets.verificationPlan,
		assumptions: buckets.assumptions,
		markdown,
	};
}

export function buildSpecPlanningContext(): string {
	return [
		"[SPECIFICATION MODE ACTIVE]",
		"You are collaborating with the user to produce an approved implementation specification before any code is written.",
		"This is a conversation, not a one-shot prompt.",
		"",
		"## Non-Negotiable Rules",
		"- Stay read-only until the user approves a complete plan.",
		"- You may inspect code, search the repository, use read-only shell commands, and delegate to read-only subagents.",
		"- You must not edit files, write files, apply patches, or run mutating shell commands.",
		"- If the user asks for a factual repository inspection (for example git status, current branch, recent commits, changed files, file contents, or symbol search), do the read-only investigation first and answer with the findings instead of forcing a final plan.",
		"- Do not emit <proposed_plan> for greetings, self-introductions, or incomplete requests.",
		"- If the implementation is already decision-complete and the planning gate is satisfied, you may emit <proposed_plan> in the current response.",
		"",
		"## Ask Tool",
		"You have access to an ask tool for interactive clarification.",
		"- ALWAYS call the ask tool during spec planning. Never write clarifying questions as plain assistant text.",
		"- Use the ask tool at least twice in separate calls before you emit <proposed_plan>.",
		"- The first response must include at least one ask tool call after your initial repository inspection.",
		"- Use a later ask call to confirm unresolved constraints, validation expectations, and any dependency or version choices that would change implementation.",
		"- If a missing decision would materially change the implementation, clarify it before you emit <proposed_plan>.",
		"- Never write multiple-choice questions as plain assistant text when ask is the right tool.",
		"",
		"## Workflow",
		"",
		"Phase 1 - Explore and ask (first response):",
		"Inspect AGENTS.md, README, package manifests, lockfiles, and the current codebase before proposing anything.",
		"For a greenfield or empty repository, explicitly search for package manifests and lockfiles. If none exist, say that the repository has no dependency baseline yet and treat that as a completed dependency review.",
		"Identify the existing architecture, established implementation patterns, and the real change surface.",
		"Then call the ask tool with focused questions about scope, constraints, acceptance criteria, and version preferences.",
		"If the implementation is already decision-complete after this exploration and clarification work, you may emit <proposed_plan> in the same response.",
		"",
		"Phase 2 - Investigate and clarify (subsequent responses):",
		"Continue read-only investigation until the implementation is decision-complete.",
		"Use websearch and webfetch against current official or authoritative sources to gather up-to-date background.",
		"If the task touches a new project, scaffolding, package.json, framework selection, dependency installation, or version upgrades, you must verify the official latest stable versions and compatibility before planning.",
		"If the repository already uses older or pinned versions, ask before upgrading away from the current baseline.",
		"If dependency review is still missing, inspect package manifests or lockfiles next before asking the user more questions.",
		"Use the ask tool again in a separate call to confirm unresolved decisions, especially dependency and version choices.",
		"If required evidence is missing, continue the planning conversation instead of emitting the final plan.",
		"Do not end with a dead-end summary like 'I cannot emit the plan yet' without also stating the missing evidence and the next read-only step.",
		"",
		"## Planning Gate",
		"Before you emit <proposed_plan>, all of the following must already be true:",
		"- You inspected the local codebase, relevant files, dependencies, and established patterns.",
		"- You read AGENTS.md, CLAUDE.md, or equivalent project instructions.",
		"- You reviewed package manifests, lockfiles, or equivalent dependency declarations, or explicitly verified that the repository does not have that dependency baseline yet.",
		"- You used the ask tool in at least two separate calls.",
		"- You ran websearch against current official docs, release notes, or other authoritative sources.",
		"- You used webfetch to read a concrete authoritative page.",
		"- For dependency-sensitive tasks, you verified official current stable versions before finalizing.",
		"If a required file, dependency baseline, external source, or user decision is still missing, do not emit <proposed_plan>.",
		"Never present guessed versions, inferred dependencies, or unverified assumptions as confirmed facts.",
		"",
		"## Finalization",
		"Only when the implementation is decision-complete and the planning gate is satisfied, return exactly one <proposed_plan> block in markdown.",
		"If you are not emitting <proposed_plan> yet, continue the planning conversation by either issuing another ask tool call or stating the missing evidence and the next read-only step.",
		"The plan should read like an implementation blueprint, not a rigid universal template.",
		"It must cover the implementation strategy, the affected files or change surface, the recommended change order or phases, and the verification/testing steps.",
		"Choose headings that fit the task. Root cause analysis, fix plan, affected files, implementation order, validation matrix, acceptance criteria, and assumptions are all valid when relevant.",
		"Keep the plan concise but complete enough that another engineer can implement it without making major decisions.",
	].join("\n");
}

export function buildSpecExecutionContext(plan: SpecPlanSections, artifactPath: string | undefined): string {
	const locationLine = artifactPath
		? `Approved spec artifact: ${artifactPath}`
		: "Approved spec artifact: not saved yet";
	return [
		"[EXECUTING APPROVED SPEC]",
		"Implement the approved plan without drifting away from its scope.",
		locationLine,
		"",
		plan.markdown,
	].join("\n");
}

function createEmptyBuckets(): Record<SpecPlanBucket, string[]> {
	return {
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
	};
}

function resolveSectionBucket(section: SpecPlanSection): SpecPlanBucket | undefined {
	if (!section.title) {
		return undefined;
	}

	const normalizedTitle = normalizeSectionTitle(section.title);
	const direct = SECTION_ALIASES[normalizedTitle];
	if (direct) {
		return direct;
	}
	if (VERIFICATION_TITLE_HINT.test(section.title)) {
		return "verificationPlan";
	}
	if (FILE_CHANGE_TITLE_HINT.test(section.title)) {
		return "fileChanges";
	}
	if (IMPLEMENTATION_TITLE_HINT.test(section.title)) {
		return "implementationPlan";
	}
	return undefined;
}

function isDecisionCompleteSpec(
	markdown: string,
	sections: SpecPlanSection[],
	buckets: Record<SpecPlanBucket, string[]>,
): boolean {
	const hasImplementation =
		buckets.implementationPlan.length > 0 ||
		sections.some((section) => Boolean(section.title && IMPLEMENTATION_TITLE_HINT.test(section.title)));
	const hasChangeScope =
		buckets.fileChanges.length > 0 ||
		sections.some((section) => Boolean(section.title && FILE_CHANGE_TITLE_HINT.test(section.title))) ||
		buckets.implementationPlan.length > 0 ||
		buckets.implementationPlan.some((item) => CHANGE_SURFACE_HINT.test(item)) ||
		sections.some((section) => section.items.some((item) => FILE_PATH_HINT.test(item)));
	const hasVerification =
		buckets.verificationPlan.length > 0 ||
		sections.some((section) => Boolean(section.title && VERIFICATION_TITLE_HINT.test(section.title))) ||
		VERIFICATION_CONTENT_HINT.test(markdown);

	return hasImplementation && hasChangeScope && hasVerification;
}

function normalizeMarkdown(markdown: string): string {
	return markdown.replace(/\r\n/g, "\n").trim();
}

function normalizePlanDisplayText(text: string): string | undefined {
	const normalized = text.replace(/\r\n/g, "\n").replace(/^\n+/, "").replace(/\n+$/, "");
	return normalized.trim().length > 0 ? normalized : undefined;
}

function normalizePlanItem(line: string): string | undefined {
	const trimmed = line.trim();
	if (!trimmed || trimmed.startsWith("```") || /^\|?[-:\s|]+\|?$/.test(trimmed)) {
		return undefined;
	}

	const cleaned = trimmed
		.replace(/^#{1,6}\s+/, "")
		.replace(/^[-*+]\s+/, "")
		.replace(/^\d+[.)]\s+/, "")
		.trim();
	return cleaned.length > 0 ? cleaned : undefined;
}

function normalizeSectionTitle(title: string): string {
	return title
		.trim()
		.replace(/[：:]\s*$/, "")
		.toLowerCase();
}

function longestSuffixPrefix(value: string, pattern: string): number {
	const maxLength = Math.min(value.length, pattern.length - 1);
	for (let length = maxLength; length > 0; length -= 1) {
		if (value.endsWith(pattern.slice(0, length))) {
			return length;
		}
	}
	return 0;
}
