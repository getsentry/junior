import { ownedObjectAnnotationSchema } from "@sentry/junior-plugin-api";
import { setSpanAttributes } from "@/chat/logging";
import { McpToolError } from "@/chat/mcp/errors";
import type { ManagedMcpTool } from "@/chat/mcp/tool-manager";
import { parseMcpProviderFromToolName } from "@/chat/mcp/tool-name";
import * as z from "zod";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import { zodTool } from "@/chat/tool-support/zod-tool";

interface CallMcpToolManager {
  getResolvedActiveTools(): ManagedMcpTool[];
}

function resolveMcpArguments(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const extraKeys = Object.keys(input).filter(
    (key) => key !== "tool_name" && key !== "arguments" && key !== "intent",
  );
  if (extraKeys.length > 0) {
    throw new ToolInputError(
      `callMcpTool MCP arguments must be nested under arguments, not top-level fields: ${extraKeys.join(", ")}`,
    );
  }

  if ("arguments" in input) {
    const args = input.arguments;
    if (args === undefined) {
      return {};
    }
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      throw new ToolInputError(
        "callMcpTool arguments must be an object when provided",
      );
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

// TODO(dcramer): Fold MCP execution into executeTool once searchTools can
// disclose MCP tool schemas and the execution catalog keeps them active.
/**
 * Create the stable dispatcher for active MCP provider tools.
 *
 * @runBuilt callMcpTool
 */
export function createCallMcpToolTool(mcpToolManager: CallMcpToolManager) {
  return zodTool({
    permission: "auto",
    annotations: {
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
      readOnlyHint: false,
    },
    description:
      "Call an active MCP tool by its exact name. Use searchMcpTools to discover tool names and schemas; copy required provider fields into arguments. Authorization is handled by the runtime when required.",
    inputSchema: z
      .object({
        tool_name: z
          .string()
          .min(1)
          .describe("Exact MCP tool_name from searchMcpTools."),
        arguments: z
          .record(z.string(), z.unknown())
          .describe(
            'Arguments matching the disclosed MCP tool schema, for example { "query": "..." } when searchMcpTools shows query is required. Omit only when the discovered tool has no arguments.',
          )
          .optional(),
        intent: z
          .string()
          .min(1)
          .describe(
            'Optional short purpose to show the user if this call needs them to connect their account, for example "search Notion for the Q3 offsite doc".',
          )
          .optional(),
      })
      .passthrough(),
    resolveApprovalMetadata: ({ tool_name }) => {
      const activeTool = mcpToolManager
        .getResolvedActiveTools()
        .find((candidate) => candidate.name === tool_name);
      if (!activeTool) {
        return undefined;
      }
      return {
        ...(activeTool.annotations
          ? { annotations: activeTool.annotations }
          : undefined),
        description: activeTool.description,
        name: tool_name,
        source: {
          id: activeTool.provider,
          description: `MCP provider ${activeTool.provider}`,
        },
      };
    },
    outputSchema: z.object({
      result: z
        .unknown()
        .describe(
          "The MCP tool's structured content, or its text content when it has none.",
        ),
      objectCards: z.array(ownedObjectAnnotationSchema),
    }),
    execute: async (input, options) => {
      const { tool_name, intent } = input;
      const provider = parseMcpProviderFromToolName(tool_name);
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
          ...(provider
            ? { "app.mcp.requested_provider": provider }
            : undefined),
          "app.mcp.active_provider_names": activeProviderNames(activeTools),
          "app.mcp.active_tool_count": activeTools.length,
          ...(provider
            ? {
                "app.mcp.matching_provider_tool_count": providerTools.length,
                "app.mcp.matching_provider_tool_names": providerTools
                  .map((candidate) => candidate.name)
                  .sort((a, b) => a.localeCompare(b)),
              }
            : undefined),
        });
        throw new McpToolError(missingToolMessage(tool_name, provider));
      }
      const result = await mcpTool.execute(
        resolveMcpArguments(input as Record<string, unknown>),
        {
          ...(intent ? { authorizationIntent: intent } : undefined),
          conversationPrivacy: options?.conversationPrivacy ?? "private",
          ...(options?.signal ? { signal: options.signal } : undefined),
          ...(options?.toolCallId
            ? { toolCallId: options.toolCallId }
            : undefined),
        },
      );
      // Scripts get `details`, so it carries the MCP result. The result is
      // nested, so provider data cannot set fields that the runtime reads,
      // such as `objectCards`.
      return {
        content: result.content,
        details: {
          result:
            result.structuredContent ??
            result.content
              .flatMap((part) => (part.type === "text" ? [part.text] : []))
              .join("\n"),
          objectCards: result.cards ?? [],
        },
      };
    },
  });
}
