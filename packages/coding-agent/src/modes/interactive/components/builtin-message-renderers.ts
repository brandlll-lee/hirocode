import type { TextContent } from "@hirocode/ai";
import { type Component, Container, Markdown, Spacer, Text } from "@hirocode/tui";
import type { MessageRenderer } from "../../../core/extensions/types.js";
import type { CustomMessage } from "../../../core/messages.js";
import { getMarkdownTheme, theme } from "../theme/theme.js";

class HorizontalRule implements Component {
	constructor(private color: (text: string) => string) {}

	invalidate(): void {}

	render(width: number): string[] {
		return [this.color("\u2500".repeat(Math.max(1, width)))];
	}
}

function getMessageText(message: CustomMessage<unknown>): string {
	if (typeof message.content === "string") {
		return message.content;
	}

	return message.content
		.filter((entry): entry is TextContent => entry.type === "text")
		.map((entry) => entry.text)
		.join("\n");
}

class SpecPlanMessageComponent extends Container {
	constructor(title: string, message: CustomMessage<unknown>) {
		super();

		const titleColor = (text: string) => theme.fg("customMessageLabel", text);
		const baseMarkdownTheme = getMarkdownTheme();
		const markdownTheme = {
			...baseMarkdownTheme,
			heading: (text: string) => theme.fg("customMessageLabel", text),
			listBullet: (text: string) => theme.fg("customMessageLabel", text),
			hr: (text: string) => theme.fg("customMessageLabel", text),
			quoteBorder: (text: string) => theme.fg("customMessageLabel", text),
		};
		const content = getMessageText(message);

		this.addChild(new Text(titleColor(theme.bold(title)), 3, 0));
		this.addChild(new HorizontalRule(titleColor));
		this.addChild(new Spacer(1));
		this.addChild(
			new Markdown(content, 3, 0, markdownTheme, {
				color: (text: string) => theme.fg("text", text),
			}),
		);
		this.addChild(new Spacer(1));
		this.addChild(new HorizontalRule(titleColor));
	}
}

const SPEC_PLAN_RENDERER: MessageRenderer = (message) => {
	return new SpecPlanMessageComponent("Specification for approval", message);
};

const SPEC_PLAN_BLOCKED_RENDERER: MessageRenderer = (message) => {
	return new SpecPlanMessageComponent("Specification needs more planning", message);
};

export function getBuiltinMessageRenderer(customType: string): MessageRenderer | undefined {
	if (customType === "spec-plan") {
		return SPEC_PLAN_RENDERER;
	}
	if (customType === "spec-plan-blocked") {
		return SPEC_PLAN_BLOCKED_RENDERER;
	}

	return undefined;
}
