import { z } from "zod";
import { juniorToolResultSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";

export const HANDOFF_TOOL_NAME = "handoff";

const handoffResultSchema = juniorToolResultSchema.extend({
  model_profile: z.literal("advanced"),
});

/** Create the terminal standard-agent control for an in-place model upgrade. */
export function createHandoffTool(
  handoff: (signal?: AbortSignal) => Promise<void>,
) {
  return zodTool({
    description:
      "Permanently upgrade this conversation to the advanced model, replace prior context with a continuation summary, and continue the same task with the same workspace and all other normal tools. Call it as the only tool in the assistant message when the system tool policy requires a model upgrade.",
    executionMode: "sequential",
    inputSchema: z.object({}).strict(),
    outputSchema: handoffResultSchema,
    execute: async (_input, options) => {
      await handoff(options.signal);
      return {
        ok: true,
        status: "success" as const,
        model_profile: "advanced" as const,
      };
    },
  });
}
