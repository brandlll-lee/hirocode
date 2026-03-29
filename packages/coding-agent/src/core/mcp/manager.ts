/**
 * MCP server lifecycle management.
 *
 * Manages connections to MCP servers, handles transport creation,
 * and exposes tools from connected servers.
 *
 * Inspired by OpenCode's MCP namespace (mcp/index.ts).
 */

import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool as McpToolDef } from "@modelcontextprotocol/sdk/types.js";
import chalk from "chalk";
import { APP_NAME, getAgentDir, VERSION } from "../../config.js";
import { removeMcpAuth } from "./auth.js";
import { loadMcpConfig, type McpHttpConfig, type McpServerConfig, type McpStdioConfig } from "./config.js";
import { cancelPendingOAuth, ensureOAuthCallbackServer, waitForOAuthCallback } from "./oauth-callback.js";
import { McpOAuthProvider } from "./oauth-provider.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type McpServerStatus =
	| { status: "connected" }
	| { status: "disabled" }
	| { status: "failed"; error: string }
	| { status: "connecting" }
	| { status: "needs_auth" };

export interface McpServerInfo {
	name: string;
	config: McpServerConfig;
	status: McpServerStatus;
	tools: McpToolDef[];
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT = 30_000;

type HttpTransport = StreamableHTTPClientTransport | SSEClientTransport;

interface McpClientEntry {
	client: Client;
	tools: McpToolDef[];
	config: McpServerConfig;
}

interface PendingOAuth {
	transport: HttpTransport;
	authorizationUrl?: string;
}

// ---------------------------------------------------------------------------
// Manager class
// ---------------------------------------------------------------------------

export class McpManager {
	private clients = new Map<string, McpClientEntry>();
	private statuses = new Map<string, McpServerStatus>();
	private pendingOAuth = new Map<string, PendingOAuth>();
	private cwd: string;
	private agentDir: string;
	private _initialized = false;

	constructor(cwd: string = process.cwd(), agentDir: string = getAgentDir()) {
		this.cwd = cwd;
		this.agentDir = agentDir;
	}

	get initialized(): boolean {
		return this._initialized;
	}

	/**
	 * Initialize all configured MCP servers.
	 * Safe to call multiple times; only connects unconnected servers.
	 */
	async initialize(silent = false): Promise<void> {
		const { merged } = loadMcpConfig(this.cwd, this.agentDir);
		const servers = merged.mcpServers;

		if (Object.keys(servers).length === 0) {
			this._initialized = true;
			return;
		}

		const entries = Object.entries(servers);
		await Promise.all(
			entries.map(async ([name, config]) => {
				if (this.clients.has(name)) return;

				if (config.disabled) {
					this.statuses.set(name, { status: "disabled" });
					return;
				}

				this.statuses.set(name, { status: "connecting" });

				try {
					const entry = await this.createClient(name, config, silent);
					if (entry) {
						this.clients.set(name, entry);
						this.statuses.set(name, { status: "connected" });
					} else if (this.statuses.get(name)?.status !== "needs_auth") {
						this.statuses.set(name, { status: "failed", error: "Unknown error" });
					}
				} catch (error) {
					const msg = error instanceof Error ? error.message : String(error);
					this.statuses.set(name, { status: "failed", error: msg });
					if (!silent) {
						console.error(chalk.yellow(`MCP server "${name}" failed: ${msg}`));
					}
				}
			}),
		);

		this._initialized = true;
	}

	/**
	 * Connect a single server by name (used by CLI add flow).
	 */
	async connectServer(name: string, config: McpServerConfig, silent = false): Promise<McpServerStatus> {
		if (config.disabled) {
			this.statuses.set(name, { status: "disabled" });
			return { status: "disabled" };
		}

		this.statuses.set(name, { status: "connecting" });

		try {
			const existing = this.clients.get(name);
			if (existing) {
				await existing.client.close().catch(() => {});
				this.clients.delete(name);
			}

			const entry = await this.createClient(name, config, silent);
			if (entry) {
				this.clients.set(name, entry);
				const status: McpServerStatus = { status: "connected" };
				this.statuses.set(name, status);
				return status;
			}
			const currentStatus = this.statuses.get(name);
			if (currentStatus?.status === "needs_auth") {
				return currentStatus;
			}
			const failed: McpServerStatus = { status: "failed", error: "Unknown error" };
			this.statuses.set(name, failed);
			return failed;
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			const failed: McpServerStatus = { status: "failed", error: msg };
			this.statuses.set(name, failed);
			return failed;
		}
	}

	/**
	 * Disconnect a server.
	 */
	async disconnectServer(name: string): Promise<void> {
		const entry = this.clients.get(name);
		if (entry) {
			await entry.client.close().catch(() => {});
			this.clients.delete(name);
		}
		this.statuses.set(name, { status: "disabled" });
	}

	/**
	 * Get status of all configured servers.
	 */
	getStatuses(): Map<string, McpServerStatus> {
		return new Map(this.statuses);
	}

	/**
	 * Get all server infos (config + status + tools).
	 */
	getServerInfos(): McpServerInfo[] {
		const { merged } = loadMcpConfig(this.cwd, this.agentDir);
		return Object.entries(merged.mcpServers).map(([name, config]) => {
			const entry = this.clients.get(name);
			return {
				name,
				config,
				status: this.statuses.get(name) ?? { status: "disabled" },
				tools: entry?.tools ?? [],
			};
		});
	}

	/**
	 * Get all tools from connected servers, with server name prefix.
	 * Returns a map of `mcp_{serverName}_{toolName}` → { tool, client, serverName }.
	 */
	getTools(): Map<string, { mcpTool: McpToolDef; client: Client; serverName: string }> {
		const result = new Map<string, { mcpTool: McpToolDef; client: Client; serverName: string }>();

		for (const [serverName, entry] of this.clients) {
			const disabledTools = new Set(entry.config.disabledTools ?? []);
			for (const tool of entry.tools) {
				if (disabledTools.has(tool.name)) continue;
				const sanitizedServer = serverName.replace(/[^a-zA-Z0-9_-]/g, "_");
				const sanitizedTool = tool.name.replace(/[^a-zA-Z0-9_-]/g, "_");
				const key = `mcp_${sanitizedServer}_${sanitizedTool}`;
				result.set(key, { mcpTool: tool, client: entry.client, serverName });
			}
		}

		return result;
	}

	/**
	 * Shut down all clients.
	 */
	async shutdown(): Promise<void> {
		await Promise.all(Array.from(this.clients.values()).map((entry) => entry.client.close().catch(() => {})));
		this.clients.clear();
		this.statuses.clear();
		this.pendingOAuth.clear();
	}

	/**
	 * Reload: disconnect all, re-read config, reconnect.
	 */
	async reload(silent = false): Promise<void> {
		await this.shutdown();
		this._initialized = false;
		await this.initialize(silent);
	}

	// -----------------------------------------------------------------------
	// Private
	// -----------------------------------------------------------------------

	private async createClient(
		name: string,
		config: McpServerConfig,
		silent: boolean,
	): Promise<McpClientEntry | undefined> {
		const timeout = config.timeout ?? DEFAULT_TIMEOUT;

		if (config.type === "stdio") {
			return this.createStdioClient(name, config, timeout, silent);
		}

		if (config.type === "http") {
			return this.createHttpClient(name, config, timeout, silent);
		}

		return undefined;
	}

	private async createStdioClient(
		name: string,
		config: McpStdioConfig,
		timeout: number,
		silent: boolean,
	): Promise<McpClientEntry | undefined> {
		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(process.env)) {
			if (value !== undefined) env[key] = value;
		}
		if (config.env) {
			Object.assign(env, config.env);
		}

		const transport = new StdioClientTransport({
			command: config.command,
			args: config.args ?? [],
			env,
			stderr: "pipe",
		});

		transport.stderr?.on("data", (chunk: Buffer) => {
			if (!silent) {
				console.error(chalk.dim(`[mcp:${name}] ${chunk.toString().trimEnd()}`));
			}
		});

		const client = new Client({ name: APP_NAME, version: VERSION });
		await withTimeout(client.connect(transport), timeout);

		const toolsResult = await withTimeout(client.listTools(), timeout).catch(() => undefined);
		if (!toolsResult) {
			await client.close().catch(() => {});
			throw new Error("Failed to list tools");
		}

		return { client, tools: toolsResult.tools, config };
	}

	private async createHttpClient(
		name: string,
		config: McpHttpConfig,
		timeout: number,
		_silent: boolean,
	): Promise<McpClientEntry | undefined> {
		let capturedAuthUrl: string | undefined;
		const authProvider = new McpOAuthProvider(
			name,
			config.url,
			{},
			{
				onRedirect: async (url) => {
					capturedAuthUrl = url.toString();
				},
			},
		);

		const requestInit = config.headers ? { headers: config.headers } : undefined;

		const transports: Array<{ label: string; transport: HttpTransport }> = [
			{
				label: "StreamableHTTP",
				transport: new StreamableHTTPClientTransport(new URL(config.url), {
					authProvider,
					requestInit,
				}),
			},
			{
				label: "SSE",
				transport: new SSEClientTransport(new URL(config.url), {
					authProvider,
					requestInit,
				}),
			},
		];

		let lastError: Error | undefined;
		for (const { transport } of transports) {
			try {
				const client = new Client({ name: APP_NAME, version: VERSION });
				await withTimeout(client.connect(transport), timeout);

				const toolsResult = await withTimeout(client.listTools(), timeout).catch(() => undefined);
				if (!toolsResult) {
					await client.close().catch(() => {});
					throw new Error("Failed to list tools");
				}

				return { client, tools: toolsResult.tools, config };
			} catch (error) {
				const err = error instanceof Error ? error : new Error(String(error));

				// SDK throws UnauthorizedError when auth flow reaches redirect stage
				if (error instanceof UnauthorizedError) {
					this.pendingOAuth.set(name, { transport, authorizationUrl: capturedAuthUrl });
					this.statuses.set(name, { status: "needs_auth" });
					return undefined;
				}

				// DCR (dynamic client registration) rejected — server requires pre-registered client_id
				const isDcrFailure = err.message.includes("403") || err.message.includes("registration");
				if (isDcrFailure && !capturedAuthUrl) {
					if (!_silent) {
						console.error(chalk.yellow(`MCP server "${name}": OAuth client registration rejected (403).`));
						console.error(chalk.dim("This server does not support dynamic client registration."));
						console.error(chalk.dim("Use a server that supports DCR, or provide a pre-registered OAuth client."));
					}
				}

				lastError = err;
			}
		}

		throw lastError ?? new Error("All transports failed");
	}

	// -----------------------------------------------------------------------
	// OAuth authentication
	// -----------------------------------------------------------------------

	/**
	 * Start OAuth flow. If a pending transport already exists from the initial
	 * connect (with a captured authorization URL), reuse it. Otherwise trigger
	 * a fresh connect to discover the OAuth endpoint.
	 */
	async startAuth(name: string): Promise<{ authorizationUrl: string }> {
		const { merged } = loadMcpConfig(this.cwd, this.agentDir);
		const config = merged.mcpServers[name];
		if (!config || config.type !== "http") {
			throw new Error(`MCP server "${name}" is not an HTTP server`);
		}

		await ensureOAuthCallbackServer();

		// Reuse pending OAuth from initial connect if available
		const pending = this.pendingOAuth.get(name);
		if (pending?.authorizationUrl) {
			return { authorizationUrl: pending.authorizationUrl };
		}

		// No pending auth with a captured URL — must initialize first to trigger SDK auth flow
		if (!this._initialized) {
			await this.initialize(true);
			const retryPending = this.pendingOAuth.get(name);
			if (retryPending?.authorizationUrl) {
				return { authorizationUrl: retryPending.authorizationUrl };
			}
		}

		// If we still don't have an auth URL, the server likely rejected dynamic client registration
		const status = this.statuses.get(name);
		if (status?.status === "needs_auth") {
			throw new Error(
				`Server "${name}" requires OAuth but rejected dynamic client registration (HTTP 403). ` +
					`This server (e.g. Figma) requires a pre-registered OAuth client. ` +
					`Third-party MCP clients cannot currently authenticate with it.`,
			);
		}

		throw new Error(`Cannot start OAuth for "${name}": server status is ${status?.status ?? "unknown"}`);
	}

	/**
	 * Full OAuth flow: startAuth → open browser → wait for callback → finishAuth → reconnect.
	 */
	async authenticate(name: string): Promise<McpServerStatus> {
		const { authorizationUrl } = await this.startAuth(name);
		if (!authorizationUrl) {
			await this.reconnectAfterAuth(name);
			return this.statuses.get(name) ?? { status: "connected" };
		}

		const { getMcpOAuthState, clearMcpOAuthState, updateMcpOAuthState } = await import("./auth.js");

		// Ensure we have an oauthState for the callback server to match on.
		// The SDK embeds a `state` param in the authorization URL already.
		// We need to extract it so our callback server can correlate the response.
		let oauthState = getMcpOAuthState(name);
		if (!oauthState) {
			try {
				const url = new URL(authorizationUrl);
				oauthState = url.searchParams.get("state") ?? undefined;
			} catch {}
		}
		if (!oauthState) {
			oauthState = Array.from(crypto.getRandomValues(new Uint8Array(32)))
				.map((b) => b.toString(16).padStart(2, "0"))
				.join("");
			updateMcpOAuthState(name, oauthState);
		}

		const callbackPromise = waitForOAuthCallback(oauthState);

		const open = (await import("open")).default;
		try {
			await open(authorizationUrl);
		} catch {
			console.log(chalk.yellow("Could not open browser. Please open this URL manually:"));
			console.log(authorizationUrl);
		}

		const code = await callbackPromise;
		clearMcpOAuthState(name);

		return this.finishAuth(name, code);
	}

	/**
	 * Complete OAuth with the authorization code, then reconnect.
	 */
	private async finishAuth(name: string, authorizationCode: string): Promise<McpServerStatus> {
		const pending = this.pendingOAuth.get(name);
		if (!pending) {
			throw new Error(`No pending OAuth flow for MCP server: ${name}`);
		}

		try {
			await pending.transport.finishAuth(authorizationCode);
			const { clearMcpCodeVerifier } = await import("./auth.js");
			clearMcpCodeVerifier(name);
			this.pendingOAuth.delete(name);
			return await this.reconnectAfterAuth(name);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			const failed: McpServerStatus = { status: "failed", error: msg };
			this.statuses.set(name, failed);
			return failed;
		}
	}

	/**
	 * Reconnect a server after successful OAuth.
	 */
	private async reconnectAfterAuth(name: string): Promise<McpServerStatus> {
		const { merged } = loadMcpConfig(this.cwd, this.agentDir);
		const config = merged.mcpServers[name];
		if (!config) {
			const failed: McpServerStatus = { status: "failed", error: "Server config not found" };
			this.statuses.set(name, failed);
			return failed;
		}
		return this.connectServer(name, config, true);
	}

	/**
	 * Remove stored OAuth credentials for an MCP server.
	 */
	async removeAuth(name: string): Promise<void> {
		removeMcpAuth(name);
		cancelPendingOAuth(name);
		this.pendingOAuth.delete(name);
	}
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}
