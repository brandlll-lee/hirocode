import { randomUUID } from "node:crypto";
import type { CustomEntry, ReadonlySessionManager, SessionManager } from "../session-manager.js";
import { extractSpecPlanSections } from "./plan.js";
import type { SpecPlanSections, SpecSessionState } from "./types.js";

export const SPEC_STATE_CUSTOM_TYPE = "hirocode.spec.state";

export function readLatestSpecState(sessionManager: ReadonlySessionManager): SpecSessionState | undefined {
	const entries = sessionManager.getEntries();
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry.type !== "custom" || entry.customType !== SPEC_STATE_CUSTOM_TYPE) {
			continue;
		}
		if (isSpecSessionState(entry.data)) {
			return normalizeSpecSessionState(entry.data);
		}
	}
	return undefined;
}

export function writeSpecState(
	sessionManager: SessionManager,
	state: Omit<SpecSessionState, "updatedAt">,
): SpecSessionState {
	const next: SpecSessionState = {
		...state,
		updatedAt: new Date().toISOString(),
	};
	const normalized = normalizeSpecSessionState(next);
	sessionManager.appendCustomEntry(SPEC_STATE_CUSTOM_TYPE, normalized);
	return normalized;
}

export function createSpecState(overrides?: Partial<SpecSessionState>): SpecSessionState {
	const phase = overrides?.phase ?? "inactive";
	return {
		id: overrides?.id ?? randomUUID(),
		maskEnabled: overrides?.maskEnabled ?? (overrides?.phase !== undefined ? overrides.phase !== "inactive" : false),
		phase,
		updatedAt: overrides?.updatedAt ?? new Date().toISOString(),
		title: overrides?.title,
		request: overrides?.request,
		artifactPath: overrides?.artifactPath,
		plan: overrides?.plan,
		planningModel: overrides?.planningModel,
		previousModel: overrides?.previousModel,
		previousActiveTools: overrides?.previousActiveTools,
		approvedAt: overrides?.approvedAt,
	};
}

export function createInactiveSpecState(state: SpecSessionState | undefined): SpecSessionState {
	return createSpecState({
		...state,
		maskEnabled: false,
		phase: "inactive",
		previousModel: undefined,
		previousActiveTools: undefined,
	});
}

export function specHasPlan(
	state: SpecSessionState | undefined,
): state is SpecSessionState & { plan: SpecPlanSections } {
	return Boolean(state?.plan);
}

export function isSpecArmedForNextTurn(state: SpecSessionState | undefined): boolean {
	return Boolean(state && state.phase === "planning");
}

export function hasPendingSpecPlan(
	state: SpecSessionState | undefined,
): state is SpecSessionState & { plan: SpecPlanSections } {
	return Boolean(specHasPlan(state) && state.phase === "approved");
}

function normalizeSpecSessionState(state: SpecSessionState): SpecSessionState {
	if (state.phase === "planning" && state.maskEnabled === false) {
		return createInactiveSpecState(state);
	}

	return {
		...state,
		maskEnabled: state.maskEnabled ?? state.phase !== "inactive",
		plan: state.plan ? normalizeSpecPlan(state.plan) : undefined,
	};
}

function normalizeSpecPlan(plan: SpecPlanSections): SpecPlanSections {
	return {
		title: plan.title,
		sections: plan.sections ?? extractSpecPlanSections(plan.markdown),
		summary: plan.summary ?? [],
		goals: plan.goals ?? [],
		constraints: plan.constraints ?? [],
		acceptanceCriteria: plan.acceptanceCriteria ?? [],
		technicalDetails: plan.technicalDetails ?? [],
		fileChanges: plan.fileChanges ?? [],
		userJourney: plan.userJourney ?? [],
		errorScenarios: plan.errorScenarios ?? [],
		securityCompliance: plan.securityCompliance ?? [],
		scalePerformance: plan.scalePerformance ?? [],
		implementationPlan: plan.implementationPlan ?? [],
		verificationPlan: plan.verificationPlan ?? [],
		assumptions: plan.assumptions ?? [],
		markdown: plan.markdown,
	};
}

function isSpecSessionState(value: unknown): value is SpecSessionState {
	if (!value || typeof value !== "object") {
		return false;
	}

	const state = value as Partial<SpecSessionState>;
	if (typeof state.id !== "string" || typeof state.phase !== "string" || typeof state.updatedAt !== "string") {
		return false;
	}
	if (state.maskEnabled !== undefined && typeof state.maskEnabled !== "boolean") {
		return false;
	}

	if (state.plan !== undefined && !isSpecPlanSections(state.plan)) {
		return false;
	}

	return true;
}

function isSpecPlanSections(value: unknown): value is SpecPlanSections {
	if (!value || typeof value !== "object") {
		return false;
	}
	const plan = value as Partial<SpecPlanSections>;
	return (
		typeof plan.title === "string" &&
		(plan.sections === undefined ||
			(Array.isArray(plan.sections) &&
				plan.sections.every(
					(section) =>
						section &&
						typeof section === "object" &&
						((section as { title?: unknown }).title === undefined ||
							typeof (section as { title?: unknown }).title === "string") &&
						typeof (section as { content?: unknown }).content === "string" &&
						Array.isArray((section as { items?: unknown }).items),
				))) &&
		(plan.summary === undefined || Array.isArray(plan.summary)) &&
		(plan.goals === undefined || Array.isArray(plan.goals)) &&
		(plan.constraints === undefined || Array.isArray(plan.constraints)) &&
		(plan.acceptanceCriteria === undefined || Array.isArray(plan.acceptanceCriteria)) &&
		(plan.technicalDetails === undefined || Array.isArray(plan.technicalDetails)) &&
		(plan.fileChanges === undefined || Array.isArray(plan.fileChanges)) &&
		(plan.userJourney === undefined || Array.isArray(plan.userJourney)) &&
		(plan.errorScenarios === undefined || Array.isArray(plan.errorScenarios)) &&
		(plan.securityCompliance === undefined || Array.isArray(plan.securityCompliance)) &&
		(plan.scalePerformance === undefined || Array.isArray(plan.scalePerformance)) &&
		(plan.implementationPlan === undefined || Array.isArray(plan.implementationPlan)) &&
		(plan.verificationPlan === undefined || Array.isArray(plan.verificationPlan)) &&
		(plan.assumptions === undefined || Array.isArray(plan.assumptions)) &&
		typeof plan.markdown === "string"
	);
}

export function getSpecStateEntry(entry: CustomEntry<unknown>): SpecSessionState | undefined {
	return entry.customType === SPEC_STATE_CUSTOM_TYPE && isSpecSessionState(entry.data) ? entry.data : undefined;
}
