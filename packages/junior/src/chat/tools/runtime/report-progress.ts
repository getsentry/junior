import { z } from "zod";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";

/** Create the internal tool the model uses for sparse progress updates. */
export function createReportProgressTool() {
  return zodTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: false,
    },
    description:
      "Update the user-visible assistant loading message during a materially long wait that the task plan does not already express. Skip short waits, routine commands, generic filler, and minor substeps. Messages must use sentence case and a present-participle verb (for example, 'Waiting for checks').",
    inputSchema: z.object({
      message: z
        .string()
        .min(1)
        .describe("Short user-facing progress message."),
    }),
    outputSchema: juniorToolOutputSchema,
    execute: async () => ({}),
  });
}
