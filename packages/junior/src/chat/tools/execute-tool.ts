import { Type } from "@sinclair/typebox";
import { tool } from "@/chat/tools/definition";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

export const EXECUTE_TOOL_NAME = "executeTool";

/** Create the model-visible dispatcher schema for catalog tools. */
export function createExecuteToolTool() {
  return tool({
    description:
      "Execute any catalog tool by exact tool_name from searchTools. Put tool-specific parameters inside arguments.",
    executionMode: "sequential",
    inputSchema: Type.Object(
      {
        tool_name: Type.String({
          minLength: 1,
          description: "Exact catalog tool_name returned by searchTools.",
        }),
        arguments: Type.Optional(
          Type.Record(Type.String(), Type.Unknown(), {
            description:
              'Arguments matching the selected catalog tool schema, for example { "query": "..." }.',
          }),
        ),
      },
      { additionalProperties: false },
    ),
    execute: async () => {
      throw new ToolInputError(
        "executeTool can only run through the agent tool dispatcher.",
      );
    },
  });
}
