import { definePluginTool } from "@sentry/junior-plugin-api";
import {
  DEFAULT_SEARCH_LIMIT,
  type MemoryToolContext,
  boundedLimit,
  compactMemory,
  memoryManyOutputSchema,
  memoryRuntimeContext,
  memoryStore,
  memoryToolResult,
  parseMemoryToolInput,
  searchMemoriesInputSchema,
} from "../tool-support";

/** Search visible active memories in the active context. */
export const memorySearchTool = definePluginTool({
  description:
    "Search active memories visible in the current context. Use when the model needs targeted memory recall.",
  annotations: {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
    readOnlyHint: true,
  },
  inputSchema: searchMemoriesInputSchema,
  outputSchema: memoryManyOutputSchema,
  execute: async (input, _options, context: MemoryToolContext) => {
    const parsedInput = parseMemoryToolInput(searchMemoriesInputSchema, input);
    const runtimeContext = await memoryRuntimeContext(context);
    const memories = await memoryStore(context, runtimeContext).searchMemories({
      query: parsedInput.query,
      limit: boundedLimit(parsedInput.limit, DEFAULT_SEARCH_LIMIT),
    });
    return memoryToolResult("searchMemories", {
      memories: memories.map(compactMemory),
    });
  },
});
