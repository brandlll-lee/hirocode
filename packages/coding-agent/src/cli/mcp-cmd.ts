/**
 * CLI subcommands for MCP server management.
 *
 * hirocode mcp add <name> <url> --type http [--header "KEY: VALUE"...]
 * hirocode mcp add <name> "<command>" [--env KEY=VALUE...]
 * hirocode mcp remove <name>
 * hirocode mcp list
 */

import chalk from "chalk";
import { APP_NAME } from "../config.js";
import {
	loadMcpConfig,
	type McpHttpConfig,
	McpManager,
	type McpServerConfig,
	type McpStdioConfig,
	removeUserMcpServer,
	writeUserMcpServer,
} from "../core/mcp/index.js";

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface McpCommandOptions {
	subcommand: "add" | "remove" | "list" | "auth" | "help";
	name?: string;
	// For add
	type?: "http" | "stdio";
	url?: string;
	command?: string;
	headers?: Record<string, string>;
	envVars?: Record<string, string>;
	help?: boolean;
}

function parseMcpArgs(args: string[]): McpCommandOptions | undefined {
	if (args[0] !== "mcp") return undefined;

	const sub = args[1];
	if (!sub || sub === "--help" || sub === "-h") {
		return { subcommand: "help" };
	}

	if (sub === "list" || sub === "ls") {
		return { subcommand: "list" };
	}

	if (sub === "remove" || sub === "rm") {
		const name = args[2];
		if (!name) return { subcommand: "help" };
		return { subcommand: "remove", name };
	}

	if (sub === "auth") {
		const name = args[2];
		if (!name) return { subcommand: "help" };
		return { subcommand: "auth", name };
	}

	if (sub === "add") {
		const name = args[2];
		if (!name || name.startsWith("-")) return { subcommand: "help" };

		let type: "http" | "stdio" | undefined;
		let url: string | undefined;
		let command: string | undefined;
		const headers: Record<string, string> = {};
		const envVars: Record<string, string> = {};

		const rest = args.slice(3);
		for (let i = 0; i < rest.length; i++) {
			const arg = rest[i];
			if (arg === "--type" && i + 1 < rest.length) {
				const t = rest[++i];
				if (t === "http" || t === "stdio") type = t;
			} else if (arg === "--header" && i + 1 < rest.length) {
				const h = rest[++i];
				const idx = h.indexOf(":");
				if (idx > 0) {
					headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
				}
			} else if (arg === "--env" && i + 1 < rest.length) {
				const e = rest[++i];
				const idx = e.indexOf("=");
				if (idx > 0) {
					envVars[e.slice(0, idx)] = e.slice(idx + 1);
				}
			} else if (!arg.startsWith("-")) {
				if (!url && !command) {
					// First positional after name: could be URL or command
					if (arg.startsWith("http://") || arg.startsWith("https://")) {
						url = arg;
						if (!type) type = "http";
					} else {
						command = arg;
						if (!type) type = "stdio";
					}
				}
			}
		}

		return { subcommand: "add", name, type, url, command, headers, envVars };
	}

	return { subcommand: "help" };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function printMcpHelp(): void {
	console.log(`${chalk.bold("Usage:")}
  ${APP_NAME} mcp <command>

${chalk.bold("Commands:")}
  add <name> <url> --type http [--header "KEY: VALUE"...]   Add HTTP MCP server
  add <name> "<command>" [--env KEY=VALUE...]                Add stdio MCP server
  remove <name>                                              Remove MCP server
  auth <name>                                                Authenticate OAuth server
  list                                                       List configured servers

${chalk.bold("Examples:")}
  ${APP_NAME} mcp add figma https://mcp.figma.com/mcp --type http
  ${APP_NAME} mcp add playwright "npx -y @playwright/mcp@latest"
  ${APP_NAME} mcp add stripe https://mcp.stripe.com --type http
  ${APP_NAME} mcp auth figma
  ${APP_NAME} mcp remove figma
  ${APP_NAME} mcp list
`);
}

async function handleAdd(options: McpCommandOptions): Promise<void> {
	const { name, type, url, command, headers, envVars } = options;
	if (!name) {
		console.error(chalk.red("Missing server name."));
		return;
	}

	let config: McpServerConfig;

	if (type === "http" || (!type && url)) {
		if (!url) {
			console.error(chalk.red("Missing URL for HTTP server."));
			return;
		}
		const httpConfig: McpHttpConfig = { type: "http", url };
		if (headers && Object.keys(headers).length > 0) {
			httpConfig.headers = headers;
		}
		config = httpConfig;
	} else {
		if (!command) {
			console.error(chalk.red("Missing command for stdio server."));
			return;
		}
		const parts = command.split(/\s+/);
		const stdioConfig: McpStdioConfig = {
			type: "stdio",
			command: parts[0],
			args: parts.slice(1),
		};
		if (envVars && Object.keys(envVars).length > 0) {
			stdioConfig.env = envVars;
		}
		config = stdioConfig;
	}

	writeUserMcpServer(name, config);
	console.log(chalk.green(`Added MCP server "${name}".`));

	// Try connecting to verify
	console.log(chalk.dim("Verifying connection..."));
	const manager = new McpManager();
	const status = await manager.connectServer(name, config, true);
	await manager.shutdown();

	if (status.status === "connected") {
		console.log(chalk.green("Connection verified."));
	} else if (status.status === "needs_auth") {
		console.log(chalk.yellow("Server requires OAuth authentication."));
		console.log(chalk.dim(`Run: ${APP_NAME} mcp auth ${name}`));
	} else if (status.status === "failed") {
		console.log(chalk.yellow(`Warning: ${(status as any).error}`));
		console.log(chalk.dim("Server added to config but connection failed. Check the URL/command."));
	}
}

function handleRemove(name: string): void {
	const removed = removeUserMcpServer(name);
	if (removed) {
		console.log(chalk.green(`Removed MCP server "${name}".`));
	} else {
		console.error(chalk.red(`No MCP server named "${name}" found in user config.`));
		console.error(chalk.dim("Project-level servers cannot be removed via CLI. Edit .hirocode/mcp.json directly."));
	}
}

async function handleAuth(name: string): Promise<void> {
	const { merged } = loadMcpConfig();
	const config = merged.mcpServers[name];
	if (!config) {
		console.error(chalk.red(`No MCP server named "${name}" found.`));
		return;
	}
	if (config.type !== "http") {
		console.error(chalk.red(`MCP server "${name}" is not an HTTP server. OAuth only applies to HTTP servers.`));
		return;
	}

	console.log(chalk.dim("Starting OAuth flow... Check your browser."));
	const manager = new McpManager();
	try {
		const status = await manager.authenticate(name);
		if (status.status === "connected") {
			console.log(chalk.green(`Authentication successful for "${name}".`));
		} else if (status.status === "needs_auth") {
			console.log(chalk.yellow(`Authentication still required for "${name}".`));
		} else if (status.status === "failed") {
			console.log(chalk.red(`Authentication failed: ${(status as any).error}`));
		} else {
			console.log(chalk.dim(`Status: ${status.status}`));
		}
	} catch (error) {
		console.error(chalk.red(`Auth failed: ${error instanceof Error ? error.message : String(error)}`));
	} finally {
		await manager.shutdown();
	}
}

async function handleList(): Promise<void> {
	const { merged } = loadMcpConfig();
	const servers = Object.entries(merged.mcpServers);

	if (servers.length === 0) {
		console.log(chalk.dim("No MCP servers configured."));
		console.log(chalk.dim(`Add one with: ${APP_NAME} mcp add <name> <url> --type http`));
		return;
	}

	const manager = new McpManager();
	await manager.initialize(true);

	for (const [name, config] of servers) {
		const statuses = manager.getStatuses();
		const status = statuses.get(name);
		let statusIcon = "○";
		let statusText = "unknown";

		if (status) {
			if (status.status === "connected") {
				statusIcon = chalk.green("✓");
				statusText = "connected";
			} else if (status.status === "disabled") {
				statusIcon = chalk.dim("○");
				statusText = "disabled";
			} else if (status.status === "failed") {
				statusIcon = chalk.red("✗");
				statusText = `failed: ${status.error}`;
			} else if (status.status === "needs_auth") {
				statusIcon = chalk.yellow("⚠");
				statusText = "needs authentication";
			} else if (status.status === "connecting") {
				statusIcon = chalk.yellow("⋯");
				statusText = "connecting";
			}
		}

		const typeHint =
			config.type === "http" ? config.url : `${config.command} ${(config.args ?? []).join(" ")}`.trim();

		console.log(`  ${statusIcon} ${chalk.bold(name)} ${chalk.dim(statusText)}`);
		console.log(`    ${chalk.dim(typeHint)}`);

		const entry = manager.getTools();
		const serverTools = Array.from(entry.entries())
			.filter(([, v]) => v.serverName === name)
			.map(([, v]) => v.mcpTool.name);
		if (serverTools.length > 0) {
			console.log(`    ${chalk.dim(`tools: ${serverTools.join(", ")}`)}`);
		}
	}

	await manager.shutdown();
	console.log();
	console.log(chalk.dim(`${servers.length} server(s)`));
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function handleMcpCommand(args: string[]): Promise<boolean> {
	const options = parseMcpArgs(args);
	if (!options) return false;

	switch (options.subcommand) {
		case "help":
			printMcpHelp();
			break;
		case "add":
			await handleAdd(options);
			break;
		case "remove":
			handleRemove(options.name!);
			break;
		case "auth":
			await handleAuth(options.name!);
			break;
		case "list":
			await handleList();
			break;
	}

	return true;
}
