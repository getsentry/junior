import * as z from "zod";
import {
  leadStartedAgentSchema,
  startedAgentTitleSchema,
} from "@/chat/agent-invocations/started-agent";
import { conversationWatch } from "@/chat/conversations/watch-events";
import { getDashboardConversationLink } from "@/chat/dashboard-link";
import { startLeadConversation } from "@/chat/lead/start-conversation";
import { getVercelConversationWorkQueue } from "@/chat/task-execution/vercel-queue";
import { ToolInputError } from "@/chat/tool-support/tool-input-error";
import type { ToolRuntimeContext } from "@/chat/tool-support/types";
import { zodTool, zodToolDefinition } from "@/chat/tool-support/zod-tool";

// A Lead starts a root that runs as its person. Only the brief and the
// title can work there.
const leadInputSchema = z
  .object({
    task: z
      .string()
      .trim()
      .min(1)
      .describe(
        "Self-contained brief for a peer who has not seen this conversation: the goal, the targets, the facts you know, the constraints, and what done means.",
      ),
    title: startedAgentTitleSchema.describe(
      "Short display title of the new conversation.",
    ),
  })
  .strict();

/**
 * Static definition of `startAgent` in a Lead Turn. The child-agent
 * arguments cannot work there, so the model does not see them.
 */
export const leadStartAgentToolDefinition = zodToolDefinition({
  description:
    "Start a new conversation that does one piece of the person's work. It is a public conversation of the person, on your team, and it starts at once. Your task is its first message, and it runs as the person, so write the task as the person's request. Use messageAgent instead for work that a conversation already does.",
  exposure: "modelOnly",
  // The start is not reviewed. The new root runs as the person, and action
  // review judges its own tool calls.
  approvalMode: "auto",
  annotations: {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
    readOnlyHint: false,
  },
  inputSchema: leadInputSchema,
  outputSchema: leadStartedAgentSchema,
});

/** Create the `startAgent` tool that starts public roots of a Lead's person. */
export function createLeadStartAgentTool(
  context: Pick<
    ToolRuntimeContext,
    "conversationId" | "conversationWorkQueue" | "turnId"
  >,
) {
  return zodTool({
    ...leadStartAgentToolDefinition,
    execute: async (input, options) => {
      if (!options.toolCallId || !context.turnId) {
        throw new ToolInputError(
          "startAgent requires an active Turn and tool call ID. No change to the call can fix this.",
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
      const url = getDashboardConversationLink(conversationId);
      return {
        conversation_id: conversationId,
        ...(url ? { url } : undefined),
        subscribable: conversationWatch({
          conversationId,
          title: input.title,
        }),
      };
    },
  });
}
