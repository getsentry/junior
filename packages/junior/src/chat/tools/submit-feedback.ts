import * as z from "zod";
import { getDashboardConversationLink } from "@/chat/dashboard-link";
import * as Sentry from "@/chat/sentry";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import type { ToolRuntimeContext } from "@/chat/tools/types";

// Filler that agents send instead of a real report, compared after
// lowercasing and dropping everything but letters and digits.
const PLACEHOLDER_DESCRIPTIONS = new Set([
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
  return PLACEHOLDER_DESCRIPTIONS.has(
    text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ""),
  );
}

const submitFeedbackInputSchema = z.object({
  task: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe("A short phrase that names the work you were asked to do."),
  kind: z
    .enum(["broken", "slow", "missing", "confusing"])
    .describe(
      "broken: a tool failed or returned wrong data; slow: a tool or the Sandbox timed out or took too long; missing: no tool could do it; confusing: a tool or its result was unclear.",
    ),
  impact: z
    .enum(["blocked", "worked_around", "friction"])
    .describe(
      "blocked: you could not finish; worked_around: you finished another way; friction: you finished, but it was harder than it should be.",
    ),
  description: z
    .string()
    .trim()
    .min(1)
    // With the other fields, this keeps the message under the 4096 code
    // points that Sentry accepts for User Feedback.
    .max(2000)
    .describe(
      "What you tried, the tool calls, and the error or delay. Do not quote message text, file contents, secrets, or personal data.",
    ),
  tool_name: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .nullable()
    .optional()
    .describe(
      "The tool that the feedback is about. Null is the same as omitted.",
    ),
});

const submitFeedbackOutputSchema = juniorToolOutputSchema.extend({
  feedback_id: z.string().describe("Id of the feedback sent to maintainers."),
});

/**
 * Send the agent's report of a tool or runtime problem to the maintainers as
 * Sentry user feedback, next to the dashboard Reply ratings. It sends at most
 * one report for each tool registry, so a failure loop cannot flood it.
 */
export function createSubmitFeedbackTool(
  context: Pick<ToolRuntimeContext, "conversationId" | "conversationPrivacy">,
) {
  let sent = false;
  return zodTool({
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
    execute: async (input) => {
      if (sent) {
        throw new ToolInputError(
          "Feedback was already sent in this Run. Continue the work.",
        );
      }
      if (isPlaceholder(input.description)) {
        throw new ToolInputError(
          "The description is a placeholder. Describe what you tried and what went wrong, or do not send feedback.",
        );
      }
      const toolName = input.tool_name ?? undefined;
      const message = [
        `Task: ${input.task}`,
        ...(toolName ? [`Tool: ${toolName}`] : []),
        "",
        input.description,
      ].join("\n");
      const feedbackId = Sentry.captureFeedback({
        message,
        name: "Junior agent",
        source: "junior_agent",
        tags: {
          "app.feedback.impact": input.impact,
          "app.feedback.kind": input.kind,
          "gen_ai.conversation.id": context.conversationId,
          ...(context.conversationPrivacy
            ? { "app.conversation.privacy": context.conversationPrivacy }
            : undefined),
          ...(toolName ? { "gen_ai.tool.name": toolName } : undefined),
        },
        url: getDashboardConversationLink(context.conversationId),
      });
      sent = true;
      return { feedback_id: feedbackId };
    },
  });
}
