import { z } from "zod";
import { juniorToolResultSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

export const EXECUTE_TOOL_NAME = "executeTool";

/** Create the model-visible dispatcher schema for catalog tools. */
export function createExecuteToolTool() {
  return zodTool({
    description:
      "Execute any catalog tool by exact tool_name from searchTools. Put tool-specific parameters inside arguments.",
    executionMode: "sequential",
    inputSchema: z
      .object({
        tool_name: z
          .string()
          .min(1)
          .describe("Exact catalog tool_name returned by searchTools."),
        arguments: z
          .record(z.string(), z.unknown())
          .describe(
            'Arguments matching the selected catalog tool schema, for example { "query": "..." }.',
          )
          .optional(),
      })
      .strict(),
    outputSchema: juniorToolResultSchema,
    execute: async () => {
      throw new ToolInputError(
        "executeTool can only run through the agent tool dispatcher.",
      );
    },
  });
}
