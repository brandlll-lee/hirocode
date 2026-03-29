import { estimateMissionBudget } from "./estimator.js";
import type { MissionFeaturePlan, MissionMilestonePlan, MissionModelSelection, MissionPlan } from "./types.js";

const PLAN_TAG_PATTERN = /<mission_plan>([\s\S]*?)<\/mission_plan>/i;
const PLAN_OPEN_TAG = "<mission_plan>";
const PLAN_CLOSE_TAG = "</mission_plan>";

// ── Display helpers (mirrored from spec/plan.ts) ────────────────────────────

/**
 * Strip <mission_plan>...</mission_plan> blocks from displayed text.
 * Mirrors stripProposedPlanBlocks from spec/plan.ts.
 */
export function stripMissionPlanBlocks(text: string): string {
	if (!text.includes(PLAN_OPEN_TAG)) {
		return text;
	}
	const stripped = text.replace(/(^|\n)[ \t]*<mission_plan>[\s\S]*?<\/mission_plan>[ \t]*(?=\n|$)/gi, "$1");
	return stripped.replace(/\n{3,}/g, "\n\n").trim();
}

export interface MissionPlanDisplayState {
	visibleText: string;
	planText?: string;
	complete: boolean;
}

/**
 * Extract the visible text and streaming plan content while the AI is typing.
 * Mirrors extractProposedPlanDisplayState from spec/plan.ts.
 */
export function extractMissionPlanDisplayState(text: string): MissionPlanDisplayState {
	const startIndex = findMissionPlanBlockStart(text);
	if (startIndex === -1) {
		const partialOpenLength = longestTrailingMissionPlanOpen(text);
		return {
			visibleText: text.slice(0, text.length - partialOpenLength),
			planText: undefined,
			complete: false,
		};
	}

	const before = text.slice(0, startIndex);
	const afterOpen = text.slice(startIndex + PLAN_OPEN_TAG.length);
	const closeIndex = afterOpen.indexOf(PLAN_CLOSE_TAG);

	if (closeIndex === -1) {
		const partialCloseLength = longestSuffixPrefix(afterOpen, PLAN_CLOSE_TAG);
		return {
			visibleText: before,
			planText: normalizePlanDisplayText(afterOpen.slice(0, afterOpen.length - partialCloseLength)),
			complete: false,
		};
	}

	return {
		visibleText: `${before}${afterOpen.slice(closeIndex + PLAN_CLOSE_TAG.length)}`,
		planText: normalizePlanDisplayText(afterOpen.slice(0, closeIndex)),
		complete: true,
	};
}

function findMissionPlanBlockStart(text: string): number {
	const match = /(^|\n)([ \t]*)<mission_plan>/i.exec(text);
	if (!match) {
		return -1;
	}
	return match.index + match[1]!.length + match[2]!.length;
}

function longestTrailingMissionPlanOpen(text: string): number {
	const maxLength = Math.min(text.length, PLAN_OPEN_TAG.length - 1);
	for (let length = maxLength; length > 0; length -= 1) {
		if (!text.endsWith(PLAN_OPEN_TAG.slice(0, length))) {
			continue;
		}
		const startIndex = text.length - length;
		if (isMissionPlanBoundary(text, startIndex)) {
			return length;
		}
	}
	return 0;
}

function isMissionPlanBoundary(text: string, startIndex: number): boolean {
	for (let cursor = startIndex - 1; cursor >= 0; cursor -= 1) {
		const char = text[cursor];
		if (char === "\n") {
			return true;
		}
		if (char !== " " && char !== "\t") {
			return false;
		}
	}
	return true;
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

function normalizePlanDisplayText(text: string): string | undefined {
	const normalized = text.replace(/\r\n/g, "\n").replace(/^\n+/, "").replace(/\n+$/, "");
	return normalized.trim().length > 0 ? normalized : undefined;
}

export interface MissionPlanningSkill {
	name: string;
	description: string;
}

export function looksLikeMissionPlanReadySignal(text: string): boolean {
	const normalized = text.trim().toLowerCase();
	if (!normalized) {
		return false;
	}
	const directPatterns = [
		/\b(confirm|confirmed|approve|approved|proceed|continue|go ahead|looks good|ready|generate the plan)\b/i,
		/(确认|可以|继续|开始|按这个来|就这样|没问题|生成计划|开始生成|确认方案)/,
	];
	return directPatterns.some((pattern) => pattern.test(normalized));
}

export function buildMissionPlanningContext(
	skills?: MissionPlanningSkill[],
	options?: { userConfirmedReady?: boolean },
): string {
	const skillLines: string[] =
		skills && skills.length > 0
			? [
					"Available skills that workers can leverage during execution:",
					...skills.map((skill) => `- ${skill.name}: ${skill.description}`),
					"When assigning features, consider which skills are relevant and note them in the feature description.",
					"",
				]
			: [];
	const readyLines: string[] = options?.userConfirmedReady
		? [
				"[USER CONFIRMED READY TO GENERATE THE PLAN]",
				"The user's latest message is an explicit approval to generate the mission plan now.",
				"In this response, output exactly one <mission_plan> block and no conversational text.",
				"",
			]
		: [];

	return [
		"[MISSION PLANNING MODE ACTIVE]",
		"You are collaborating with the user to plan a large mission before any code is written.",
		"Stay read-only throughout the planning conversation.",
		...readyLines,
		"",
		"## Non-Negotiable Rules",
		"- Do NOT emit a <mission_plan> block in your first response. Never.",
		"- Do NOT emit a <mission_plan> block until the user has confirmed they are ready to proceed.",
		"- Never emit <mission_plan> for a greeting, a vague goal, or an incomplete conversation.",
		"- Never mention the literal tag <mission_plan> in normal conversational text. Only use it when emitting the final block.",
		"- Until the plan is ready, respond with normal conversational text only.",
		"- You may inspect the repository (read-only) to ground your questions.",
		"",
		"## Asking Questions",
		"You have access to an ask tool. Use it whenever you need user input during planning.",
		"- ALWAYS call the ask tool to gather requirements. Never write questions as plain text.",
		"- Each call can include up to 4 questions with up to 4 predefined options each.",
		"- When custom is not set to false, a 'Type your own answer' option is added automatically.",
		"- If you recommend an option, make it the first option and append '(Recommended)' to its label.",
		"- The user will see an interactive selection panel, not a text prompt.",
		"- After an ask tool call returns, you must continue the planning flow in the same turn.",
		"",
		"## Workflow",
		"",
		"Phase 1 — Explore and ask (first response):",
		"Read AGENTS.md, README, and any package.json or equivalent to understand the project.",
		"Then call the ask tool with 2-4 focused questions about scope, constraints, validation strategy, and scale.",
		"Do NOT write questions as plain text. Do not attempt to produce a plan yet.",
		"",
		"Phase 2 — Collaborate (subsequent responses):",
		"Probe for missing decisions: dependencies between features, which milestone each belongs to,",
		"what validation commands exist, and whether parallelism is safe across the proposed features.",
		"Push back if the scope is vague or too large for one mission.",
		"After reviewing ask answers, do exactly one next step: ask another focused batch if key decisions are missing,",
		"or summarize the resolved scope and explicitly ask whether the user wants you to generate the mission plan now.",
		"Do not end with a dead-end summary like 'I can't write code yet' or 'I can't output the plan yet'.",
		"If you are not emitting <mission_plan> yet, you must either continue asking questions or explicitly ask for approval to generate it.",
		"Continue the conversation until all major decisions are resolved.",
		"",
		"Phase 3 — Plan (only when the user confirms readiness):",
		"When the user explicitly says something like 'looks good', 'proceed', 'generate the plan', 'I am ready',",
		"'确认', '可以', '继续', '开始', '按这个来', or equivalent confirmation in any language,",
		"produce exactly one <mission_plan> block containing the JSON below.",
		"Once the user confirms readiness, do not ask for confirmation again.",
		"Do not mix conversational text with the <mission_plan> block in the same response.",
		...skillLines,
		"Return exactly one <mission_plan> block containing strict JSON with this schema:",
		"<mission_plan>",
		"{",
		'  "title": "Short mission title",',
		'  "summary": "One paragraph summary",',
		'  "features": [',
		"    {",
		'      "id": "feature-id",',
		'      "title": "Feature title",',
		'      "description": "What gets built",',
		'      "milestoneId": "milestone-id",',
		'      "dependsOn": ["other-feature-id"],',
		'      "workspacePaths": ["src/auth", "packages/web-ui/src"],',
		'      "agent": "general",',
		'      "validationCommands": ["npm run check"],',
		'      "successCriteria": ["..."],',
		"    }",
		"  ],",
		'  "milestones": [',
		"    {",
		'      "id": "milestone-id",',
		'      "title": "Milestone title",',
		'      "description": "Why this checkpoint matters",',
		'      "featureIds": ["feature-id"],',
		'      "successCriteria": ["..."],',
		'      "validationCommands": ["npm run check"]',
		"    }",
		"  ],",
		'  "successCriteria": ["..."],',
		'  "validationPlan": ["..."],',
		'  "modelStrategy": {',
		'    "planningModel": { "modelArg": "provider/model", "thinkingLevel": "high" },',
		'    "executionModel": { "modelArg": "provider/model" },',
		'    "reviewModel": { "modelArg": "provider/model" },',
		'    "summaryModel": { "modelArg": "provider/model" }',
		"  }",
		"}",
		"</mission_plan>",
		"",
		"Rules:",
		"- features must have unique ids",
		"- milestones must have unique ids",
		"- every feature must reference an existing milestone",
		"- every milestone must list its featureIds",
		"- workspacePaths should be specific enough to reason about parallel safety",
		"- validationCommands should only include commands that the user would reasonably expect to run in this repository",
		"- never end a planning response with only a restatement that you cannot code or cannot emit the plan yet",
	].join("\n");
}

export function parseMissionPlan(goal: string, message: string): MissionPlan | undefined {
	const raw = message.match(PLAN_TAG_PATTERN)?.[1]?.trim();
	if (!raw) {
		return undefined;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}

	if (!parsed || typeof parsed !== "object") {
		return undefined;
	}

	const plan = parsed as Partial<MissionPlan> & {
		features?: unknown[];
		milestones?: unknown[];
		modelStrategy?: Record<string, unknown>;
	};

	if (typeof plan.title !== "string" || typeof plan.summary !== "string") {
		return undefined;
	}

	const features = Array.isArray(plan.features)
		? plan.features.map(normalizeFeature).filter((feature): feature is MissionFeaturePlan => Boolean(feature))
		: [];
	const milestones = Array.isArray(plan.milestones)
		? plan.milestones
				.map(normalizeMilestone)
				.filter((milestone): milestone is MissionMilestonePlan => Boolean(milestone))
		: [];

	if (features.length === 0 || milestones.length === 0) {
		return undefined;
	}

	const milestoneIds = new Set(milestones.map((milestone) => milestone.id));
	const featureIds = new Set(features.map((feature) => feature.id));
	if (featureIds.size !== features.length || milestoneIds.size !== milestones.length) {
		return undefined;
	}

	for (const feature of features) {
		if (!milestoneIds.has(feature.milestoneId)) {
			return undefined;
		}
		if (feature.dependsOn.some((dependency) => dependency === feature.id)) {
			return undefined;
		}
	}

	for (const milestone of milestones) {
		if (milestone.featureIds.some((featureId) => !featureIds.has(featureId))) {
			return undefined;
		}
	}

	const modelStrategy = normalizeModelStrategy(plan.modelStrategy);
	const normalized: MissionPlan = {
		title: plan.title.trim(),
		goal,
		summary: plan.summary.trim(),
		features,
		milestones,
		successCriteria: normalizeStringArray(plan.successCriteria),
		validationPlan: normalizeStringArray(plan.validationPlan),
		modelStrategy,
		budgetEstimate: estimateMissionBudget({ features, milestones }),
		markdown: buildMissionPlanMarkdown(
			goal,
			plan.title.trim(),
			plan.summary.trim(),
			features,
			milestones,
			normalizeStringArray(plan.successCriteria),
			normalizeStringArray(plan.validationPlan),
			modelStrategy,
		),
	};

	return normalized;
}

export function buildMissionPlanMarkdown(
	goal: string,
	title: string,
	summary: string,
	features: MissionFeaturePlan[],
	milestones: MissionMilestonePlan[],
	successCriteria: string[],
	validationPlan: string[],
	modelStrategy: MissionPlan["modelStrategy"],
): string {
	const lines = [`# ${title}`, "", summary, "", "## Goal", `- ${goal}`, "", "## Features"];

	for (const feature of features) {
		lines.push(`### ${feature.title} ( ${feature.id})`);
		lines.push(`- Milestone: ${feature.milestoneId}`);
		lines.push(`- Description: ${feature.description}`);
		lines.push(`- Depends on: ${feature.dependsOn.length > 0 ? feature.dependsOn.join(", ") : "none"}`);
		lines.push(
			`- Workspace paths: ${feature.workspacePaths.length > 0 ? feature.workspacePaths.join(", ") : "(not specified)"}`,
		);
		lines.push(`- Agent: ${feature.agent ?? "general"}`);
		if (feature.successCriteria.length > 0) {
			lines.push("- Success criteria:");
			for (const criterion of feature.successCriteria) {
				lines.push(`  - ${criterion}`);
			}
		}
		if (feature.validationCommands && feature.validationCommands.length > 0) {
			lines.push(`- Validation commands: ${feature.validationCommands.join(", ")}`);
		}
		lines.push("");
	}

	lines.push("## Milestones");
	for (const milestone of milestones) {
		lines.push(`### ${milestone.title} ( ${milestone.id})`);
		lines.push(`- Description: ${milestone.description}`);
		lines.push(`- Features: ${milestone.featureIds.join(", ")}`);
		if (milestone.successCriteria.length > 0) {
			lines.push("- Success criteria:");
			for (const criterion of milestone.successCriteria) {
				lines.push(`  - ${criterion}`);
			}
		}
		if (milestone.validationCommands && milestone.validationCommands.length > 0) {
			lines.push(`- Validation commands: ${milestone.validationCommands.join(", ")}`);
		}
		lines.push("");
	}

	if (successCriteria.length > 0) {
		lines.push("## Mission Success Criteria");
		for (const criterion of successCriteria) {
			lines.push(`- ${criterion}`);
		}
		lines.push("");
	}

	if (validationPlan.length > 0) {
		lines.push("## Validation Plan");
		for (const step of validationPlan) {
			lines.push(`- ${step}`);
		}
		lines.push("");
	}

	lines.push("## Model Strategy");
	lines.push(`- Planning: ${formatModelSelection(modelStrategy.planningModel)}`);
	lines.push(`- Execution: ${formatModelSelection(modelStrategy.executionModel)}`);
	lines.push(`- Review: ${formatModelSelection(modelStrategy.reviewModel)}`);
	lines.push(`- Summary: ${formatModelSelection(modelStrategy.summaryModel)}`);

	return lines.join("\n").replace(/\u0000/g, "`");
}

function normalizeFeature(value: unknown): MissionFeaturePlan | undefined {
	if (!value || typeof value !== "object") return undefined;
	const feature = value as Partial<MissionFeaturePlan>;
	if (
		typeof feature.id !== "string" ||
		typeof feature.title !== "string" ||
		typeof feature.description !== "string" ||
		typeof feature.milestoneId !== "string"
	) {
		return undefined;
	}
	return {
		id: feature.id.trim(),
		title: feature.title.trim(),
		description: feature.description.trim(),
		milestoneId: feature.milestoneId.trim(),
		dependsOn: normalizeStringArray(feature.dependsOn),
		workspacePaths: normalizeStringArray(feature.workspacePaths),
		agent: typeof feature.agent === "string" ? feature.agent.trim() : undefined,
		validationCommands: normalizeStringArray(feature.validationCommands),
		successCriteria: normalizeStringArray(feature.successCriteria),
	};
}

function normalizeMilestone(value: unknown): MissionMilestonePlan | undefined {
	if (!value || typeof value !== "object") return undefined;
	const milestone = value as Partial<MissionMilestonePlan>;
	if (
		typeof milestone.id !== "string" ||
		typeof milestone.title !== "string" ||
		typeof milestone.description !== "string"
	) {
		return undefined;
	}
	return {
		id: milestone.id.trim(),
		title: milestone.title.trim(),
		description: milestone.description.trim(),
		featureIds: normalizeStringArray(milestone.featureIds),
		successCriteria: normalizeStringArray(milestone.successCriteria),
		validationCommands: normalizeStringArray(milestone.validationCommands),
	};
}

function normalizeModelStrategy(value: unknown): MissionPlan["modelStrategy"] {
	if (!value || typeof value !== "object") {
		return {};
	}
	const strategy = value as Record<string, unknown>;
	return {
		planningModel: normalizeModelSelection(strategy.planningModel),
		executionModel: normalizeModelSelection(strategy.executionModel),
		reviewModel: normalizeModelSelection(strategy.reviewModel),
		summaryModel: normalizeModelSelection(strategy.summaryModel),
	};
}

function normalizeModelSelection(value: unknown): MissionModelSelection | undefined {
	if (!value || typeof value !== "object") {
		return undefined;
	}
	const selection = value as Partial<MissionModelSelection>;
	if (typeof selection.modelArg !== "string") {
		return undefined;
	}
	return {
		modelArg: selection.modelArg,
		provider: typeof selection.provider === "string" ? selection.provider : undefined,
		modelId: typeof selection.modelId === "string" ? selection.modelId : undefined,
		thinkingLevel: typeof selection.thinkingLevel === "string" ? selection.thinkingLevel : undefined,
	};
}

function normalizeStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
}

function formatModelSelection(selection: MissionModelSelection | undefined): string {
	if (!selection) return "inherit";
	return selection.thinkingLevel ? `${selection.modelArg}:${selection.thinkingLevel}` : selection.modelArg;
}
