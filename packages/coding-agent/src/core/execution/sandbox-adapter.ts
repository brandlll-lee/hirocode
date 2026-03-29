import { existsSync } from "node:fs";
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { SettingsManager } from "../settings-manager.js";
import type { BashOperations } from "../tools/bash.js";
import { createLocalBashOperations } from "../tools/bash.js";
import type { ExecutionService } from "./types.js";

type SandboxConfig = SandboxRuntimeConfig & {
	ignoreViolations?: Record<string, string[]>;
	enableWeakerNestedSandbox?: boolean;
};

export class SandboxExecutionService implements ExecutionService {
	private readonly local = createLocalBashOperations();
	private readonly operations: BashOperations;
	private initialized = false;
	private lastConfigKey = "";

	constructor(private readonly settingsManager: SettingsManager) {
		this.operations = {
			exec: async (command, cwd, options) => {
				if (!existsSync(cwd)) {
					throw new Error(`Working directory does not exist: ${cwd}`);
				}

				await this.ensureInitialized();
				const wrappedCommand = await SandboxManager.wrapWithSandbox(command);
				return this.local.exec(wrappedCommand, cwd, options);
			},
		};
	}

	getBashOperations(): BashOperations {
		return this.operations;
	}

	async dispose(): Promise<void> {
		if (!this.initialized) {
			return;
		}
		await SandboxManager.reset();
		this.initialized = false;
		this.lastConfigKey = "";
	}

	private async ensureInitialized(): Promise<void> {
		const config = this.getConfig();
		const nextKey = JSON.stringify(config);
		if (this.initialized && nextKey === this.lastConfigKey) {
			return;
		}
		if (this.initialized) {
			await SandboxManager.reset();
			this.initialized = false;
		}
		await SandboxManager.initialize(config);
		this.initialized = true;
		this.lastConfigKey = nextKey;
	}

	private getConfig(): SandboxConfig {
		const policy = this.settingsManager.getSandboxPolicy();
		return {
			network: {
				allowedDomains: policy.network?.allowedDomains ?? [],
				deniedDomains: policy.network?.deniedDomains ?? [],
			},
			filesystem: {
				denyRead: policy.filesystem?.denyRead ?? [],
				allowWrite: policy.filesystem?.allowWrite ?? ["."],
				denyWrite: policy.filesystem?.denyWrite ?? [],
			},
			ignoreViolations: policy.ignoreViolations,
			enableWeakerNestedSandbox: policy.enableWeakerNestedSandbox,
		};
	}
}
