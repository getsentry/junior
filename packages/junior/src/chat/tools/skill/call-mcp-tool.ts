import { Type } from "@sinclair/typebox";
import type { McpToolManager } from "@/chat/mcp/tool-manager";
import type { Skill } from "@/chat/skills";
import { tool } from "@/chat/tools/definition";

/** Create the stable dispatcher for active MCP provider tools. */
export function createCallMcpToolTool(
  mcpToolManager: McpToolManager,
  getActiveSkills: () => Skill[],
) {
  return tool({
    description:
      "Call an active MCP tool by exact tool_name. Use loadSkill to activate the provider, then searchMcpTools to discover tool names and schemas; authorization is handled by the runtime when required.",
    inputSchema: Type.Object(
      {
        tool_name: Type.String({
          minLength: 1,
          description: "Exact MCP tool_name from searchMcpTools.",
        }),
        arguments: Type.Optional(
          Type.Record(Type.String(), Type.Unknown(), {
            description: "Arguments matching the disclosed MCP tool schema.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    execute: async ({ tool_name, arguments: args }) => {
      const mcpTool = mcpToolManager
        .getResolvedActiveTools(getActiveSkills())
        .find((candidate) => candidate.name === tool_name);
      if (!mcpTool) {
        throw new Error(`MCP tool is not active for this turn: ${tool_name}`);
      }
      return await mcpTool.execute(args ?? {});
    },
  });
}
