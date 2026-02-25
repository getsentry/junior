import { tool } from "@/chat/tools/definition";
import { z } from "zod";

export function createFinalAnswerTool() {
  return tool({
    description:
      "Submit the final user-facing markdown answer for this turn. Call this when work is complete.",
    inputSchema: z.object({
      answer: z
        .string()
        .min(1)
        .describe("Final user-facing Slack markdown reply for this turn.")
    })
    // Intentionally no execute function.
    // This is a terminal signal tool and its input is read from staticToolCalls.
  });
}
