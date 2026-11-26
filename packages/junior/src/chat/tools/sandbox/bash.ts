import * as z from "zod";
import {
  hasLongSleep,
  LONG_SLEEP_MESSAGE,
} from "@/chat/tool-support/sandbox/long-sleep";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool, zodToolDefinition } from "@/chat/tool-support/zod-tool";

export const bashToolDefinition = zodToolDefinition({
  annotations: {
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
    readOnlyHint: false,
  },
  // Guardian reviews every command: `auto` reviews each call that is not
  // marked read-only and not destructive.
  approvalMode: "auto",
  description:
    "Run a bash command inside the isolated sandbox workspace. Use this for repository inspection/execution tasks that need shell access. Do not use for network-sensitive or destructive actions unless explicitly required.",
  inputSchema: z.object({
    command: z
      .string()
      .min(1)
      .refine((command) => !hasLongSleep(command), LONG_SLEEP_MESSAGE)
      .describe("Bash command to run inside the sandbox."),
    cwd: z
      .string()
      .min(1)
      .describe("Optional working directory for this command only.")
      .optional(),
    timeout_ms: z.coerce
      .number()
      .int()
      .min(1000)
      .describe(
        "Optional command timeout in milliseconds. Use for commands that may hang.",
      )
      .optional(),
  }),
  outputSchema: juniorToolOutputSchema,
  // Egress auth signals are per egress session. The sandbox runs one bash
  // command at a time so each command reads only its own signals.
  executionMode: "sequential",
});

/** Create the sandbox shell tool definition exposed to the agent. */
export function createBashTool() {
  return zodTool({
    ...bashToolDefinition,
    execute: async () => {
      throw new Error("bash can only run when sandbox execution is enabled.");
    },
  });
}
