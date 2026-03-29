/**
 * OAuth callback HTTP server for MCP authentication.
 *
 * Listens on localhost for the OAuth redirect and captures
 * the authorization code.
 *
 * Adapted from OpenCode's McpOAuthCallback.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http";
import { OAUTH_CALLBACK_PATH, OAUTH_CALLBACK_PORT } from "./oauth-provider.js";

const HTML_SUCCESS = `<!DOCTYPE html>
<html>
<head><title>Authorization Successful</title>
<style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#1a1a2e;color:#eee}.container{text-align:center;padding:2rem}h1{color:#4ade80}</style>
</head><body><div class="container"><h1>Authorization Successful</h1><p>You can close this window.</p></div>
<script>setTimeout(()=>window.close(),2000)</script></body></html>`;

const HTML_ERROR = (msg: string) => `<!DOCTYPE html>
<html>
<head><title>Authorization Failed</title>
<style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#1a1a2e;color:#eee}.container{text-align:center;padding:2rem}h1{color:#f87171}.error{color:#fca5a5;font-family:monospace;margin-top:1rem;padding:1rem;background:rgba(248,113,113,0.1);border-radius:0.5rem}</style>
</head><body><div class="container"><h1>Authorization Failed</h1><div class="error">${msg}</div></div></body></html>`;

// ---------------------------------------------------------------------------
// Pending auth registry
// ---------------------------------------------------------------------------

interface PendingAuth {
	resolve: (code: string) => void;
	reject: (error: Error) => void;
	timeout: ReturnType<typeof setTimeout>;
}

const pendingAuths = new Map<string, PendingAuth>();
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

let server: Server | undefined;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function ensureOAuthCallbackServer(): Promise<void> {
	if (server) return;

	server = createServer(handleRequest);
	await new Promise<void>((resolve, reject) => {
		server!.listen(OAUTH_CALLBACK_PORT, "127.0.0.1", () => resolve());
		server!.on("error", reject);
	});
}

export function waitForOAuthCallback(oauthState: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			if (pendingAuths.has(oauthState)) {
				pendingAuths.delete(oauthState);
				reject(new Error("OAuth callback timeout"));
			}
		}, CALLBACK_TIMEOUT_MS);

		pendingAuths.set(oauthState, { resolve, reject, timeout });
	});
}

export function cancelPendingOAuth(state: string): void {
	const pending = pendingAuths.get(state);
	if (pending) {
		clearTimeout(pending.timeout);
		pendingAuths.delete(state);
		pending.reject(new Error("Authorization cancelled"));
	}
}

export async function stopOAuthCallbackServer(): Promise<void> {
	if (server) {
		server.close();
		server = undefined;
	}
	for (const [, pending] of pendingAuths) {
		clearTimeout(pending.timeout);
		pending.reject(new Error("Server stopped"));
	}
	pendingAuths.clear();
}

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
	const url = new URL(req.url ?? "/", `http://127.0.0.1:${OAUTH_CALLBACK_PORT}`);

	if (url.pathname !== OAUTH_CALLBACK_PATH) {
		res.writeHead(404);
		res.end("Not found");
		return;
	}

	const code = url.searchParams.get("code");
	const state = url.searchParams.get("state");
	const error = url.searchParams.get("error");
	const errorDescription = url.searchParams.get("error_description");

	if (!state) {
		res.writeHead(400, { "Content-Type": "text/html" });
		res.end(HTML_ERROR("Missing state parameter"));
		return;
	}

	if (error) {
		const msg = errorDescription || error;
		const pending = pendingAuths.get(state);
		if (pending) {
			clearTimeout(pending.timeout);
			pendingAuths.delete(state);
			pending.reject(new Error(msg));
		}
		res.writeHead(200, { "Content-Type": "text/html" });
		res.end(HTML_ERROR(msg));
		return;
	}

	if (!code) {
		res.writeHead(400, { "Content-Type": "text/html" });
		res.end(HTML_ERROR("No authorization code"));
		return;
	}

	if (!pendingAuths.has(state)) {
		res.writeHead(400, { "Content-Type": "text/html" });
		res.end(HTML_ERROR("Invalid or expired state"));
		return;
	}

	const pending = pendingAuths.get(state)!;
	clearTimeout(pending.timeout);
	pendingAuths.delete(state);
	pending.resolve(code);

	res.writeHead(200, { "Content-Type": "text/html" });
	res.end(HTML_SUCCESS);
}
