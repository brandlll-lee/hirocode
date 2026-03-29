/**
 * Bridge MCP tools into hirocode's ToolDefinition format.
 *
 * Inspired by OpenCode's convertMcpTool() and hirocode's existing
 * tool-definition-wrapper.ts pattern.
 */

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CallToolResultSchema, type Tool as McpToolDef } from "@modelcontextprotocol/sdk/types.js";
import { type TObject, type TSchema, Type } from "@sinclair/typebox";
import type { ToolDefinition } from "../extensions/types.js";

/**
 * Convert a JSON Schema object (from MCP tool inputSchema) to a TypeBox TObject.
 *
 * MCP tools provide JSON Schema; hirocode ToolDefinition expects TypeBox schemas.
 * We wrap the raw JSON Schema using Type.Unsafe() so it passes through to the
 * LLM provider as-is while satisfying the TypeBox type constraint.
 */
function jsonSchemaToTypeBox(inputSchema: McpToolDef["inputSchema"]): TObject {
	const schema = {
		...inputSchema,
		type: "object" as const,
		properties: (inputSchema.properties ?? {}) as Record<string, TSchema>,
		additionalProperties: false,
	};
	return Type.Unsafe(schema) as unknown as TObject;
}

/**
 * Convert a single MCP tool definition into a hirocode ToolDefinition.
 */
export function convertMcpToolToDefinition(
	serverName: string,
	mcpTool: McpToolDef,
	client: Client,
	toolKey: string,
	timeout?: number,
): ToolDefinition {
	const parameters = jsonSchemaToTypeBox(mcpTool.inputSchema);

	return {
		name: toolKey,
		label: `MCP: ${serverName}/${mcpTool.name}`,
		description: mcpTool.description ?? `MCP tool ${mcpTool.name} from ${serverName}`,
		parameters,
		execute: async (_toolCallId, params, _signal, _onUpdate) => {
			try {
				const result = await client.callTool(
					{
						name: mcpTool.name,
						arguments: (params || {}) as Record<string, unknown>,
					},
					CallToolResultSchema,
					{
						resetTimeoutOnProgress: true,
						timeout: timeout ?? 30_000,
					},
				);

				const textParts: string[] = [];
				if (result.content && Array.isArray(result.content)) {
					for (const block of result.content) {
						if (block.type === "text" && typeof block.text === "string") {
							textParts.push(block.text);
						}
					}
				}

				const text = textParts.length > 0 ? textParts.join("\n") : "Tool executed successfully (no text output)";

				if (result.isError) {
					return {
						content: [{ type: "text", text: `Error: ${text}` }],
						details: undefined,
					};
				}

				return {
					content: [{ type: "text", text }],
					details: undefined,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `MCP tool error: ${message}` }],
					details: undefined,
				};
			}
		},
	};
}
