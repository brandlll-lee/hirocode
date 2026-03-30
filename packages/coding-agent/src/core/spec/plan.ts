import type { SpecPlan, SpecPlanSection, SpecPlanSections } from "./types.js";

const PLAN_TAG_PATTERN = /<proposed_plan>([\s\S]*?)<\/proposed_plan>/i;
const OPEN_TAG = "<proposed_plan>";
const CLOSE_TAG = "</proposed_plan>";

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
	"change scope": "fileChanges",
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
	changes: "implementationPlan",
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
};

const IMPLEMENTATION_TITLE_HINT = /(implementation|change plan|fix plan|rollout|execution|approach|changes)/iu;
const FILE_CHANGE_TITLE_HINT =
	/(affected files|file|files|path|paths|surface|scope|breakdown|change surface|change scope)/iu;
const VERIFICATION_TITLE_HINT = /(verification|validation|test|tests|qa)/iu;

export interface ProposedPlanDisplayState {
	visibleText: string;
	planText?: string;
	complete: boolean;
}

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
	if (!text.includes(OPEN_TAG)) {
		return text;
	}

	const stripped = text.replace(/\n?<proposed_plan>[\s\S]*?<\/proposed_plan>\n?/gi, "\n");
	return stripped.replace(/\n{3,}/g, "\n\n").trim();
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

	const sections = extractSpecPlanSections(markdown);
	const buckets = createEmptyBuckets();
	let title = "Specification Plan";

	for (const line of markdown.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) {
			continue;
		}
		if (trimmed.startsWith("# ")) {
			title = trimmed.slice(2).trim() || title;
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
		}
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
		.replace(/[:：]\s*$/, "")
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
