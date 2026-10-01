import { z } from "zod";
import { zodTool } from "@/chat/tool-support/zod-tool";

const planItemSchema = z
  .object({
    step: z.string().describe("Task step text."),
    status: z
      .enum(["pending", "in_progress", "completed"])
      .describe("Step status."),
  })
  .strict();

const updatePlanInputSchema = z
  .object({
    explanation: z
      .string()
      .optional()
      .describe("Optional explanation for this plan update."),
    plan: z.array(planItemSchema).describe("The list of steps"),
  })
  .strict();

/** Create the internal tool the model uses to replace its task plan. */
export function createUpdatePlanTool() {
  return zodTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: false,
    },
    description: [
      "Updates the task plan.",
      "Provide an optional explanation and a list of plan items, each with a step and status.",
      "At most one step can be in_progress at a time. Mark finished steps completed and mark all steps completed when the work is done.",
    ].join("\n"),
    inputSchema: updatePlanInputSchema,
    execute: async () => ({
      content: [{ type: "text" as const, text: "Plan updated" }],
    }),
  });
}
