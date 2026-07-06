import { z } from "zod";
import { juniorToolResultSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";

/** Create the internal tool the model uses for sparse progress updates. */
export function createReportProgressTool() {
  return zodTool({
    description:
      "Update the user-visible assistant loading message with a short progress phase. For every non-trivial turn, call this early with the initial major work phase, then call it again only when the major phase meaningfully changes. Messages must be written in sentence case with a present-participle verb (e.g. 'Searching docs', 'Reviewing results', 'Running checks'). Skip trivial direct answers, generic filler, and minor substeps.",
    inputSchema: z.object({
      message: z
        .string()
        .min(1)
        .describe("Short user-facing progress message."),
    }),
    outputSchema: juniorToolResultSchema,
    execute: async () => ({
      ok: true,
      status: "success" as const,
    }),
  });
}
