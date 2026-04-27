import { Type } from "@sinclair/typebox";
import type { McpToolManager } from "@/chat/mcp/tool-manager";
import type { Skill } from "@/chat/skills";
import { tool } from "@/chat/tools/definition";

export function createCallMcpToolTool(
  mcpToolManager: McpToolManager,
  getActiveSkills: () => Skill[],
) {
  return tool({
    description:
      "Call an MCP tool that has already been exposed by loadSkill or <active-mcp-tools>. Use the exact tool_name from the disclosed tool list.",
    inputSchema: Type.Object(
      {
        tool_name: Type.String({
          minLength: 1,
          description:
            "Exact MCP tool_name from loadSkill.available_tools or <active-mcp-tools>.",
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
