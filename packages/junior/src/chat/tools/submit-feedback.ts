import * as z from "zod";
import { getDashboardConversationLink } from "@/chat/dashboard-link";
import * as Sentry from "@/chat/sentry";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool, zodToolDefinition } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import type { ToolRuntimeContext } from "@/chat/tools/types";

// Filler that agents send instead of a real report, compared after
// lowercasing and dropping everything but letters and digits.
const PLACEHOLDER_MESSAGES = new Set([
  "",
  "na",
  "none",
  "noop",
  "null",
  "placeholder",
  "tbd",
  "test",
  "todo",
  "undefined",
]);

function isPlaceholder(text: string): boolean {
  return PLACEHOLDER_MESSAGES.has(
    text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ""),
  );
}

const submitFeedbackInputSchema = z.object({
  message: z
    .string()
    .trim()
    .min(1)
    // Sentry accepts at most 4096 code points of User Feedback. 4096 UTF-16
    // units is never more than that.
    .max(4096)
    .describe(
      "What you tried, the tool and its error or delay, and whether you finished. Do not quote message text, file contents, secrets, or personal data.",
    ),
});

const submitFeedbackOutputSchema = juniorToolOutputSchema.extend({
  feedback_id: z.string().describe("Id of the feedback sent to maintainers."),
});

export const submitFeedbackToolDefinition = zodToolDefinition({
  annotations: {
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
    readOnlyHint: false,
  },
  description:
    "Report a problem with your own tools or runtime to the maintainers, not to the user. Use it once when a tool failed, timed out, was too slow, returned wrong data, or was missing, such as a Sandbox that did not start. Skip it when the work went fine, or when the cause is the user's input, access, or a permission they control. Returns the feedback id.",
  inputSchema: submitFeedbackInputSchema,
  outputSchema: submitFeedbackOutputSchema,
});

/**
 * Send the agent's report of a tool or runtime problem to the maintainers as
 * Sentry user feedback, next to the dashboard Reply ratings.
 */
export function createSubmitFeedbackTool(
  context: Pick<ToolRuntimeContext, "conversationId" | "conversationPrivacy">,
) {
  return zodTool({
    ...submitFeedbackToolDefinition,
    execute: async (input) => {
      if (isPlaceholder(input.message)) {
        throw new ToolInputError(
          "The message is a placeholder. Describe what you tried and what went wrong, or do not send feedback.",
        );
      }
      const feedbackId = Sentry.captureFeedback({
        message: input.message,
        name: "Junior agent",
        source: "junior_agent",
        tags: {
          "gen_ai.conversation.id": context.conversationId,
          ...(context.conversationPrivacy
            ? { "app.conversation.privacy": context.conversationPrivacy }
            : undefined),
        },
        url: getDashboardConversationLink(context.conversationId),
      });
      return { feedback_id: feedbackId };
    },
  });
}
