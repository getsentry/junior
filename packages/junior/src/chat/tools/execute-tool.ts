import * as z from "zod";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

export const EXECUTE_TOOL_NAME = "executeTool";

/** Create the model-visible dispatcher schema for catalog tools. */
export function createExecuteToolTool() {
  return zodTool({
    annotations: {
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
      readOnlyHint: false,
    },
    description:
      "Execute a catalog tool by its exact name. Use it for a tool that is not in your tool list: one that searchTools returned, or one that a skill, tool result, or error names. Put tool-specific parameters inside arguments.",
    executionMode: "sequential",
    exposure: "modelOnly",
    inputSchema: z
      .object({
        tool_name: z
          .string()
          .min(1)
          .describe(
            "Exact catalog tool_name, from searchTools or as named by a skill, tool result, or error.",
          ),
        arguments: z
          .record(z.string(), z.unknown())
          .describe(
            'Arguments matching the selected catalog tool schema, for example { "query": "..." }.',
          )
          .optional(),
      })
      .strict(),
    outputSchema: juniorToolOutputSchema,
    execute: async () => {
      throw new ToolInputError(
        "executeTool can only run through the agent tool dispatcher.",
      );
    },
  });
}
