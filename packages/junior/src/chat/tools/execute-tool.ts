import * as z from "zod";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool, zodToolDefinition } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

export const EXECUTE_TOOL_NAME = "executeTool";
const MISSING_TOOL_NAME_ERROR = "executeTool requires a catalog tool_name.";

/** Input envelope of `executeTool`, which the dispatcher parses before it runs the catalog tool. */
export const executeToolInputSchema = z
  .object(
    {
      tool_name: z
        .string({ error: MISSING_TOOL_NAME_ERROR })
        .min(1, { error: MISSING_TOOL_NAME_ERROR })
        .describe(
          "Exact catalog tool_name, from searchTools or as named by a skill, tool result, or error.",
        ),
      arguments: z
        .record(z.string(), z.unknown(), {
          error: "executeTool arguments must be an object when provided.",
        })
        .describe(
          'Arguments matching the selected catalog tool schema, for example { "query": "..." }.',
        )
        .optional(),
      // `intent` keeps one envelope with callMcpTool. Catalog tool auth
      // prompts use the user's message as the reason, so it is dropped.
      intent: z
        .string()
        .min(1)
        .describe(
          "Optional short purpose of this call. It is not passed to the catalog tool.",
        )
        .optional(),
    },
    {
      error: (issue) =>
        issue.code === "unrecognized_keys"
          ? `executeTool arguments must be nested under arguments, not top-level fields: ${issue.keys.join(", ")}`
          : undefined,
    },
  )
  .strict();

const executeToolDefinition = zodToolDefinition({
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
  inputSchema: executeToolInputSchema,
  outputSchema: juniorToolOutputSchema,
});

/** Create the model-visible dispatcher schema for catalog tools. */
export function createExecuteToolTool() {
  return zodTool({
    ...executeToolDefinition,
    execute: async () => {
      throw new ToolInputError(
        "executeTool can only run through the agent tool dispatcher.",
      );
    },
  });
}
