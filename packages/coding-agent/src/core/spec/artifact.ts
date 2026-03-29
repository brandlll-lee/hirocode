import * as fs from "node:fs";
import * as path from "node:path";
import { withFileMutationQueue } from "../tools/file-mutation-queue.js";
import type { SpecPlanSections } from "./types.js";

export async function saveSpecArtifact(cwd: string, plan: SpecPlanSections): Promise<string> {
	const docsDir = resolveSpecDocsDir(cwd);
	fs.mkdirSync(docsDir, { recursive: true });
	const datePrefix = new Date().toISOString().slice(0, 10);
	const baseName = `${datePrefix}-${slugify(plan.title || "specification-plan")}`;
	let filePath = path.join(docsDir, `${baseName}.md`);
	let counter = 2;
	while (fs.existsSync(filePath)) {
		filePath = path.join(docsDir, `${baseName}-${counter}.md`);
		counter += 1;
	}

	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, `${plan.markdown}\n`, "utf-8");
	});

	return filePath;
}

export function resolveSpecDocsDir(cwd: string): string {
	const root = findNearestProjectRoot(cwd) ?? cwd;
	return path.join(root, ".hirocode", "docs");
}

function findNearestProjectRoot(cwd: string): string | undefined {
	let current = path.resolve(cwd);
	while (true) {
		const marker = path.join(current, ".hirocode");
		if (fs.existsSync(marker) && fs.statSync(marker).isDirectory()) {
			return current;
		}
		const parent = path.dirname(current);
		if (parent === current) {
			return undefined;
		}
		current = parent;
	}
}

function slugify(value: string): string {
	const slug = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
	return slug.length > 0 ? slug : "specification-plan";
}
