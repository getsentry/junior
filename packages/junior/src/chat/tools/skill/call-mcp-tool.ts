import { Type } from "@sinclair/typebox";
import type { McpToolManager } from "@/chat/mcp/tool-manager";
import type { Skill } from "@/chat/skills";
import { tool } from "@/chat/tools/definition";

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

/** Create the stable dispatcher for active MCP provider tools. */
export function createCallMcpToolTool(
  mcpToolManager: McpToolManager,
  getActiveSkills: () => Skill[],
) {
  return tool({
    description:
      "Call an active MCP tool by exact tool_name. Use loadSkill to activate the provider, then searchMcpTools to discover tool names and schemas; copy required provider fields into arguments. Do not call with only tool_name unless the discovered tool has no arguments. Authorization is handled by the runtime when required.",
    inputSchema: Type.Object(
      {
        tool_name: Type.String({
          minLength: 1,
          description: "Exact MCP tool_name from searchMcpTools.",
        }),
        arguments: Type.Optional(
          Type.Record(Type.String(), Type.Unknown(), {
            description:
              'Arguments matching the disclosed MCP tool schema, for example { "query": "..." } when searchMcpTools shows query is required.',
          }),
        ),
      },
      { additionalProperties: false },
    ),
    execute: async (input) => {
      const { tool_name } = input;
      const mcpTool = mcpToolManager
        .getResolvedActiveTools(getActiveSkills())
        .find((candidate) => candidate.name === tool_name);
      if (!mcpTool) {
        throw new Error(`MCP tool is not active for this turn: ${tool_name}`);
      }
      return await mcpTool.execute(
        resolveMcpArguments(input as Record<string, unknown>),
      );
    },
  });
}
