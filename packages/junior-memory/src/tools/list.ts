import { definePluginTool } from "@sentry/junior-plugin-api";
import { listMemories as listViewerMemories } from "../viewer";
import {
  DEFAULT_RESULT_LIMIT,
  type MemoryToolContext,
  boundedLimit,
  compactMemory,
  listMemoriesInputSchema,
  memoryManyOutputSchema,
  memoryRuntimeContext,
  memoryStore,
  memoryToolResult,
  parseMemoryToolInput,
} from "../tool-support";

/** List visible active or archived memories in the active context. */
export const memoryListTool = definePluginTool({
  description:
    "List memories visible in the current context, newest first. Use when the user asks what you remember, or when memory ids are needed before removing or restoring a memory.",
  annotations: {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
    readOnlyHint: true,
  },
  inputSchema: listMemoriesInputSchema,
  outputSchema: memoryManyOutputSchema,
  execute: async (input, _options, context: MemoryToolContext) => {
    const parsedInput = parseMemoryToolInput(listMemoriesInputSchema, input);
    const runtimeContext = await memoryRuntimeContext(context);
    const limit = boundedLimit(parsedInput.limit, DEFAULT_RESULT_LIMIT);
    const memories = parsedInput.archived
      ? (await listViewerMemories(context.db, { archived: true, limit }))
          .memories
      : await memoryStore(context, runtimeContext).listMemories({ limit });
    return memoryToolResult("listMemories", {
      memories: memories.map(compactMemory),
    });
  },
});
