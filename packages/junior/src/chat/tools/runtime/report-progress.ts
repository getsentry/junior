import { Type } from "@sinclair/typebox";
import { tool } from "@/chat/tools/definition";

/** Create the internal tool the model uses for sparse progress updates. */
export function createReportProgressTool() {
  return tool({
    description:
      "Update assistant status with a short user-facing progress message. Use this sparingly for meaningful progress changes, not for every tool call or minor substep.",
    inputSchema: Type.Object({
      message: Type.String({
        minLength: 1,
        description:
          "Short user-facing progress message. The UI truncates it if needed.",
      }),
    }),
  });
}
