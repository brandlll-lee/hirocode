/**
 * MCP (Model Context Protocol) module - public API.
 *
 * Provides MCP server configuration, lifecycle management,
 * and tool bridging for hirocode.
 */

export {
	getMcpAuth,
	isMcpTokenExpired,
	type McpAuthClientInfo,
	type McpAuthEntry,
	type McpAuthTokens,
	removeMcpAuth,
	setMcpAuth,
} from "./auth.js";
export {
	getProjectMcpConfigPath,
	getUserMcpConfigPath,
	loadMcpConfig,
	type McpConfigFile,
	type McpHttpConfig,
	type McpServerConfig,
	type McpStdioConfig,
	removeUserMcpServer,
	setUserMcpServerDisabled,
	watchMcpConfig,
	writeUserMcpServer,
} from "./config.js";
export {
	McpManager,
	type McpServerInfo,
	type McpServerStatus,
} from "./manager.js";
export {
	cancelPendingOAuth,
	ensureOAuthCallbackServer,
	stopOAuthCallbackServer,
	waitForOAuthCallback,
} from "./oauth-callback.js";

export {
	McpOAuthProvider,
	OAUTH_CALLBACK_PATH,
	OAUTH_CALLBACK_PORT,
} from "./oauth-provider.js";
export { convertMcpToolToDefinition } from "./tool-bridge.js";
