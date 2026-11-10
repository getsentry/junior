import * as z from "zod";
import { ROOT_TURN_TOOLS } from "@/chat/conversations/kind-behavior";
import { updateConversationSubscription } from "@/api/conversations/subscription";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import type { ToolRegistry } from "@/chat/tools/definition";
import type { ToolRuntimeContext } from "@/chat/tools/types";

const CONVERSATION_SUBSCRIPTION_TOOL_SOURCE = {
  id: "conversation-subscription",
  description:
    "Subscribe or unsubscribe the current user from this conversation's feed.",
} as const;

/**
 * Build the tool that changes the subscription of the person who started
 * the Turn, in the current Conversation. The actor comes from the runtime,
 * not from model arguments, so it cannot change another person's
 * subscription. An Agent invocation never gets it, because an agent wrote
 * its input. Contract: `api/conversations/subscription.ts`.
 */
export function createConversationSubscriptionTools(
  context: ToolRuntimeContext,
): ToolRegistry {
  if (!(context.turnTools ?? ROOT_TURN_TOOLS).subscriptions) return {};

  return {
    setConversationSubscription: zodTool({
      exposure: "deferred",
      source: CONVERSATION_SUBSCRIPTION_TOOL_SOURCE,
      executionMode: "sequential",
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: false,
      },
      description:
        "Subscribe the current user to this conversation, or unsubscribe them. Unsubscribe removes it only from their feed and clears their pin. When nobody else is subscribed, it archives the conversation for everyone. Their next mention here subscribes them again.",
      inputSchema: z
        .object({
          subscribed: z
            .boolean()
            .describe("False unsubscribes the current user."),
        })
        .strict(),
      outputSchema: juniorToolOutputSchema.extend({
        archived_at: z
          .string()
          .nullable()
          .describe("Set when the conversation is archived for everyone."),
        subscribed: z.boolean(),
      }),
      async execute(input) {
        const user = (await context.resolveActorIdentity?.())?.user;
        if (!user) {
          throw new ToolInputError(
            "This person has no linked Junior user, so their subscription cannot change.",
          );
        }
        const result = await updateConversationSubscription(
          user,
          context.conversationId,
          input.subscribed,
        );
        if (!result) {
          throw new ToolInputError(
            "This person is not a participant of this conversation.",
          );
        }
        return {
          archived_at: result.archivedAt,
          subscribed: result.subscribed,
        };
      },
    }),
  };
}
