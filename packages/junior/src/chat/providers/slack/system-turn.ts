import type { SlackAdapter } from "@chat-adapter/slack";
import type { StateAdapter } from "chat";
import type { DeliverMessage } from "@/chat/task-execution/assistant-message";
import { RetryableDeliveryError } from "@/chat/agent/types";
import { runWithSlackInstallation } from "@/chat/slack/adapter-context";
import { isRetryableSlackPostError } from "@/chat/slack/errors";
import { sendSlackReply } from "@/chat/slack/reply";

/**
 * Deliver system Turn output to Slack without a webhook Message.
 *
 * TODO(dcramer): Replace this Location-taking function with Delivery bound to one
 * Location after Resource event work supplies Delivery before the Run.
 */
export function createSlackSystemTurnDelivery(args: {
  getSlackAdapter: () => SlackAdapter;
  state?: StateAdapter;
}): DeliverMessage {
  return async ({ conversationId, location, text }) => {
    if (location.provider !== "slack") {
      throw new Error(
        `Slack system Turn cannot deliver to ${location.provider} Location`,
      );
    }
    let messageIds: string[];
    try {
      messageIds = await runWithSlackInstallation({
        adapter: args.getSlackAdapter(),
        installation: { teamId: location.teamId },
        state: args.state,
        task: async () =>
          await sendSlackReply({
            channelId: location.channelId,
            conversationId,
            text,
            ...(location.threadTs
              ? { threadTs: location.threadTs }
              : undefined),
          }),
      });
    } catch (error) {
      if (isRetryableSlackPostError(error)) {
        throw new RetryableDeliveryError(error);
      }
      throw error;
    }
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
