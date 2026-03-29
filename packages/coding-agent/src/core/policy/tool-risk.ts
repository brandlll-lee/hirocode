import path from "node:path";
import { assessBashCommand, buildBashApprovalSubject } from "./bash-risk.js";
import type { ApprovalSubject, ToolPermission } from "./types.js";

type ToolArgs = Record<string, unknown>;

export async function buildApprovalSubjects(toolName: string, args: ToolArgs, cwd: string): Promise<ApprovalSubject[]> {
	switch (toolName) {
		case "bash": {
			const command = readString(args.command);
			if (!command) {
				return [];
			}
			const assessment = await assessBashCommand(command, cwd);
			const subjects: ApprovalSubject[] = [];
			for (const directory of assessment.externalDirectories) {
				subjects.push({
					permission: "external_directory",
					pattern: directory,
					normalizedPattern: directory,
					level: "high",
					summary: `Approve access outside workspace: ${directory}`,
					justification: "Command touches directories outside the active workspace.",
					tags: ["external-directory", "bash"],
					displayTarget: directory,
				});
			}
			subjects.push(buildBashApprovalSubject(assessment));
			return subjects;
		}

		case "read":
		case "edit":
		case "write": {
			const filePath = readString(args.path);
			if (!filePath) {
				return [];
			}
			return buildFileSubjects(toolName, filePath, cwd);
		}

		case "task": {
			return [];
		}

		case "webfetch": {
			const url = readString(args.url);
			if (!url) {
				return [];
			}
			return [
				{
					permission: "webfetch",
					pattern: url,
					normalizedPattern: url,
					level: "low",
					summary: `Fetch URL ${url}`,
					justification: "Fetching a user-supplied URL is read-only network access.",
					tags: ["network", "read-only"],
					displayTarget: url,
				},
			];
		}

		case "websearch": {
			const query = readString(args.query) ?? "web search";
			return [
				{
					permission: "websearch",
					pattern: query,
					normalizedPattern: query,
					level: "low",
					summary: `Search the web for ${query}`,
					justification: "Web search is read-only discovery.",
					tags: ["network", "read-only"],
					displayTarget: query,
				},
			];
		}

		case "grep":
		case "find":
		case "ls": {
			return [
				{
					permission: toolName as ToolPermission,
					pattern: cwd,
					normalizedPattern: cwd,
					level: "low",
					summary: `Inspect workspace with ${toolName}`,
					justification: `${toolName} is read-only workspace inspection.`,
					tags: ["read-only"],
					displayTarget: cwd,
				},
			];
		}

		default:
			return [];
	}
}

function buildFileSubjects(permission: "read" | "edit" | "write", filePath: string, cwd: string): ApprovalSubject[] {
	const absolutePath = path.resolve(cwd, filePath);
	const pattern = toWorkspacePattern(absolutePath, cwd);
	const subjects: ApprovalSubject[] = [];
	if (!isWithinDirectory(cwd, absolutePath)) {
		subjects.push({
			permission: "external_directory",
			pattern: `${path.dirname(absolutePath).replace(/\\/g, "/")}/*`,
			normalizedPattern: `${path.dirname(absolutePath).replace(/\\/g, "/")}/*`,
			level: "high",
			summary: `Approve access outside workspace: ${absolutePath}`,
			justification: `${permission} targets a path outside the active workspace.`,
			tags: [permission, "external-directory"],
			displayTarget: absolutePath,
		});
	}

	subjects.push({
		permission,
		pattern,
		normalizedPattern: pattern,
		level: permission === "read" ? "low" : "medium",
		summary: `${permission} ${pattern}`,
		justification: permission === "read" ? "Reading files is low risk." : "Editing files mutates the workspace.",
		tags: permission === "read" ? ["read-only"] : ["file-mutation"],
		displayTarget: pattern,
	});
	return subjects;
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function toWorkspacePattern(target: string, cwd: string): string {
	if (isWithinDirectory(cwd, target)) {
		const relative = path.relative(cwd, target).replace(/\\/g, "/");
		return relative.length > 0 ? relative : ".";
	}
	return target.replace(/\\/g, "/");
}

function isWithinDirectory(root: string, target: string): boolean {
	const normalizedRoot = path.resolve(root);
	const normalizedTarget = path.resolve(target);
	if (normalizedRoot === normalizedTarget) {
		return true;
	}
	const rootWithSep = normalizedRoot.endsWith(path.sep) ? normalizedRoot : `${normalizedRoot}${path.sep}`;
	return normalizedTarget.startsWith(rootWithSep);
}
