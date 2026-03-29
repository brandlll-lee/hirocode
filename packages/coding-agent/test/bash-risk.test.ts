import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { assessBashCommand } from "../src/core/policy/bash-risk.js";

const createdDirs: string[] = [];

afterEach(() => {
	while (createdDirs.length > 0) {
		rmSync(createdDirs.pop()!, { recursive: true, force: true });
	}
});

describe("assessBashCommand", () => {
	test("classifies safe inspection commands with normalized prefixes", async () => {
		const root = join(tmpdir(), `hirocode-bash-risk-${Date.now()}`);
		createdDirs.push(root);
		mkdirSync(root, { recursive: true });

		const assessment = await assessBashCommand("git status --short", root);

		expect(assessment.level).toBe("low");
		expect(assessment.normalizedPattern).toBe("git status *");
		expect(assessment.tags).toContain("read-only-command");
		expect(assessment.hardDeny).toBe(false);
	});

	test("marks reversible workspace commands for medium autonomy", async () => {
		const root = join(tmpdir(), `hirocode-bash-risk-${Date.now()}-reversible`);
		createdDirs.push(root);
		mkdirSync(root, { recursive: true });

		const assessment = await assessBashCommand("npm install lodash", root);

		expect(assessment.level).toBe("medium");
		expect(assessment.tags).toContain("reversible-command");
		expect(assessment.tags).not.toContain("explicit-approval-required");
	});

	test("forces explicit approval for command substitution", async () => {
		const root = join(tmpdir(), `hirocode-bash-risk-${Date.now()}-subshell`);
		createdDirs.push(root);
		mkdirSync(root, { recursive: true });

		const assessment = await assessBashCommand("echo $(git status --short)", root);

		expect(assessment.tags).toContain("explicit-approval-required");
		expect(assessment.tags).toContain("complex-shell");
	});

	test("hard-denies destructive commands", async () => {
		const root = join(tmpdir(), `hirocode-bash-risk-${Date.now()}-deny`);
		createdDirs.push(root);
		mkdirSync(root, { recursive: true });

		const assessment = await assessBashCommand("rm -rf node_modules", root);

		expect(assessment.level).toBe("critical");
		expect(assessment.hardDeny).toBe(true);
		expect(assessment.tags).toContain("destructive");
	});

	test("detects directories outside the workspace", async () => {
		const root = join(tmpdir(), `hirocode-bash-risk-${Date.now()}-external`);
		const external = join(root, "..", "outside.txt");
		createdDirs.push(root);
		mkdirSync(root, { recursive: true });

		const assessment = await assessBashCommand(`cat ${external}`, root);

		expect(assessment.externalDirectories.length).toBeGreaterThan(0);
		expect(assessment.tags).toContain("external-directory");
		expect(assessment.level).toBe("high");
	});
});
