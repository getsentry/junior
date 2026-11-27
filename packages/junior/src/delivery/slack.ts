// The Slack sender of core Turn replies. It posts a reply to its Slack
// Destination as main's system Turns do: one installation per workspace,
// plugin formatting from the Location defaults, and long text split into
// more posts.
import type { SlackAdapter } from "@chat-adapter/slack";
import type { SlackDestination } from "@sentry/junior-plugin-api";
import { getLocationConfigurationService } from "@/chat/runtime/thread-state";
import { runWithSlackInstallation } from "@/chat/slack/adapter-context";
import { isRetryableSlackPostError } from "@/chat/slack/errors";
import { sendSlackReply } from "@/chat/slack/reply";
import { DeliveryRetryableError } from "@/delivery/deliver";

/**
 * Creates the sender of replies to Slack Destinations. A Slack failure that a
 * later try can fix throws `DeliveryRetryableError`.
 */
export function createSlackSender(args: {
  getSlackAdapter: () => SlackAdapter;
}) {
  return async (reply: {
    conversationId: string;
    destination: SlackDestination;
    text: string;
  }): Promise<{ providerMessageId?: string }> => {
    const { channelId, teamId, threadTs } = reply.destination;
    let messageIds: string[];
    try {
      messageIds = await runWithSlackInstallation({
        adapter: args.getSlackAdapter(),
        installation: { teamId },
        task: async () =>
          sendSlackReply({
            channelId,
            threadTs,
            conversationId: reply.conversationId,
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
        throw new DeliveryRetryableError("Slack did not take the reply", {
          cause: error,
        });
      }
      throw error;
    }
    const providerMessageId = messageIds.at(-1);
    return providerMessageId ? { providerMessageId } : {};
  };
}
