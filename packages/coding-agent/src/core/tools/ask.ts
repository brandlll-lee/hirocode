import { Text } from "@hirocode/tui";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "../extensions/types.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface AskOption {
	label: string;
	description?: string;
}

export interface AskQuestion {
	question: string;
	options: AskOption[];
	/** Allow custom text answer in addition to options. Default: true. */
	custom?: boolean;
}

export type AskAnswer = string;

export const askToolSchema = Type.Object(
	{
		questions: Type.Array(
			Type.Object(
				{
					question: Type.String({ description: "Complete question to ask the user" }),
					options: Type.Array(
						Type.Object(
							{
								label: Type.String({ description: "Short choice label (1-5 words)" }),
								description: Type.Optional(Type.String({ description: "Explanation of this choice" })),
							},
							{ additionalProperties: false },
						),
						{ minItems: 1, maxItems: 4, description: "Available choices (1-4 options)" },
					),
					custom: Type.Optional(
						Type.Boolean({
							description:
								"Add a 'Type your own answer' option so the user can provide free text. Default: true.",
						}),
					),
				},
				{ additionalProperties: false },
			),
			{ minItems: 1, maxItems: 4, description: "Questions to ask (1-4)" },
		),
	},
	{ additionalProperties: false },
);

export interface AskToolInput {
	questions: AskQuestion[];
}

// ── Registry (WeakMap, keyed on sessionManager — same pattern as ApprovalManager) ──

type AskHandler = (questions: AskQuestion[]) => Promise<AskAnswer[]>;

const askRegistry = new WeakMap<object, AskHandler>();

export function registerAskHandler(key: object, handler: AskHandler): void {
	askRegistry.set(key, handler);
}

export function getAskHandler(key: object): AskHandler | undefined {
	return askRegistry.get(key);
}

export function unregisterAskHandler(key: object): void {
	askRegistry.delete(key);
}

// ── Tool definition ──────────────────────────────────────────────────────────

export function createAskToolDefinition(): ToolDefinition<typeof askToolSchema> {
	return {
		name: "ask",
		label: "ask",
		description:
			"Ask the user one or more questions with predefined options. Use this tool whenever you need to gather user preferences, clarify requirements, or make decisions during planning. The user will see an interactive selection panel — do NOT write questions as plain text in your message.",
		promptSnippet: "Ask the user focused questions with predefined options",
		promptGuidelines: [
			"Use the ask tool whenever you need clarification, not plain text questions.",
			"Each call can include up to 4 questions, each with 1-4 options.",
			"If you recommend an option, put it first and append '(Recommended)' to its label.",
			"When custom is not set to false, the user can also type their own answer.",
			"Keep option labels short (1-5 words). Use description for elaboration.",
		],
		parameters: askToolSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const handler = ctx?.sessionManager ? getAskHandler(ctx.sessionManager) : undefined;
			if (!handler) {
				throw new Error("Ask tool is unavailable in this session.");
			}

			const answers = await handler(params.questions);

			const lines = params.questions.map((q, i) => `"${q.question}"="${answers[i] ?? ""}"`);
			return {
				content: [
					{
						type: "text",
						text: `User answered your ${params.questions.length} question${params.questions.length > 1 ? "s" : ""}:\n${lines.join("\n")}\n\nYou can now continue with the user's answers in mind.`,
					},
				],
				details: undefined,
			};
		},
		renderCall(args, themeHelper, context) {
			const count = Array.isArray(args.questions) ? args.questions.length : undefined;
			const label =
				count === undefined
					? themeHelper.fg("muted", "(invalid)")
					: themeHelper.fg("accent", `${count} question${count === 1 ? "" : "s"}`);
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(`${themeHelper.fg("toolTitle", themeHelper.bold("ask"))} ${label}`);
			return text;
		},
		renderResult(result, _options, themeHelper, context) {
			const raw = result.content[0];
			const output = raw?.type === "text" ? (raw.text ?? "") : "";
			const short = output.split("\n")[0] ?? output;
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(themeHelper.fg("muted", short));
			return text;
		},
	};
}

export function createAskTool() {
	return wrapToolDefinition(createAskToolDefinition());
}

export const askToolDefinition = createAskToolDefinition();
export const askTool = createAskTool();
