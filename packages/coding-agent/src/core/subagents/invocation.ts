import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ThinkingLevel } from "@hirocode/agent-core";
import { withFileMutationQueue } from "../tools/file-mutation-queue.js";
import type { ParentModelReference } from "./types.js";

const PRIMARY_CLI_NAME = "hirocode";
const NPX_BINARY = process.platform === "win32" ? "npx.cmd" : "npx";
const TSX_CLI_RELATIVE_PATH = path.join("node_modules", "tsx", "dist", "cli.mjs");

export function formatModelReference(provider: string | undefined, modelId: string | undefined): string | undefined {
	if (!modelId) {
		return undefined;
	}

	if (!provider) {
		return modelId;
	}

	return `${provider}/${modelId}`;
}

export function resolveEffectiveSubagentModel(
	agentModel: string | undefined,
	agentReasoningEffort: ThinkingLevel | undefined,
	parentModel: ParentModelReference | undefined,
	storedModel?: { provider?: string; model?: string },
): { provider?: string; modelId?: string; modelArg?: string; thinkingArg?: ThinkingLevel } {
	if (storedModel?.model) {
		return {
			provider: storedModel.provider,
			modelId: storedModel.model,
			modelArg: formatModelReference(storedModel.provider, storedModel.model) ?? storedModel.model,
			thinkingArg: agentReasoningEffort,
		};
	}

	if (agentModel) {
		const slashIndex = agentModel.indexOf("/");
		if (slashIndex !== -1) {
			const provider = agentModel.slice(0, slashIndex).trim();
			const modelId = agentModel.slice(slashIndex + 1).trim();
			return {
				provider: provider || undefined,
				modelId: modelId || agentModel,
				modelArg: agentModel,
				thinkingArg: agentReasoningEffort,
			};
		}

		return { modelId: agentModel, modelArg: agentModel, thinkingArg: agentReasoningEffort };
	}

	if (parentModel) {
		return {
			provider: parentModel.provider,
			modelId: parentModel.id,
			modelArg: `${parentModel.provider}/${parentModel.id}`,
			thinkingArg: agentReasoningEffort,
		};
	}

	return { thinkingArg: agentReasoningEffort };
}

function isTypeScriptEntrypoint(filePath: string): boolean {
	const ext = path.extname(filePath).toLowerCase();
	return ext === ".ts" || ext === ".mts" || ext === ".cts";
}

function findLocalTsxCliEntrypoint(startDir: string): string | undefined {
	let currentDir = startDir;
	while (true) {
		const candidate = path.join(currentDir, TSX_CLI_RELATIVE_PATH);
		if (fs.existsSync(candidate)) {
			return candidate;
		}

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) {
			return undefined;
		}
		currentDir = parentDir;
	}
}

export function resolveAgentInvocation(
	args: string[],
	options?: { currentScript?: string; execPath?: string },
): { command: string; args: string[] } {
	const currentScript = options?.currentScript ?? process.argv[1];
	const execPath = options?.execPath ?? process.execPath;
	const execName = path.basename(execPath).toLowerCase();
	const isNodeRuntime = /^(node)(\.exe)?$/.test(execName);
	const isBunRuntime = /^(bun)(\.exe)?$/.test(execName);

	if (currentScript && fs.existsSync(currentScript)) {
		if (isNodeRuntime && isTypeScriptEntrypoint(currentScript)) {
			const localTsxCli = findLocalTsxCliEntrypoint(path.dirname(currentScript));
			if (localTsxCli) {
				return { command: execPath, args: [localTsxCli, currentScript, ...args] };
			}
			return { command: NPX_BINARY, args: ["tsx", currentScript, ...args] };
		}

		return { command: execPath, args: [currentScript, ...args] };
	}

	if (!isNodeRuntime && !isBunRuntime) {
		return { command: execPath, args };
	}

	return { command: PRIMARY_CLI_NAME, args };
}

export async function writePromptToTempFile(
	agentName: string,
	prompt: string,
): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "hirocode-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}
