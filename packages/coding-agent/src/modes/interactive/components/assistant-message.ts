import type { AssistantMessage } from "@hirocode/ai";
import { Container, Markdown, type MarkdownTheme, Spacer, Text } from "@hirocode/tui";
import { stripMissionPlanBlocks } from "../../../core/missions/planner.js";
import { stripProposedPlanBlocks } from "../../../core/spec/plan.js";
import { getMarkdownTheme, theme } from "../theme/theme.js";

function stripAllPlanBlocks(text: string): string {
	return stripMissionPlanBlocks(stripProposedPlanBlocks(text));
}

/**
 * Sanitize an error message for display.
 * Strips HTML, extracts status codes, and truncates to a readable single-line summary.
 */
function sanitizeErrorMessage(raw: string): string {
	// Detect HTTP error with HTML body (e.g. "522 <!DOCTYPE html>...")
	const httpMatch = raw.match(/^(\d{3})\s+<!DOCTYPE/i);
	if (httpMatch) {
		const code = httpMatch[1];
		// Common Cloudflare/CDN codes
		const descriptions: Record<string, string> = {
			"522": "Connection timed out",
			"521": "Web server is down",
			"520": "Unknown error",
			"524": "A timeout occurred",
			"502": "Bad gateway",
			"503": "Service unavailable",
			"504": "Gateway timeout",
		};
		const desc = descriptions[code] ?? "Server error";
		return `HTTP ${code}: ${desc}`;
	}
	// Strip any HTML tags and collapse whitespace
	const stripped = raw
		.replace(/<[^>]*>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	// Take only the first line / first 200 chars
	const firstLine = stripped.split(/[\r\n]/)[0] ?? stripped;
	return firstLine.length > 200 ? `${firstLine.slice(0, 197)}...` : firstLine;
}

/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
	private contentContainer: Container;
	private hideThinkingBlock: boolean;
	private markdownTheme: MarkdownTheme;
	private lastMessage?: AssistantMessage;

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
	) {
		super();

		this.hideThinkingBlock = hideThinkingBlock;
		this.markdownTheme = markdownTheme;

		// Container for text/thinking content
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	override invalidate(): void {
		super.invalidate();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
	}

	updateContent(message: AssistantMessage): void {
		this.lastMessage = message;

		// Clear content container
		this.contentContainer.clear();

		const hasVisibleContent = message.content.some(
			(c) =>
				(c.type === "text" && stripAllPlanBlocks(c.text).trim()) || (c.type === "thinking" && c.thinking.trim()),
		);

		if (hasVisibleContent) {
			this.contentContainer.addChild(new Spacer(1));
		}

		// Render content in order
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && content.text.trim()) {
				const visibleText = stripAllPlanBlocks(content.text).trim();
				if (!visibleText) {
					continue;
				}
				// Assistant text messages with no background - trim the text
				// Set paddingY=0 to avoid extra spacing before tool executions
				this.contentContainer.addChild(new Markdown(visibleText, 1, 0, this.markdownTheme));
			} else if (content.type === "thinking" && content.thinking.trim()) {
				// Add spacing only when another visible assistant content block follows.
				// This avoids a superfluous blank line before separately-rendered tool execution blocks.
				const hasVisibleContentAfter = message.content
					.slice(i + 1)
					.some(
						(c) =>
							(c.type === "text" && stripAllPlanBlocks(c.text).trim()) ||
							(c.type === "thinking" && c.thinking.trim()),
					);

				if (this.hideThinkingBlock) {
					// Show static "Thinking..." label when hidden
					this.contentContainer.addChild(new Text(theme.italic(theme.fg("thinkingText", "Thinking...")), 1, 0));
					if (hasVisibleContentAfter) {
						this.contentContainer.addChild(new Spacer(1));
					}
				} else {
					// Thinking traces in thinkingText color, italic
					this.contentContainer.addChild(
						new Markdown(content.thinking.trim(), 1, 0, this.markdownTheme, {
							color: (text: string) => theme.fg("thinkingText", text),
							italic: true,
						}),
					);
					if (hasVisibleContentAfter) {
						this.contentContainer.addChild(new Spacer(1));
					}
				}
			}
		}

		// Check if aborted - show after partial content
		// But only if there are no tool calls (tool execution components will show the error)
		const hasToolCalls = message.content.some((c) => c.type === "toolCall");
		if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				const abortMessage =
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? sanitizeErrorMessage(message.errorMessage)
						: "Operation aborted";
				if (hasVisibleContent) {
					this.contentContainer.addChild(new Spacer(1));
				} else {
					this.contentContainer.addChild(new Spacer(1));
				}
				this.contentContainer.addChild(new Text(theme.fg("error", abortMessage), 1, 0));
			} else if (message.stopReason === "error") {
				const errorMsg = sanitizeErrorMessage(message.errorMessage || "Unknown error");
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", `Error: ${errorMsg}`), 1, 0));
			}
		}
	}
}
