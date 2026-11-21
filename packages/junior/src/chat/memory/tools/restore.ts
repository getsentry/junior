import {
  definePluginTool,
  PluginToolInputError,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import { MemoryRestoreConflictError, restoreMemory } from "../restore";
import { MemoryNotFoundError } from "../viewer";
import {
  asToolInputError,
  compactMemory,
  memorySingleOutputSchema,
  memoryToolResult,
  parseMemoryToolInput,
  type MemoryToolContext,
} from "../tool-support";

const restoreMemoryInputSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .describe(
        "Archived memory id or unambiguous short id prefix from listMemories with archived=true.",
      ),
  })
  .strict();

/** Restore a visible archived memory, so recall uses it again. */
export const memoryRestoreTool = definePluginTool({
  annotations: {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
    readOnlyHint: false,
  },
  description:
    "Restore one archived memory, so recall uses it again. Use when the user says a forgotten or retired memory is still true. archiveMemory undoes it.",
  executionMode: "sequential",
  inputSchema: restoreMemoryInputSchema,
  outputSchema: memorySingleOutputSchema,
  execute: async (input, _options, context: MemoryToolContext) => {
    const parsedInput = parseMemoryToolInput(restoreMemoryInputSchema, input);
    const memory = await (async () => {
      try {
        return await restoreMemory(context.db, {
          id: parsedInput.id,
          nowMs: Date.now(),
        });
      } catch (error) {
        if (
          error instanceof MemoryNotFoundError ||
          error instanceof MemoryRestoreConflictError
        ) {
          throw new PluginToolInputError(error.message, { cause: error });
        }
        asToolInputError(error);
      }
    })();
    return memoryToolResult("restoreMemory", {
      memory: compactMemory(memory),
    });
  },
});
