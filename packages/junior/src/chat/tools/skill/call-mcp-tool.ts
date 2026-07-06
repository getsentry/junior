import { setSpanAttributes } from "@/chat/logging";
import { McpToolError } from "@/chat/mcp/errors";
import type { ManagedMcpTool } from "@/chat/mcp/tool-manager";
import { parseMcpProviderFromToolName } from "@/chat/mcp/tool-name";
import { z } from "zod";
import { zodTool } from "@/chat/tool-support/zod-tool";

interface CallMcpToolManager {
  activateProvider(provider: string): Promise<boolean>;
  getResolvedActiveTools(): ManagedMcpTool[];
}

function resolveMcpArguments(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const extraKeys = Object.keys(input).filter(
    (key) => key !== "tool_name" && key !== "arguments",
  );
  if (extraKeys.length > 0) {
    throw new Error(
      `callMcpTool MCP arguments must be nested under arguments, not top-level fields: ${extraKeys.join(", ")}`,
    );
  }

  if ("arguments" in input) {
    const args = input.arguments;
    if (args === undefined) {
      return {};
    }
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      throw new Error("callMcpTool arguments must be an object when provided");
    }
    return args as Record<string, unknown>;
  }

  return {};
}

function activeProviderNames(tools: ManagedMcpTool[]): string[] {
  return [...new Set(tools.map((toolDef) => toolDef.provider))].sort((a, b) =>
    a.localeCompare(b),
  );
}

function missingToolMessage(toolName: string, provider: string | undefined) {
  const retryHint = provider
    ? `Call searchMcpTools with provider "${provider}" to refresh the catalog, then retry with an exact returned tool_name.`
    : "Call searchMcpTools to refresh the catalog, then retry with an exact returned tool_name.";
  return `MCP tool is not active for this turn: ${toolName}. ${retryHint}`;
}

/** Create the stable dispatcher for active MCP provider tools. */
export function createCallMcpToolTool(mcpToolManager: CallMcpToolManager) {
  return zodTool({
    description:
      "Call an active MCP tool by exact tool_name. Use searchMcpTools to discover tool names and schemas; copy required provider fields into arguments. Do not call with only tool_name unless the discovered tool has no arguments. Authorization is handled by the runtime when required.",
    inputSchema: z.object({
      tool_name: z
        .string()
        .min(1)
        .describe("Exact MCP tool_name from searchMcpTools."),
      arguments: z
        .record(z.string(), z.unknown())
        .describe(
          'Arguments matching the disclosed MCP tool schema, for example { "query": "..." } when searchMcpTools shows query is required.',
        )
        .optional(),
    }),
    execute: async (input, options) => {
      const { tool_name } = input;
      const provider = parseMcpProviderFromToolName(tool_name);
      if (provider) {
        await mcpToolManager.activateProvider(provider);
      }
      const activeTools = mcpToolManager.getResolvedActiveTools();
      const mcpTool = activeTools.find(
        (candidate) => candidate.name === tool_name,
      );
      if (!mcpTool) {
        const providerTools = provider
          ? activeTools.filter((candidate) => candidate.provider === provider)
          : [];
        setSpanAttributes({
          "app.mcp.requested_tool_name": tool_name,
          ...(provider ? { "app.mcp.requested_provider": provider } : {}),
          "app.mcp.active_provider_names": activeProviderNames(activeTools),
          "app.mcp.active_tool_count": activeTools.length,
          ...(provider
            ? {
                "app.mcp.matching_provider_tool_count": providerTools.length,
                "app.mcp.matching_provider_tool_names": providerTools
                  .map((candidate) => candidate.name)
                  .sort((a, b) => a.localeCompare(b)),
              }
            : {}),
        });
        throw new McpToolError(missingToolMessage(tool_name, provider));
      }
      return await mcpTool.execute(
        resolveMcpArguments(input as Record<string, unknown>),
        {
          conversationPrivacy: options?.conversationPrivacy ?? "private",
          ...(options?.toolCallId ? { toolCallId: options.toolCallId } : {}),
        },
      );
    },
  });
}
