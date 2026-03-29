/**
 * MCP OAuth token storage.
 *
 * Stores OAuth tokens in ~/.hirocode/agent/mcp-auth.json.
 * Adapted from OpenCode's McpAuth namespace.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { getAgentDir } from "../../config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface McpAuthTokens {
	accessToken: string;
	refreshToken?: string;
	expiresAt?: number;
	scope?: string;
}

export interface McpAuthClientInfo {
	clientId: string;
	clientSecret?: string;
	clientIdIssuedAt?: number;
	clientSecretExpiresAt?: number;
}

export interface McpAuthEntry {
	tokens?: McpAuthTokens;
	clientInfo?: McpAuthClientInfo;
	codeVerifier?: string;
	oauthState?: string;
	serverUrl?: string;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

function getAuthFilePath(agentDir: string = getAgentDir()): string {
	return join(agentDir, "mcp-auth.json");
}

function readAll(agentDir?: string): Record<string, McpAuthEntry> {
	const path = getAuthFilePath(agentDir);
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return {};
	}
}

function writeAll(data: Record<string, McpAuthEntry>, agentDir?: string): void {
	const path = getAuthFilePath(agentDir);
	const dir = dirname(path);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	writeFileSync(path, JSON.stringify(data, null, 2), { encoding: "utf-8", mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getMcpAuth(name: string, agentDir?: string): McpAuthEntry | undefined {
	return readAll(agentDir)[name];
}

export function getMcpAuthForUrl(name: string, serverUrl: string, agentDir?: string): McpAuthEntry | undefined {
	const entry = getMcpAuth(name, agentDir);
	if (!entry) return undefined;
	if (!entry.serverUrl) return undefined;
	if (entry.serverUrl !== serverUrl) return undefined;
	return entry;
}

export function setMcpAuth(name: string, entry: McpAuthEntry, serverUrl?: string, agentDir?: string): void {
	const data = readAll(agentDir);
	if (serverUrl) entry.serverUrl = serverUrl;
	data[name] = entry;
	writeAll(data, agentDir);
}

export function removeMcpAuth(name: string, agentDir?: string): void {
	const data = readAll(agentDir);
	delete data[name];
	writeAll(data, agentDir);
}

export function updateMcpAuthTokens(name: string, tokens: McpAuthTokens, serverUrl?: string, agentDir?: string): void {
	const data = readAll(agentDir);
	const entry = data[name] ?? {};
	entry.tokens = tokens;
	if (serverUrl) entry.serverUrl = serverUrl;
	data[name] = entry;
	writeAll(data, agentDir);
}

export function updateMcpAuthClientInfo(
	name: string,
	clientInfo: McpAuthClientInfo,
	serverUrl?: string,
	agentDir?: string,
): void {
	const data = readAll(agentDir);
	const entry = data[name] ?? {};
	entry.clientInfo = clientInfo;
	if (serverUrl) entry.serverUrl = serverUrl;
	data[name] = entry;
	writeAll(data, agentDir);
}

export function updateMcpCodeVerifier(name: string, codeVerifier: string, agentDir?: string): void {
	const data = readAll(agentDir);
	const entry = data[name] ?? {};
	entry.codeVerifier = codeVerifier;
	data[name] = entry;
	writeAll(data, agentDir);
}

export function clearMcpCodeVerifier(name: string, agentDir?: string): void {
	const data = readAll(agentDir);
	const entry = data[name];
	if (entry) {
		delete entry.codeVerifier;
		data[name] = entry;
		writeAll(data, agentDir);
	}
}

export function updateMcpOAuthState(name: string, state: string, agentDir?: string): void {
	const data = readAll(agentDir);
	const entry = data[name] ?? {};
	entry.oauthState = state;
	data[name] = entry;
	writeAll(data, agentDir);
}

export function getMcpOAuthState(name: string, agentDir?: string): string | undefined {
	return getMcpAuth(name, agentDir)?.oauthState;
}

export function clearMcpOAuthState(name: string, agentDir?: string): void {
	const data = readAll(agentDir);
	const entry = data[name];
	if (entry) {
		delete entry.oauthState;
		data[name] = entry;
		writeAll(data, agentDir);
	}
}

export function isMcpTokenExpired(name: string, agentDir?: string): boolean | null {
	const entry = getMcpAuth(name, agentDir);
	if (!entry?.tokens) return null;
	if (!entry.tokens.expiresAt) return false;
	return entry.tokens.expiresAt < Date.now() / 1000;
}
