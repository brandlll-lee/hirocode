/**
 * MCP OAuth provider implementation.
 *
 * Implements the OAuthClientProvider interface from the MCP SDK.
 * Adapted from OpenCode's McpOAuthProvider.
 */

import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
	OAuthClientInformation,
	OAuthClientInformationFull,
	OAuthClientMetadata,
	OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { APP_NAME } from "../../config.js";
import {
	getMcpAuth,
	getMcpAuthForUrl,
	updateMcpAuthClientInfo,
	updateMcpAuthTokens,
	updateMcpCodeVerifier,
	updateMcpOAuthState,
} from "./auth.js";

export const OAUTH_CALLBACK_PORT = 19876;
export const OAUTH_CALLBACK_PATH = "/mcp/oauth/callback";

export interface McpOAuthConfig {
	clientId?: string;
	clientSecret?: string;
	scope?: string;
}

export interface McpOAuthCallbacks {
	onRedirect: (url: URL) => void | Promise<void>;
}

export class McpOAuthProvider implements OAuthClientProvider {
	constructor(
		private mcpName: string,
		private serverUrl: string,
		private config: McpOAuthConfig,
		private callbacks: McpOAuthCallbacks,
	) {}

	get redirectUrl(): string {
		return `http://127.0.0.1:${OAUTH_CALLBACK_PORT}${OAUTH_CALLBACK_PATH}`;
	}

	get clientMetadata(): OAuthClientMetadata {
		return {
			redirect_uris: [this.redirectUrl],
			client_name: APP_NAME,
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: this.config.clientSecret ? "client_secret_post" : "none",
		};
	}

	async clientInformation(): Promise<OAuthClientInformation | undefined> {
		if (this.config.clientId) {
			return {
				client_id: this.config.clientId,
				client_secret: this.config.clientSecret,
			};
		}

		const entry = getMcpAuthForUrl(this.mcpName, this.serverUrl);
		if (entry?.clientInfo) {
			if (entry.clientInfo.clientSecretExpiresAt && entry.clientInfo.clientSecretExpiresAt < Date.now() / 1000) {
				return undefined;
			}
			return {
				client_id: entry.clientInfo.clientId,
				client_secret: entry.clientInfo.clientSecret,
			};
		}

		return undefined;
	}

	async saveClientInformation(info: OAuthClientInformationFull): Promise<void> {
		updateMcpAuthClientInfo(
			this.mcpName,
			{
				clientId: info.client_id,
				clientSecret: info.client_secret,
				clientIdIssuedAt: info.client_id_issued_at,
				clientSecretExpiresAt: info.client_secret_expires_at,
			},
			this.serverUrl,
		);
	}

	async tokens(): Promise<OAuthTokens | undefined> {
		const entry = getMcpAuthForUrl(this.mcpName, this.serverUrl);
		if (!entry?.tokens) return undefined;

		return {
			access_token: entry.tokens.accessToken,
			token_type: "Bearer",
			refresh_token: entry.tokens.refreshToken,
			expires_in: entry.tokens.expiresAt
				? Math.max(0, Math.floor(entry.tokens.expiresAt - Date.now() / 1000))
				: undefined,
			scope: entry.tokens.scope,
		};
	}

	async saveTokens(tokens: OAuthTokens): Promise<void> {
		updateMcpAuthTokens(
			this.mcpName,
			{
				accessToken: tokens.access_token,
				refreshToken: tokens.refresh_token,
				expiresAt: tokens.expires_in ? Date.now() / 1000 + tokens.expires_in : undefined,
				scope: tokens.scope,
			},
			this.serverUrl,
		);
	}

	async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
		await this.callbacks.onRedirect(authorizationUrl);
	}

	async saveCodeVerifier(codeVerifier: string): Promise<void> {
		updateMcpCodeVerifier(this.mcpName, codeVerifier);
	}

	async codeVerifier(): Promise<string> {
		const entry = getMcpAuth(this.mcpName);
		if (!entry?.codeVerifier) {
			throw new Error(`No code verifier saved for MCP server: ${this.mcpName}`);
		}
		return entry.codeVerifier;
	}

	async saveState(state: string): Promise<void> {
		updateMcpOAuthState(this.mcpName, state);
	}

	async state(): Promise<string> {
		const entry = getMcpAuth(this.mcpName);
		if (entry?.oauthState) {
			return entry.oauthState;
		}
		const newState = Array.from(crypto.getRandomValues(new Uint8Array(32)))
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");
		updateMcpOAuthState(this.mcpName, newState);
		return newState;
	}

	async invalidateCredentials(type: "all" | "client" | "tokens"): Promise<void> {
		const entry = getMcpAuth(this.mcpName);
		if (!entry) return;

		const { removeMcpAuth, setMcpAuth } = await import("./auth.js");
		switch (type) {
			case "all":
				removeMcpAuth(this.mcpName);
				break;
			case "client":
				delete entry.clientInfo;
				setMcpAuth(this.mcpName, entry);
				break;
			case "tokens":
				delete entry.tokens;
				setMcpAuth(this.mcpName, entry);
				break;
		}
	}
}
