import { z } from "zod";
import { juniorToolResultSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";

/** Create the sandbox full-file write tool definition exposed to the agent. */
export function createWriteFileTool() {
  return zodTool({
    description:
      "Write UTF-8 content to a file in the sandbox workspace. Use for intentional file creation or deliberate full-file replacement after validation; use editFile instead for targeted changes to existing files. Do not use for exploratory analysis-only turns.",
    executionMode: "sequential",
    inputSchema: z.object({
      path: z
        .string()
        .min(1)
        .describe("Path to write in the sandbox workspace."),
      content: z.string().describe("UTF-8 file content to write."),
    }),
    outputSchema: juniorToolResultSchema,
    execute: async () => {
      throw new Error(
        "writeFile can only run when sandbox execution is enabled.",
      );
    },
  });
}
