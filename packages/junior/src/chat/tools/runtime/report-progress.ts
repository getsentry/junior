import { Type } from "@sinclair/typebox";
import { tool } from "@/chat/tools/definition";

/** Create the internal tool the model uses for sparse progress updates. */
export function createReportProgressTool() {
  return tool({
    description:
      "Update the user-visible assistant loading message with a short progress phase. For every non-trivial turn, call this early with the initial major work phase, then call it again only when the major phase meaningfully changes. Write the message as a proper sentence fragment: capitalize the first letter and use a present-participle verb (e.g. 'Searching docs', 'Reviewing results', 'Running checks'). Never emit lowercase status text like 'searching docs'. Skip trivial direct answers, generic filler, and minor substeps.",
    inputSchema: Type.Object({
      message: Type.String({
        minLength: 1,
        description:
          "Short user-facing progress message written as a proper sentence fragment with a capitalized first letter and a present-participle verb (e.g. 'Researching foo bar', not 'researching foo bar'). The UI truncates it if needed.",
      }),
    }),
  });
}
