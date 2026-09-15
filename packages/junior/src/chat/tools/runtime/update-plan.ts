import { z } from "zod";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";

const planItemSchema = z
  .object({
    step: z.string().trim().min(1).max(200).describe("Task step text."),
    status: z
      .enum(["pending", "in_progress", "completed"])
      .describe("Current step status."),
  })
  .strict();

const updatePlanInputSchema = z
  .object({
    explanation: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .optional()
      .describe("Why the plan changed, when the change is not obvious."),
    plan: z
      .array(planItemSchema)
      .min(1)
      .max(20)
      .describe(
        "Complete ordered task plan. Each call replaces the prior plan.",
      ),
  })
  .strict()
  .superRefine((input, context) => {
    const activeSteps = input.plan.filter(
      (item) => item.status === "in_progress",
    );
    if (activeSteps.length > 1) {
      context.addIssue({
        code: "custom",
        message: "At most one plan step can be in_progress.",
        path: ["plan"],
      });
    }
  });

/** Create the internal tool the model uses to replace its task plan. */
export function createUpdatePlanTool() {
  return zodTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: false,
    },
    description:
      "Replace the current task plan. Provide the complete ordered list on every call. Keep at most one step in_progress. Complete the active step before starting the next one, and explain material changes to the plan.",
    inputSchema: updatePlanInputSchema,
    outputSchema: juniorToolOutputSchema,
    execute: async () => ({}),
  });
}
