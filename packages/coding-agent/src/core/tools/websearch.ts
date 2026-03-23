import type { AgentTool } from "@hirocode/agent-core";
import { Text } from "@hirocode/tui";
import { type Static, Type } from "@sinclair/typebox";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.js";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.js";
import { getTextOutput, invalidArgText, str } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

const EXA_BASE_URL = "https://mcp.exa.ai";
const EXA_SEARCH_PATH = "/mcp";
const DEFAULT_NUM_RESULTS = 8;
const DEFAULT_TIMEOUT_MS = 25_000;

const webSearchSchema = Type.Object({
	query: Type.String({ description: "Web search query" }),
	numResults: Type.Optional(Type.Number({ description: "Number of search results to return (default: 8)" })),
	livecrawl: Type.Optional(
		Type.Union([Type.Literal("fallback"), Type.Literal("preferred")], {
			description:
				"Live crawl mode - 'fallback': use live crawling as backup if cached content unavailable, 'preferred': prioritize live crawling",
		}),
	),
	type: Type.Optional(
		Type.Union([Type.Literal("auto"), Type.Literal("fast"), Type.Literal("deep")], {
			description: "Search type - 'auto': balanced, 'fast': quick results, 'deep': comprehensive search",
		}),
	),
	contextMaxCharacters: Type.Optional(
		Type.Number({ description: "Maximum characters for context string optimized for LLMs" }),
	),
});

export type WebSearchToolInput = Static<typeof webSearchSchema>;

export interface WebSearchToolDetails {
	title: string;
	provider: "exa";
	query: string;
	numResults: number;
	livecrawl: "fallback" | "preferred";
	type: "auto" | "fast" | "deep";
	contextMaxCharacters?: number;
}

interface McpSearchRequest {
	jsonrpc: "2.0";
	id: number;
	method: "tools/call";
	params: {
		name: "web_search_exa";
		arguments: {
			query: string;
			numResults?: number;
			livecrawl?: "fallback" | "preferred";
			type?: "auto" | "fast" | "deep";
			contextMaxCharacters?: number;
		};
	};
}

interface McpSearchResponse {
	jsonrpc: string;
	result?: {
		content?: Array<{
			type: string;
			text: string;
		}>;
	};
}

function formatWebSearchCall(
	args: { query?: string } | undefined,
	theme: typeof import("../../modes/interactive/theme/theme.js").theme,
): string {
	const query = str(args?.query);
	return `${theme.fg("toolTitle", theme.bold("websearch"))} ${query === null ? invalidArgText(theme) : theme.fg("accent", query || "...")}`;
}

function formatWebSearchResult(
	result: { content: Array<{ type: string; text?: string }>; details?: WebSearchToolDetails },
	options: ToolRenderResultOptions,
	theme: typeof import("../../modes/interactive/theme/theme.js").theme,
	showImages: boolean,
): string {
	const output = getTextOutput(result as never, showImages).trim();
	if (!output) {
		return `
${theme.fg("muted", "No search results found.")}`;
	}

	const lines = output.split("\n");
	const maxLines = options.expanded ? lines.length : 14;
	const displayLines = lines.slice(0, maxLines);
	const remaining = lines.length - maxLines;
	let text = `
${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
	if (remaining > 0) {
		text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")})`;
	}
	return text;
}

function parseSseText(text: string): string | undefined {
	const lines = text.split("\n");
	for (const line of lines) {
		if (!line.startsWith("data: ")) {
			continue;
		}

		const payload = JSON.parse(line.slice(6)) as McpSearchResponse;
		const content = payload.result?.content?.[0]?.text;
		if (content) {
			return content;
		}
	}

	return undefined;
}

export function createWebSearchToolDefinition(): ToolDefinition<
	typeof webSearchSchema,
	WebSearchToolDetails | undefined
> {
	return {
		name: "websearch",
		label: "websearch",
		description:
			"Search the web using Exa AI. Performs real-time web searches, supports configurable result counts and live crawling, and returns current information beyond the model knowledge cutoff.",
		promptSnippet: "Search the web for current information and recent updates",
		promptGuidelines: [
			"Use websearch for up-to-date information instead of guessing from model memory.",
			"Include the current year in search queries when the user asks for the latest information.",
			"Prefer websearch over shell-based HTTP calls when the user asks you to search the web.",
			"Use type='auto' unless the user explicitly needs fast or deep search behavior.",
		],
		parameters: webSearchSchema,
		async execute(_toolCallId, params, signal) {
			const timeoutSignal = AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
			const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
			const request: McpSearchRequest = {
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: {
					name: "web_search_exa",
					arguments: {
						query: params.query,
						type: params.type ?? "auto",
						numResults: params.numResults ?? DEFAULT_NUM_RESULTS,
						livecrawl: params.livecrawl ?? "fallback",
						contextMaxCharacters: params.contextMaxCharacters,
					},
				},
			};

			try {
				const response = await fetch(`${EXA_BASE_URL}${EXA_SEARCH_PATH}`, {
					method: "POST",
					headers: {
						accept: "application/json, text/event-stream",
						"content-type": "application/json",
					},
					body: JSON.stringify(request),
					signal: requestSignal,
				});

				if (!response.ok) {
					const errorText = await response.text();
					throw new Error(`Search error (${response.status}): ${errorText}`);
				}

				const text = await response.text();
				const output = parseSseText(text) ?? "No search results found. Please try a different query.";
				return {
					content: [{ type: "text", text: output }],
					details: {
						title: `Web search: ${params.query}`,
						provider: "exa",
						query: params.query,
						numResults: params.numResults ?? DEFAULT_NUM_RESULTS,
						livecrawl: params.livecrawl ?? "fallback",
						type: params.type ?? "auto",
						contextMaxCharacters: params.contextMaxCharacters,
					},
				};
			} catch (error) {
				if (error instanceof Error && error.name === "AbortError") {
					throw new Error("Web search request timed out");
				}
				throw error;
			}
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatWebSearchCall(args, theme));
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatWebSearchResult(result as never, options, theme, context.showImages));
			return text;
		},
	};
}

export function createWebSearchTool(): AgentTool<typeof webSearchSchema> {
	return wrapToolDefinition(createWebSearchToolDefinition());
}

export const webSearchToolDefinition = createWebSearchToolDefinition();
export const webSearchTool = createWebSearchTool();
