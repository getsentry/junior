import { tool } from "ai";
import { z } from "zod";

export function createFinalAnswerTool() {
  return tool({
    description:
      "Submit the final user-facing markdown answer for this turn. Call this when work is complete.",
    inputSchema: z.object({
      answer: z.string().min(1)
    })
    // Intentionally no execute function.
    // This is a terminal signal tool and its input is read from staticToolCalls.
  });
}
