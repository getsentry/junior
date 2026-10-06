import { z } from "zod";
import { automationResultSchema } from "@/chat/automation-result";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

const RESULT_GUIDANCE = [
  "Use `no_action` when nothing should be posted, including when a condition in the instruction is not met or cannot be verified.",
  "Use `blocked` only for a problem the automation creator must fix, such as missing access or an instruction that cannot work.",
].join(" ");

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
          "Required for no_action and blocked. One sentence for the creator.",
        ),
    }),
    outputSchema: juniorToolOutputSchema.extend({
      result: z.enum(["send_message", "no_action", "blocked"]),
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
      return parsed.data;
    },
  });
}
