import { z } from "zod";
import { automationResultSchema } from "@/chat/automation-result";
import { isNoReplyMarker } from "@/chat/no-reply";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

const RESULT_GUIDANCE = [
  "Use `no_action` when the run worked and nothing should be posted, such as when a condition in the instruction is not met, or when a temporary failure stopped the work.",
  "Use `misconfigured` when the run cannot do its job until its creator changes the automation: a provider, tool, account, or access that the job needs is missing, a target no longer exists, or the instruction cannot be done. Do not use it for a temporary failure or a condition that is not met.",
].join(" ");

// TODO(dcramer): Make the declared result the output format of the run when
// the agent loop can require a response schema for the final message. The
// tool, its exclusive-call rule, the stop after it, and the reminder for a
// missing result can then go.
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
      // A message that is only the old no-reply marker posts nothing.
      return parsed.data.result === "send_message" &&
        isNoReplyMarker(parsed.data.message)
        ? {
            result: "no_action" as const,
            reason: "The message was the no-reply marker.",
          }
        : parsed.data;
    },
  });
}
