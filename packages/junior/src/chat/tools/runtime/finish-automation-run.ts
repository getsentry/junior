import { z } from "zod";
import {
  automationResultSchema,
  type AutomationResult,
} from "@/chat/automation-result";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

const finishAutomationRunOutputSchema = juniorToolOutputSchema.extend({
  result: z.enum(["send_message", "no_action", "blocked"]),
  message: z.string().optional(),
  reason: z.string().optional(),
});

const SEND_MESSAGE_DESCRIPTION =
  "End this automation run with exactly one result. This must be the only tool call in its message, and the run ends after it. Use `send_message` with `message` set to the finished deliverable when the instruction calls for a visible result now. The runtime sends that text to the stored destinations, so write the reminder, digest, alert, or answer itself, not a report about the run. Use `no_action` with `reason` when the work is done without a visible result, or when a condition in the instruction is not met or cannot be verified. Use `blocked` with `reason` only for a real problem that the automation owner must fix, such as missing access or a broken instruction. Your final assistant text is never delivered.";

const SILENT_DESCRIPTION =
  "End this automation run with exactly one result. This must be the only tool call in its message, and the run ends after it. This automation has no message outcome, so nothing is posted. Use `no_action` with `reason` when the work is done, or when a condition in the instruction is not met or cannot be verified. Use `blocked` with `reason` only for a real problem that the automation owner must fix, such as missing access or a broken instruction. Your final assistant text is never delivered.";

/** Create the tool that ends one Automation run with a declared result. */
export function createFinishAutomationRunTool(options: {
  sendsMessage: boolean;
}) {
  const results = options.sendsMessage
    ? (["send_message", "no_action", "blocked"] as const)
    : (["no_action", "blocked"] as const);
  return zodTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: false,
    },
    description: options.sendsMessage
      ? SEND_MESSAGE_DESCRIPTION
      : SILENT_DESCRIPTION,
    inputSchema: z.object({
      result: z.enum(results).describe("The result of this run."),
      ...(options.sendsMessage
        ? {
            message: z
              .string()
              .optional()
              .describe(
                "Required for send_message. The exact text to send, in Slack Markdown.",
              ),
          }
        : undefined),
      reason: z
        .string()
        .optional()
        .describe(
          "Required for no_action and blocked. One short sentence for the automation owner.",
        ),
    }),
    outputSchema: finishAutomationRunOutputSchema,
    execute: async (input): Promise<AutomationResult> => {
      const parsed = automationResultSchema.safeParse(input);
      if (!parsed.success) {
        throw new ToolInputError(
          input.result === "send_message"
            ? "send_message requires a non-empty message."
            : `${input.result} requires a non-empty reason.`,
        );
      }
      return parsed.data;
    },
  });
}
