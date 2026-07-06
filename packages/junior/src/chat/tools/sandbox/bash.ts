import { z } from "zod";
import { zodTool } from "@/chat/tool-support/zod-tool";

/** Create the sandbox shell tool definition exposed to the agent. */
export function createBashTool() {
  return zodTool({
    description:
      "Run a bash command inside the isolated sandbox workspace. Use this for repository inspection/execution tasks that need shell access. Do not use for network-sensitive or destructive actions unless explicitly required.",
    inputSchema: z.object({
      command: z
        .string()
        .min(1)
        .describe("Bash command to run inside the sandbox."),
      timeoutMs: z.coerce
        .number()
        .int()
        .min(1000)
        .describe(
          "Optional command timeout in milliseconds. Use for commands that may hang.",
        )
        .optional(),
    }),
    // Bash is sequential so sandbox egress auth signals stay command-scoped.
    executionMode: "sequential",
    execute: async () => {
      throw new Error("bash can only run when sandbox execution is enabled.");
    },
  });
}
