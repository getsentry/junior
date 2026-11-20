import { definePluginTool } from "@sentry/junior-plugin-api";
import {
  type MemoryToolContext,
  archiveMemoryInputSchema,
  asToolInputError,
  compactMemory,
  memoryRuntimeContext,
  memorySingleOutputSchema,
  memoryStore,
  memoryToolResult,
  parseMemoryToolInput,
} from "../tool-support";

/** Archive a visible memory in the active context. */
export const memoryArchiveTool = definePluginTool({
  annotations: {
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
    readOnlyHint: false,
  },
  description:
    "Forget one active memory visible in the current context. Use only ids or short id prefixes returned by listMemories or searchMemories. Never remove memories by hidden Actor, provider, scope, or subject ids.",
  executionMode: "sequential",
  inputSchema: archiveMemoryInputSchema,
  outputSchema: memorySingleOutputSchema,
  execute: async (input, _options, context: MemoryToolContext) => {
    const parsedInput = parseMemoryToolInput(archiveMemoryInputSchema, input);
    const runtimeContext = await memoryRuntimeContext(context);
    const memory = await (async () => {
      try {
        return await memoryStore(context, runtimeContext).archiveMemory({
          id: parsedInput.id,
          reason: "tool_removed",
        });
      } catch (error) {
        asToolInputError(error);
      }
    })();
    return memoryToolResult("archiveMemory", {
      memory: compactMemory(memory),
    });
  },
});
