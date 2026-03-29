import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { BashArity } from "./bash-arity.js";
import { type ParsedBashInvocation, parseBashCommand } from "./bash-parser.js";
import type { ApprovalSubject, RiskLevel } from "./types.js";

const SAFE_COMMANDS = [
	"ls",
	"cat",
	"head",
	"tail",
	"pwd",
	"whoami",
	"date",
	"wc",
	"which",
	"env",
	"printenv",
	"file",
	"stat",
	"du",
	"df",
	"free",
	"uname",
	"hostname",
	"git status",
	"git diff",
	"git log",
	"git show",
	"git branch",
	"git remote",
	"git stash list",
];

const REVERSIBLE_COMMANDS = [
	"cargo build",
	"cargo check",
	"cargo fmt",
	"cargo test",
	"cp",
	"git add",
	"git checkout",
	"git commit",
	"git restore",
	"git switch",
	"mkdir",
	"mv",
	"npm install",
	"npm run",
	"pip install",
	"pnpm install",
	"pnpm run",
	"python -m pip install",
	"touch",
	"yarn add",
	"yarn install",
	"yarn run",
];

const NETWORK_COMMANDS = new Set(["curl", "wget", "gh", "npm", "pnpm", "yarn", "bun", "pip", "python"]);
const MUTATING_COMMANDS = new Set([
	"chmod",
	"chown",
	"cp",
	"git",
	"mkdir",
	"mv",
	"npm",
	"pnpm",
	"python",
	"rm",
	"rmdir",
	"sed",
	"tee",
	"touch",
	"yarn",
]);

const DANGEROUS_PATTERNS = [
	/\brm\s+(-\w*r|-\w*f|--recursive)\b/i,
	/\brmdir\b/i,
	/\bchmod\s+777\b/i,
	/\bchmod\s+(-\w*R)\b/i,
	/\bchown\s+(-\w*R)\b/i,
	/\b(curl|wget)\b.*\|\s*(sh|bash|zsh|pwsh|powershell)\b/i,
	/\bdd\s+if=/i,
	/\bmkfs\b/i,
	/\bfdisk\b/i,
	/\bgit\s+push\s+--force\b/i,
	/\bgit\s+reset\s+--hard\b/i,
	/\bgit\s+clean\s+(-\w*f)\b/i,
	/\bkill\s+-9\b/i,
	/\bkillall\b/i,
	/\bpkill\b/i,
	/>\s*\/etc\/passwd/i,
	/>\s*\/etc\/shadow/i,
	/>\s*~?\/?\.ssh\//i,
];

const PATH_COMMANDS = new Set(["cd", "rm", "cp", "mv", "mkdir", "touch", "chmod", "chown", "cat", "head", "tail"]);

export interface BashRiskAssessment {
	command: string;
	normalizedPattern: string;
	level: RiskLevel;
	justification: string;
	tags: string[];
	hardDeny: boolean;
	externalDirectories: string[];
	displayTarget: string;
}

export async function assessBashCommand(command: string, cwd: string): Promise<BashRiskAssessment> {
	const trimmed = command.trim();
	const parsed = await parseBashCommand(trimmed);
	const invocations = parsed?.invocations ?? [{ text: trimmed, tokens: tokenizeFallback(trimmed) }];
	const normalizedPattern = normalizePattern(invocations[0]?.tokens ?? []);
	const externalDirectories = collectExternalDirectories(invocations, cwd, parsed?.redirects ?? []);
	const tags = new Set<string>();

	if (externalDirectories.length > 0) {
		tags.add("external-directory");
	}

	for (const pattern of DANGEROUS_PATTERNS) {
		if (pattern.test(trimmed)) {
			tags.add("destructive");
			return {
				command: trimmed,
				normalizedPattern,
				level: "critical",
				justification: "Command matches a destructive shell pattern that should never auto-run.",
				tags: Array.from(tags),
				hardDeny: true,
				externalDirectories,
				displayTarget: normalizedPattern,
			};
		}
	}

	const commandHeads = invocations
		.map((invocation) => invocation.tokens[0])
		.filter((value): value is string => Boolean(value));
	const hasBackground = parsed?.backgrounded ?? false;
	const hasSubcommands = (parsed?.subcommands.length ?? 0) > 0;
	const hasBackticks = /`[^`]+`/.test(trimmed);
	const hasRedirects = (parsed?.redirects.length ?? 0) > 0;
	const hasPipes = parsed?.pipes ?? false;
	const hasSafePrefix = SAFE_COMMANDS.some((safe) => trimmed === safe || trimmed.startsWith(`${safe} `));
	const hasReversiblePrefix = REVERSIBLE_COMMANDS.some(
		(prefix) => normalizedPattern === `${prefix} *` || normalizedPattern.startsWith(`${prefix} `),
	);
	const hitsNetwork = commandHeads.some((head) => NETWORK_COMMANDS.has(head));
	const mutatesFiles = hasRedirects || commandHeads.some((head) => MUTATING_COMMANDS.has(head));
	const complexShell = hasBackground || hasSubcommands || hasPipes || (parsed?.chained.length ?? 0) > 0;
	const explicitApprovalRequired = hasSubcommands || hasBackticks || complexShell;

	if (hasBackticks) {
		tags.add("shell-substitution");
	}
	if (explicitApprovalRequired) {
		tags.add("explicit-approval-required");
	}

	if (
		hasSafePrefix &&
		!hasBackground &&
		!hasSubcommands &&
		!hasRedirects &&
		!explicitApprovalRequired &&
		externalDirectories.length === 0
	) {
		tags.add("read-only-command");
		return {
			command: trimmed,
			normalizedPattern,
			level: "low",
			justification: "Command looks like a read-only inspection command and is safe for low-autonomy allowlists.",
			tags: Array.from(tags),
			hardDeny: false,
			externalDirectories,
			displayTarget: normalizedPattern,
		};
	}

	if (hasReversiblePrefix && !explicitApprovalRequired && externalDirectories.length === 0) {
		tags.add("reversible-command");
		return {
			command: trimmed,
			normalizedPattern,
			level: "medium",
			justification:
				"Command matches the reversible workspace-change allowlist and is suitable for medium autonomy.",
			tags: Array.from(tags),
			hardDeny: false,
			externalDirectories,
			displayTarget: normalizedPattern,
		};
	}

	if (hitsNetwork) {
		tags.add("network");
	}
	if (mutatesFiles) {
		tags.add("mutates-files");
	}
	if (complexShell) {
		tags.add("complex-shell");
	}

	const level: RiskLevel =
		hitsNetwork || mutatesFiles || complexShell || externalDirectories.length > 0 ? "high" : "medium";
	const reasons: string[] = [];
	if (hitsNetwork) {
		reasons.push("touches network-facing tooling");
	}
	if (mutatesFiles) {
		reasons.push("can mutate files or shell state");
	}
	if (complexShell) {
		reasons.push("uses advanced shell features");
	}
	if (externalDirectories.length > 0) {
		reasons.push("touches directories outside the workspace");
	}

	return {
		command: trimmed,
		normalizedPattern,
		level,
		justification:
			reasons.length > 0
				? `Command ${reasons.join(", ")}.`
				: "Command is not on the explicit safe list, so it should be reviewed before execution.",
		tags: Array.from(tags),
		hardDeny: false,
		externalDirectories,
		displayTarget: normalizedPattern,
	};
}

export function buildBashApprovalSubject(assessment: BashRiskAssessment): ApprovalSubject {
	return {
		permission: "bash",
		pattern: assessment.normalizedPattern,
		normalizedPattern: assessment.normalizedPattern,
		level: assessment.level,
		summary: `Approve bash command: ${assessment.normalizedPattern}`,
		justification: assessment.justification,
		tags: assessment.tags,
		hardDeny: assessment.hardDeny,
		metadata: {
			command: assessment.command,
			externalDirectories: assessment.externalDirectories,
		},
		displayTarget: assessment.displayTarget,
	};
}

function normalizePattern(tokens: string[]): string {
	const prefix = BashArity.prefix(tokens).join(" ").trim();
	if (!prefix) {
		return "bash *";
	}
	return `${prefix} *`;
}

function tokenizeFallback(command: string): string[] {
	return command
		.split(/\s+/)
		.map((token) => token.trim())
		.filter((token) => token.length > 0);
}

function collectExternalDirectories(invocations: ParsedBashInvocation[], cwd: string, redirects: string[]): string[] {
	const directories = new Set<string>();
	for (const invocation of invocations) {
		const head = invocation.tokens[0];
		if (!head || !PATH_COMMANDS.has(head)) {
			continue;
		}
		for (const token of invocation.tokens.slice(1)) {
			if (token.startsWith("-")) {
				continue;
			}
			const resolved = resolvePath(cwd, token);
			if (!resolved || isWithinDirectory(cwd, resolved)) {
				continue;
			}
			directories.add(toDirectoryGlob(resolved));
		}
	}

	for (const redirect of redirects) {
		const resolved = resolvePath(cwd, redirect);
		if (!resolved || isWithinDirectory(cwd, resolved)) {
			continue;
		}
		directories.add(toDirectoryGlob(resolved));
	}

	return Array.from(directories).sort((left, right) => left.localeCompare(right));
}

function resolvePath(cwd: string, value: string): string | undefined {
	const cleaned = value.replace(/^['"]|['"]$/g, "");
	if (!cleaned || cleaned.includes("*") || cleaned.includes("$") || cleaned.includes("`")) {
		return undefined;
	}
	const resolved = path.resolve(cwd, cleaned);
	if (existsSync(resolved)) {
		return realpathSync(resolved);
	}
	return resolved;
}

function isWithinDirectory(root: string, target: string): boolean {
	const normalizedRoot = path.resolve(root);
	const normalizedTarget = path.resolve(target);
	if (normalizedTarget === normalizedRoot) {
		return true;
	}
	const rootWithSep = normalizedRoot.endsWith(path.sep) ? normalizedRoot : `${normalizedRoot}${path.sep}`;
	return normalizedTarget.startsWith(rootWithSep);
}

function toDirectoryGlob(target: string): string {
	const dir = existsSync(target) && path.extname(target) === "" ? target : path.dirname(target);
	return `${dir.replace(/\\/g, "/").replace(/\/+$/g, "")}/*`;
}
