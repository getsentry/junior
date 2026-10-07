import { z } from "zod";
import {
  automationResultSchema,
  normalizeAutomationResult,
} from "@/chat/automation-result";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

const RESULT_GUIDANCE = [
  "Use `no_action` when nothing should be posted, including when a condition in the instruction is not met or cannot be verified.",
  "Use `misconfigured` only when the automation cannot work until its creator changes it, such as a missing account or access, a target that no longer exists, or an instruction that cannot be done. This suspends the automation. Do not use it for a temporary failure or a condition that is not met.",
].join(" ");

/** Create the tool that ends one Automation run with a declared result. */
export function createFinishAutomationRunTool(options: {
  sendsMessage: boolean;
}) {
  const results = options.sendsMessage
    ? (["send_message", "no_action", "misconfigured"] as const)
    : (["no_action", "misconfigured"] as const);
  return zodTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: false,
    },
    description: options.sendsMessage
      ? `End this automation run. Use \`send_message\` with the finished reminder, digest, alert, or answer; the runtime posts it to the stored destinations. ${RESULT_GUIDANCE}`
      : `End this automation run. This automation posts nothing. ${RESULT_GUIDANCE}`,
    inputSchema: z.object({
      result: z.enum(results),
      ...(options.sendsMessage
        ? {
            message: z
              .string()
              .optional()
              .describe("Required for send_message. The text to post."),
          }
        : undefined),
      reason: z
        .string()
        .optional()
        .describe(
          "Required for no_action and misconfigured. One sentence for the creator.",
        ),
    }),
    outputSchema: juniorToolOutputSchema.extend({
      result: z.enum(["send_message", "no_action", "misconfigured"]),
    }),
    execute: async (input) => {
      const parsed = automationResultSchema.safeParse(input);
      if (!parsed.success) {
        throw new ToolInputError(
          input.result === "send_message"
            ? "send_message requires a non-empty message."
            : `${input.result} requires a non-empty reason.`,
        );
      }
      return normalizeAutomationResult(parsed.data);
    },
  });
}
