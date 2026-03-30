import type { ThinkingLevel } from "@hirocode/agent-core";

export type SpecPhase = "inactive" | "planning" | "approved" | "executing";

export interface SpecPlanSection {
	title?: string;
	content: string;
	items: string[];
}

export interface SpecPlan {
	title: string;
	sections: SpecPlanSection[];
	summary: string[];
	goals: string[];
	constraints: string[];
	acceptanceCriteria: string[];
	technicalDetails: string[];
	fileChanges: string[];
	userJourney: string[];
	errorScenarios: string[];
	securityCompliance: string[];
	scalePerformance: string[];
	implementationPlan: string[];
	verificationPlan: string[];
	assumptions: string[];
	markdown: string;
}

export type SpecPlanSections = SpecPlan;

export interface SpecSessionState {
	id: string;
	maskEnabled?: boolean;
	phase: SpecPhase;
	updatedAt: string;
	title?: string;
	request?: string;
	artifactPath?: string;
	plan?: SpecPlan;
	planningModel?: {
		modelArg: string;
		provider?: string;
		modelId?: string;
		thinkingLevel?: ThinkingLevel;
	};
	previousModel?: {
		provider?: string;
		modelId?: string;
		thinkingLevel?: ThinkingLevel;
	};
	previousActiveTools?: string[];
	approvedAt?: string;
}
