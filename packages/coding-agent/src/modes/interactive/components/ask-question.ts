/**
 * Interactive Q&A component for the ask tool.
 * Shows numbered options with keyboard navigation, optional free-text input.
 * Mirrors opencode's QuestionPrompt using hirocode's TUI primitives.
 */

import { type Component, getKeybindings, Input, truncateToWidth } from "@hirocode/tui";
import type { AskAnswer, AskQuestion } from "../../../core/tools/ask.js";
import { theme } from "../theme/theme.js";
import { rawKeyHint } from "./keybinding-hints.js";

function repeat(char: string, n: number): string {
	return char.repeat(Math.max(0, n));
}

function renderSection(lines: string[], innerWidth: number): string[] {
	return lines.filter((l) => l !== "").map((l) => `│ ${truncateToWidth(l, innerWidth - 1)} `);
}

function renderDivider(innerWidth: number): string[] {
	return [`├${repeat("─", innerWidth)}┤`];
}

export interface AskQuestionComponentOptions {
	questions: AskQuestion[];
	onSubmit: (answers: AskAnswer[]) => void;
	onCancel: () => void;
}

export class AskQuestionComponent implements Component {
	private questionIndex = 0;
	private selectedIndex = 0;
	private answers: AskAnswer[] = [];
	private customInput: Input | null = null;
	private customText = "";
	private editingCustom = false;

	constructor(private readonly options: AskQuestionComponentOptions) {}

	invalidate(): void {}

	private get currentQuestion(): AskQuestion {
		return this.options.questions[this.questionIndex]!;
	}

	private get totalQuestions(): number {
		return this.options.questions.length;
	}

	private allOptions(): Array<{ label: string; description?: string; isCustom: boolean }> {
		const q = this.currentQuestion;
		const opts = q.options.map((o) => ({ ...o, isCustom: false }));
		if (q.custom !== false) {
			opts.push({ label: "Type your own answer...", description: undefined, isCustom: true });
		}
		return opts;
	}

	render(width: number): string[] {
		const innerWidth = Math.max(20, width - 4);
		const q = this.currentQuestion;
		const total = this.totalQuestions;
		const opts = this.allOptions();
		this.selectedIndex = Math.min(this.selectedIndex, opts.length - 1);

		const progress = total > 1 ? `Q${this.questionIndex + 1}/${total}` : "Question";
		const header = `${theme.fg("accent", theme.bold(progress))}  ${theme.fg("text", q.question)}`;

		const optionLines: string[] = [];
		for (let i = 0; i < opts.length; i++) {
			const opt = opts[i]!;
			const isSelected = i === this.selectedIndex;
			const prefix = isSelected ? theme.fg("accent", "→") : " ";
			const num = theme.fg("muted", `${i + 1}.`);
			const label = opt.isCustom
				? isSelected
					? theme.fg("accent", opt.label)
					: theme.fg("muted", opt.label)
				: isSelected
					? theme.fg("accent", opt.label)
					: theme.fg("text", opt.label);

			optionLines.push(`  ${prefix} ${num} ${label}`);

			if (opt.description) {
				optionLines.push(`       ${theme.fg("muted", opt.description)}`);
			}

			if (opt.isCustom && isSelected && this.editingCustom) {
				const inputLines = this.customInput ? this.customInput.render(innerWidth - 5) : [];
				for (const line of inputLines) {
					optionLines.push(`       ${line}`);
				}
				if (!this.customInput || inputLines.length === 0) {
					optionLines.push(`       ${theme.fg("muted", "(type your answer, Enter to confirm)")}`);
				}
			}
		}

		const hints =
			`${rawKeyHint(`1-${opts.length}`, "quick pick")}  ${rawKeyHint("↑↓", "navigate")}  ` +
			`${rawKeyHint("Enter", this.editingCustom ? "confirm" : "select")}  ${rawKeyHint("Esc", "cancel")}`;

		const lines = [
			`┌${repeat("─", innerWidth)}┐`,
			...renderSection([header], innerWidth),
			...renderDivider(innerWidth),
			...renderSection(optionLines, innerWidth),
			...renderDivider(innerWidth),
			...renderSection([hints], innerWidth),
			`└${repeat("─", innerWidth)}┘`,
		];

		return lines;
	}

	handleInput(data: string): void {
		const kb = getKeybindings();

		// When editing custom text input
		if (this.editingCustom && this.customInput) {
			if (kb.matches(data, "tui.select.cancel")) {
				this.editingCustom = false;
				this.customText = "";
				this.customInput = null;
				return;
			}
			if (data === "\r" || data === "\n" || kb.matches(data, "tui.select.confirm")) {
				const text = this.customInput.getValue().trim();
				if (text) {
					this.confirmAnswer(text);
				}
				return;
			}
			this.customInput.handleInput(data);
			return;
		}

		// Number key quick-select
		const digit = Number(data);
		const opts = this.allOptions();
		if (!Number.isNaN(digit) && digit >= 1 && digit <= opts.length) {
			this.selectedIndex = digit - 1;
			this.selectCurrent();
			return;
		}

		if (kb.matches(data, "tui.select.up") || data === "k") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			return;
		}
		if (kb.matches(data, "tui.select.down") || data === "j") {
			this.selectedIndex = Math.min(opts.length - 1, this.selectedIndex + 1);
			return;
		}
		if (data === "\r" || data === "\n" || kb.matches(data, "tui.select.confirm")) {
			this.selectCurrent();
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.options.onCancel();
		}
	}

	private selectCurrent(): void {
		const opts = this.allOptions();
		const opt = opts[this.selectedIndex];
		if (!opt) return;

		if (opt.isCustom) {
			this.editingCustom = true;
			this.customInput = new Input();
			if (this.customText) {
				this.customInput.handleInput(this.customText);
			}
			return;
		}

		this.confirmAnswer(opt.label);
	}

	private confirmAnswer(answer: string): void {
		this.answers[this.questionIndex] = answer;
		this.editingCustom = false;
		this.customText = "";
		this.customInput = null;

		if (this.questionIndex + 1 < this.totalQuestions) {
			this.questionIndex++;
			this.selectedIndex = 0;
		} else {
			this.options.onSubmit([...this.answers] as AskAnswer[]);
		}
	}
}
