import type { SlackAdapter } from "@chat-adapter/slack";
import type { StateAdapter } from "chat";
import type { DeliverMessage } from "@/chat/task-execution/assistant-message";
import { RetryableDeliveryError } from "@/chat/agent/types";
import { getLocationConfigurationService } from "@/chat/runtime/thread-state";
import { runWithSlackInstallation } from "@/chat/slack/adapter-context";
import { isRetryableSlackPostError } from "@/chat/slack/errors";
import type { MessageCard } from "@/chat/conversations/cards";
import { sendSlackReply } from "@/chat/slack/reply";

/** A Slack channel, or a thread in it, that system Turn output goes to. */
export type SlackSystemReplyTarget = {
  teamId: string;
  channelId: string;
  threadTs?: string | undefined;
};

/**
 * Posts system Turn output to a Slack channel or thread without a webhook
 * Message. Returns the ids of the posted messages, and throws
 * `RetryableDeliveryError` when a later try can work.
 */
export async function postSlackSystemReply(
  args: {
    getSlackAdapter: () => SlackAdapter;
    state?: StateAdapter | undefined;
  },
  reply: {
    conversationId: string;
    target: SlackSystemReplyTarget;
    text: string;
    cards?: MessageCard[] | undefined;
  },
): Promise<string[]> {
  const { teamId, channelId, threadTs } = reply.target;
  try {
    return await runWithSlackInstallation({
      adapter: args.getSlackAdapter(),
      installation: { teamId },
      state: args.state,
      task: async () =>
        await sendSlackReply({
          channelId,
          ...(threadTs ? { threadTs } : undefined),
          cards: reply.cards,
          conversationId: reply.conversationId,
          // Plugin formatting reads the Location defaults, as Slack Turns do.
          formatting: {
            configuration: await getLocationConfigurationService({
              platform: "slack",
              teamId,
              channelId,
            }).resolveValues(),
            teamId,
          },
          text: reply.text,
        }),
    });
  } catch (error) {
    if (isRetryableSlackPostError(error)) {
      throw new RetryableDeliveryError(error);
    }
    throw error;
  }
}

/**
 * Deliver system Turn output to Slack without a webhook Message.
 *
 * TODO(dcramer): Replace this Location-taking function with Delivery bound to one
 * Location after Event work supplies Delivery before the Run.
 */
export function createSlackSystemTurnDelivery(args: {
  getSlackAdapter: () => SlackAdapter;
  state?: StateAdapter | undefined;
}): DeliverMessage {
  return async ({ conversationId, location, text, cards }) => {
    if (location.provider !== "slack") {
      throw new Error(
        `Slack system Turn cannot deliver to ${String(location.provider)} Location`,
      );
    }
    const messageIds = await postSlackSystemReply(args, {
      cards,
      conversationId,
      target: {
        teamId: location.teamId,
        channelId: location.channelId,
        threadTs: location.threadTs,
      },
      text,
    });
    const providerMessageId = messageIds.at(-1);
    const providerConversationId = location.threadTs ?? messageIds[0];
    return {
      ...(providerMessageId ? { providerMessageId } : undefined),
      ...(providerConversationId
        ? {
            providerConversationBindings: [
              {
                provider: "slack",
                providerDestinationId: location.channelId,
                providerTenantId: location.teamId,
                providerConversationId,
              },
            ],
          }
        : undefined),
    };
  };
}
