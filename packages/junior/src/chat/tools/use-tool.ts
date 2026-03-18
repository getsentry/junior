import { Type } from "@sinclair/typebox";
import type { Skill } from "@/chat/skills";
import { tool } from "@/chat/tools/definition";
import type { McpToolManager } from "@/chat/mcp/tool-manager";

function normalizeToolArguments(
  value: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return value ?? {};
}

export function createUseToolTool(
  mcpToolManager: McpToolManager,
  getActiveSkills: () => Skill[],
) {
  return tool({
    description:
      "Execute an active MCP tool by canonical tool_name. Use tool_name values disclosed by `loadSkill`, `<loaded_tools>`, or `searchTools`.",
    inputSchema: Type.Object(
      {
        tool_name: Type.String({
          minLength: 1,
          description:
            "Canonical MCP tool name in the form mcp__<provider>__<tool>.",
        }),
        arguments: Type.Optional(
          Type.Object(
            {},
            {
              additionalProperties: true,
              description: "Arguments for the selected MCP tool.",
            },
          ),
        ),
      },
      { additionalProperties: false },
    ),
    execute: async ({ tool_name, arguments: rawArguments }) => {
      const activeSkills = getActiveSkills();
      return await mcpToolManager.executeTool(
        activeSkills,
        tool_name,
        normalizeToolArguments(rawArguments),
      );
    },
  });
}
