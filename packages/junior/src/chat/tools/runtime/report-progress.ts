import { Type } from "@sinclair/typebox";
import { tool } from "@/chat/tools/definition";

/** Create the internal tool the model uses for sparse progress updates. */
export function createReportProgressTool() {
  return tool({
    description:
      "Update the user-visible assistant loading message with a short progress phase. For every non-trivial turn, call this early with the initial major work phase, then call it again only when the major phase meaningfully changes. Use concrete labels like Searching docs, Reviewing results, or Running checks. Skip trivial direct answers, generic filler, and minor substeps.",
    inputSchema: Type.Object({
      message: Type.String({
        minLength: 1,
        description:
          "Short user-facing progress message. The UI truncates it if needed.",
      }),
    }),
  });
}
