import type { AgentTool } from "@hirocode/agent-core";
import { Text } from "@hirocode/tui";
import { type Static, Type } from "@sinclair/typebox";
import TurndownService from "turndown";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.js";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.js";
import { getTextOutput, invalidArgText, str } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from "./truncate.js";

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 120;
const USER_AGENT =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

const webFetchSchema = Type.Object({
	url: Type.String({ description: "The URL to fetch content from" }),
	format: Type.Optional(
		Type.Union([Type.Literal("text"), Type.Literal("markdown"), Type.Literal("html")], {
			description: "The format to return the content in (text, markdown, or html). Defaults to markdown.",
		}),
	),
	timeout: Type.Optional(Type.Number({ description: "Optional timeout in seconds (max 120)" })),
});

export type WebFetchToolInput = Static<typeof webFetchSchema>;

export interface WebFetchToolDetails {
	title: string;
	url: string;
	format: "text" | "markdown" | "html";
	mimeType: string;
	truncated?: boolean;
	status: number;
}

function getAcceptHeader(format: "text" | "markdown" | "html"): string {
	if (format === "markdown") {
		return "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1";
	}
	if (format === "text") {
		return "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1";
	}
	return "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1";
}

function convertHtmlToMarkdown(html: string): string {
	const turndown = new TurndownService({
		headingStyle: "atx",
		hr: "---",
		bulletListMarker: "-",
		codeBlockStyle: "fenced",
		emDelimiter: "*",
	});
	turndown.remove(["script", "style", "meta", "link"]);
	return turndown.turndown(html);
}

function decodeHtmlEntities(text: string): string {
	return text
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'");
}

function extractTextFromHtml(html: string): string {
	const withoutIgnoredBlocks = html
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
		.replace(/<iframe[\s\S]*?<\/iframe>/gi, " ")
		.replace(/<object[\s\S]*?<\/object>/gi, " ")
		.replace(/<embed[\s\S]*?>/gi, " ");
	const withBreaks = withoutIgnoredBlocks
		.replace(/<(\/p|\/div|\/section|\/article|\/li|br\s*\/?)>/gi, "\n")
		.replace(/<[^>]+>/g, " ");
	return decodeHtmlEntities(withBreaks)
		.replace(/\r/g, "")
		.replace(/[ \t]+/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function formatWebFetchCall(
	args: { url?: string; format?: string } | undefined,
	theme: typeof import("../../modes/interactive/theme/theme.js").theme,
): string {
	const url = str(args?.url);
	const format = str(args?.format) ?? "markdown";
	const urlText = url === null ? invalidArgText(theme) : theme.fg("accent", url || "...");
	return `${theme.fg("toolTitle", theme.bold("webfetch"))} ${urlText}${theme.fg("toolOutput", ` (${format})`)}`;
}

function formatWebFetchResult(
	result: { content: Array<{ type: string; text?: string }>; details?: WebFetchToolDetails },
	options: ToolRenderResultOptions,
	theme: typeof import("../../modes/interactive/theme/theme.js").theme,
	showImages: boolean,
): string {
	const output = getTextOutput(result as never, showImages).trim();
	if (!output) {
		return `
${theme.fg("muted", "No content fetched.")}`;
	}

	const lines = output.split("\n");
	const maxLines = options.expanded ? lines.length : 16;
	const displayLines = lines.slice(0, maxLines);
	const remaining = lines.length - maxLines;
	let text = `
${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
	if (remaining > 0) {
		text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")})`;
	}

	if (result.details?.truncated) {
		text += `
${theme.fg("warning", `[Truncated to ${formatSize(DEFAULT_MAX_BYTES)} for display]`)}`;
	}
	return text;
}

export function createWebFetchToolDefinition(): ToolDefinition<typeof webFetchSchema, WebFetchToolDetails | undefined> {
	return {
		name: "webfetch",
		label: "webfetch",
		description:
			"Fetch content from a specified URL. Takes a URL and optional format as input, fetches the URL content, converts to the requested format, and returns the result. Use this tool when you need to retrieve and analyze web content.",
		promptSnippet: "Fetch content from a URL (text, markdown, or html)",
		promptGuidelines: [
			"Use webfetch when you need the contents of a specific URL instead of scraping via shell commands.",
			"If another tool is more targeted or has fewer restrictions for the task, prefer that tool over webfetch.",
			"The URL must be fully formed and begin with http:// or https://.",
			"Use format='markdown' by default for webpages unless the user explicitly wants raw html or plain text.",
		],
		parameters: webFetchSchema,
		async execute(_toolCallId, params, signal) {
			if (!params.url.startsWith("http://") && !params.url.startsWith("https://")) {
				throw new Error("URL must start with http:// or https://");
			}

			const format = params.format ?? "markdown";
			const timeoutSeconds = Math.min(params.timeout ?? DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS);
			const timeoutSignal = AbortSignal.timeout(timeoutSeconds * 1000);
			const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

			const headers = {
				"User-Agent": USER_AGENT,
				Accept: getAcceptHeader(format),
				"Accept-Language": "en-US,en;q=0.9",
			};

			try {
				const initial = await fetch(params.url, { signal: requestSignal, headers });
				const response =
					initial.status === 403 && initial.headers.get("cf-mitigated") === "challenge"
						? await fetch(params.url, {
								signal: requestSignal,
								headers: { ...headers, "User-Agent": "hirocode" },
							})
						: initial;

				if (!response.ok) {
					throw new Error(`Request failed with status code: ${response.status}`);
				}

				const contentLength = response.headers.get("content-length");
				if (contentLength && Number.parseInt(contentLength, 10) > MAX_RESPONSE_SIZE) {
					throw new Error("Response too large (exceeds 5MB limit)");
				}

				const arrayBuffer = await response.arrayBuffer();
				if (arrayBuffer.byteLength > MAX_RESPONSE_SIZE) {
					throw new Error("Response too large (exceeds 5MB limit)");
				}

				const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
				const title = `${params.url} (${mimeType || "unknown"})`;
				const bytes = Buffer.from(arrayBuffer);

				if (
					mimeType.startsWith("image/") &&
					mimeType !== "image/svg+xml" &&
					mimeType !== "image/vnd.fastbidsheet"
				) {
					return {
						content: [
							{ type: "text", text: "Image fetched successfully" },
							{ type: "image", data: bytes.toString("base64"), mimeType },
						],
						details: {
							title,
							url: params.url,
							format,
							mimeType,
							status: response.status,
						},
					};
				}

				const rawContent = new TextDecoder().decode(arrayBuffer);
				let output = rawContent;
				if (format === "markdown" && mimeType.includes("text/html")) {
					output = convertHtmlToMarkdown(rawContent);
				} else if (format === "text" && mimeType.includes("text/html")) {
					output = extractTextFromHtml(rawContent);
				}

				const truncation = truncateHead(output, { maxBytes: DEFAULT_MAX_BYTES, maxLines: 4000 });
				return {
					content: [{ type: "text", text: truncation.content }],
					details: {
						title,
						url: params.url,
						format,
						mimeType,
						truncated: truncation.truncated,
						status: response.status,
					},
				};
			} catch (error) {
				if (error instanceof Error && error.name === "AbortError") {
					throw new Error("Web fetch request timed out");
				}
				throw error;
			}
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatWebFetchCall(args, theme));
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatWebFetchResult(result as never, options, theme, context.showImages));
			return text;
		},
	};
}

export function createWebFetchTool(): AgentTool<typeof webFetchSchema> {
	return wrapToolDefinition(createWebFetchToolDefinition());
}

export const webFetchToolDefinition = createWebFetchToolDefinition();
export const webFetchTool = createWebFetchTool();
