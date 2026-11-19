import { subscribableResourceSchema } from "@sentry/junior-plugin-api";
import * as z from "zod";
import { conversationWatch } from "@/chat/conversations/watch-events";
import { getDashboardConversationLink } from "@/chat/dashboard-link";
import { startLeadConversation } from "@/chat/lead/start-conversation";
import { SHORT_TITLE_MAX_LENGTH } from "@/chat/services/short-title";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool, zodToolDefinition } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import type { ToolRuntimeContext } from "@/chat/tools/types";
import { getVercelConversationWorkQueue } from "@/chat/task-execution/vercel-queue";

/** Static definition of `startConversation`, which only a Lead lists. */
export const startConversationToolDefinition = zodToolDefinition({
  description: [
    "Start a new conversation that does one piece of the person's work. It is a public conversation of the person, and it starts at once.",
    "Your task is its first message, and it runs as the person, so write the task as the person's request.",
    "Use messageAgent instead for work that a conversation already does.",
  ].join(" "),
  exposure: "modelOnly",
  // The task becomes the person's request in the new conversation, so action
  // review judges every start.
  approvalMode: "review",
  annotations: {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
    readOnlyHint: false,
  },
  inputSchema: z
    .object({
      task: z
        .string()
        .trim()
        .min(1)
        .describe(
          "Self-contained brief for a peer who has not seen this conversation: the goal, the targets, the facts you know, the constraints, and what done means.",
        ),
      title: z
        .string()
        .trim()
        .min(1)
        .max(SHORT_TITLE_MAX_LENGTH)
        .describe("Short display title of the new conversation."),
    })
    .strict(),
  outputSchema: juniorToolOutputSchema.extend({
    conversation_id: z
      .string()
      .min(1)
      .describe(
        "ID of the new conversation. Pass it to messageAgent to steer it.",
      ),
    dashboard_url: z
      .string()
      .url()
      .optional()
      .describe("Dashboard link of the new conversation."),
    subscribable: subscribableResourceSchema.describe(
      "Watch it with watchEvents only when the person asks to hear back.",
    ),
  }),
});

/** Create the tool that starts a Conversation from a Lead Turn. */
export function createStartConversationTool(
  context: Pick<
    ToolRuntimeContext,
    "conversationId" | "conversationWorkQueue" | "turnId"
  >,
) {
  return zodTool({
    ...startConversationToolDefinition,
    execute: async (input, options) => {
      if (!options.toolCallId || !context.turnId) {
        throw new ToolInputError(
          "startConversation requires an active Turn and tool call ID",
        );
      }
      const { conversationId } = await startLeadConversation({
        leadConversationId: context.conversationId,
        messageKey: `${context.turnId}:${options.toolCallId}`,
        queue:
          context.conversationWorkQueue ?? getVercelConversationWorkQueue(),
        task: input.task,
        title: input.title,
      });
      const dashboardUrl = getDashboardConversationLink(conversationId);
      return {
        conversation_id: conversationId,
        ...(dashboardUrl ? { dashboard_url: dashboardUrl } : undefined),
        subscribable: conversationWatch({ conversationId, title: input.title }),
      };
    },
  });
}
