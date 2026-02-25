import { tool } from "@/chat/tools/definition";
import { z } from "zod";

export function createBashTool() {
  return tool({
    description:
      "Run a bash command inside the isolated sandbox workspace. Use this to inspect skill files and execute repository-safe shell tasks.",
    inputSchema: z.object({
      command: z
        .string()
        .min(1)
        .describe("Bash command to run inside the sandbox."),
      timeout_ms: z
        .number()
        .int()
        .min(100)
        .max(300000)
        .optional()
        .describe("Optional command timeout in milliseconds."),
      max_output_chars: z
        .number()
        .int()
        .min(200)
        .max(200000)
        .optional()
        .describe("Maximum characters retained for stdout/stderr.")
    }),
    execute: async () => {
      throw new Error("bash can only run when sandbox execution is enabled.");
    }
  });
}
