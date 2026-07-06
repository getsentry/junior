import { juniorToolResultSchema } from "@/chat/tool-support/structured-result";
import { z } from "zod";
import { zodTool } from "@/chat/tool-support/zod-tool";
export {
  missingFileResult,
  sliceFileContent,
} from "@/chat/tool-support/text-range-result";

/** Create the sandbox read tool definition exposed to the agent. */
export function createReadFileTool() {
  return zodTool({
    description:
      "Read a bounded line range from a file in the sandbox workspace. Use when you need exact file contents to verify facts or make edits safely. Prefer grep/findFiles/listDir for broad discovery.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: z.object({
      path: z
        .string()
        .min(1)
        .describe("Path to the file in the sandbox workspace."),
      offset: z.coerce
        .number()
        .int()
        .min(1)
        .describe("1-indexed line number to start reading from.")
        .optional(),
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .describe("Maximum number of lines to read. Defaults to 1000.")
        .optional(),
    }),
    outputSchema: juniorToolResultSchema,
    execute: async () => {
      throw new Error(
        "readFile can only run when sandbox execution is enabled.",
      );
    },
  });
}
