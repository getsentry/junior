import { z } from "zod";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";

/** Create the tool that ends a child agent run as blocked. */
export function createReportBlockedTool() {
  return zodTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: false,
    },
    description:
      "End this delegated task as blocked. Your reply goes to the parent agent, not a person, and a text reply counts as finished work. When missing access, credentials, input, or a decision stops the task, call this instead of a text reply, also when a search for the missing part found nothing. Do not ask a question, guess, mock, or fake results to work around it.",
    inputSchema: z
      .object({
        missing: z
          .string()
          .trim()
          .min(1)
          .describe(
            "What the task needs and who can give it. Add the work you already did, so the parent does not repeat it.",
          ),
      })
      .strict(),
    outputSchema: juniorToolOutputSchema.extend({ missing: z.string() }),
    execute: async (input) => ({ missing: input.missing }),
  });
}
