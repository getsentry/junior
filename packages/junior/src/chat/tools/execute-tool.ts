import { executeToolInputSchema } from "@/chat/tool-support/catalog-tool-call";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool, zodToolDefinition } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tool-support/tool-input-error";

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
