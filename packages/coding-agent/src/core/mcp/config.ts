/**
 * MCP configuration: schema, loading, and two-layer merging.
 *
 * User-level:   ~/.hirocode/agent/mcp.json
 * Project-level: .hirocode/mcp.json
 *
 * User config takes priority over project config (same server name → user wins).
 */

import { existsSync, type FSWatcher, mkdirSync, readFileSync, watch, writeFileSync } from "fs";
import { dirname, join } from "path";
import { CONFIG_DIR_NAME, getAgentDir } from "../../config.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export interface McpStdioConfig {
	type: "stdio";
	command: string;
	args?: string[];
	env?: Record<string, string>;
	disabled?: boolean;
	disabledTools?: string[];
	timeout?: number;
}

export interface McpHttpConfig {
	type: "http";
	url: string;
	headers?: Record<string, string>;
	disabled?: boolean;
	disabledTools?: string[];
	timeout?: number;
}

export type McpServerConfig = McpStdioConfig | McpHttpConfig;

export interface McpConfigFile {
	mcpServers: Record<string, McpServerConfig>;
}

// ---------------------------------------------------------------------------
// Loading helpers
// ---------------------------------------------------------------------------

function tryLoadFile(path: string): McpConfigFile | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const raw = readFileSync(path, "utf-8");
		const parsed = JSON.parse(raw) as McpConfigFile;
		if (parsed && typeof parsed === "object" && parsed.mcpServers) {
			return parsed;
		}
		return { mcpServers: {} };
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getUserMcpConfigPath(agentDir: string = getAgentDir()): string {
	return join(agentDir, "mcp.json");
}

export function getProjectMcpConfigPath(cwd: string = process.cwd()): string {
	return join(cwd, CONFIG_DIR_NAME, "mcp.json");
}

/**
 * Load and merge MCP configuration (user overrides project).
 */
export function loadMcpConfig(
	cwd: string = process.cwd(),
	agentDir: string = getAgentDir(),
): { merged: McpConfigFile; user: McpConfigFile; project: McpConfigFile } {
	const userConfig = tryLoadFile(getUserMcpConfigPath(agentDir)) ?? { mcpServers: {} };
	const projectConfig = tryLoadFile(getProjectMcpConfigPath(cwd)) ?? { mcpServers: {} };

	// Merge: user config wins for same server name
	const merged: McpConfigFile = {
		mcpServers: {
			...projectConfig.mcpServers,
			...userConfig.mcpServers,
		},
	};

	return { merged, user: userConfig, project: projectConfig };
}

/**
 * Write a server entry to the user-level mcp.json.
 */
export function writeUserMcpServer(name: string, config: McpServerConfig, agentDir: string = getAgentDir()): void {
	const path = getUserMcpConfigPath(agentDir);
	const existing = tryLoadFile(path) ?? { mcpServers: {} };
	existing.mcpServers[name] = config;
	const dir = dirname(path);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	writeFileSync(path, JSON.stringify(existing, null, 2), "utf-8");
}

/**
 * Remove a server entry from user-level mcp.json.
 * Returns true if removed, false if not found.
 */
export function removeUserMcpServer(name: string, agentDir: string = getAgentDir()): boolean {
	const path = getUserMcpConfigPath(agentDir);
	const existing = tryLoadFile(path);
	if (!existing || !(name in existing.mcpServers)) return false;
	delete existing.mcpServers[name];
	writeFileSync(path, JSON.stringify(existing, null, 2), "utf-8");
	return true;
}

/**
 * Update the disabled state of a server in user-level mcp.json.
 */
export function setUserMcpServerDisabled(name: string, disabled: boolean, agentDir: string = getAgentDir()): void {
	const path = getUserMcpConfigPath(agentDir);
	const existing = tryLoadFile(path) ?? { mcpServers: {} };
	if (existing.mcpServers[name]) {
		existing.mcpServers[name].disabled = disabled;
	}
	const dir = dirname(path);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	writeFileSync(path, JSON.stringify(existing, null, 2), "utf-8");
}

/**
 * Watch both user-level and project-level mcp.json for changes.
 * Calls `onChange` (debounced 300ms) when either file changes.
 */
export function watchMcpConfig(
	cwd: string = process.cwd(),
	agentDir: string = getAgentDir(),
	onChange: () => void,
): { close: () => void } {
	const watchers: FSWatcher[] = [];
	let debounceTimer: ReturnType<typeof setTimeout> | undefined;

	const scheduleReload = () => {
		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(onChange, 300);
	};

	const tryWatch = (filePath: string) => {
		if (!existsSync(filePath)) return;
		try {
			const w = watch(filePath, () => scheduleReload());
			watchers.push(w);
		} catch {
			// Ignore watch errors
		}
	};

	tryWatch(getUserMcpConfigPath(agentDir));
	tryWatch(getProjectMcpConfigPath(cwd));

	return {
		close: () => {
			if (debounceTimer) clearTimeout(debounceTimer);
			for (const w of watchers) w.close();
		},
	};
}
