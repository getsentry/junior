import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Location } from "@/chat/conversations/location";
import { commitAcceptedReply } from "@/chat/conversations/projection";
import type { ProviderConversationReference } from "@/chat/conversations/sql/bindings";
import { logException } from "@/chat/logging";
import {
  markConversationMessage,
  recordDeliveredAssistantMessage,
} from "@/chat/services/conversation-memory";
import { persistWithRetry } from "@/chat/services/persist-retry";
import type { ThreadConversationState } from "@/chat/state/conversation";

/** Facts returned after provider Delivery. */
export type DeliveryResult = {
  providerMessageId?: string;
  providerConversationBindings?: ProviderConversationReference[];
};

/**
 * Deliver one Message through the provider that owns its Location.
 *
 * TODO(dcramer): Delete DeliveryResult and DeliverMessage after the core Turn
 * lifecycle stores completed assistant Messages and the mailbox worker can
 * accept provider Delivery directly.
 */
export type DeliverMessage = (input: {
  conversationId: string;
  location: Location;
  text: string;
}) => Promise<DeliveryResult>;

/** Store one assistant Message and its Agent history. */
export async function commitAssistantMessage(args: {
  agentMessage?: AssistantMessage;
  conversation: ThreadConversationState;
  conversationId: string;
  deliveryResult?: DeliveryResult;
  sessionId: string;
  source?: "slack" | "web";
  text: string;
  userMessageId: string;
}): Promise<void> {
  const conversationMessageId = recordDeliveredAssistantMessage({
    conversation: args.conversation,
    sessionId: args.sessionId,
    source: args.source,
    text: args.text,
    userMessageId: args.userMessageId,
  });
  if (args.deliveryResult?.providerMessageId) {
    // TODO(dcramer): Remove this Slack-only branch after Message update can
    // store a provider Message ID.
    markConversationMessage(args.conversation, conversationMessageId, {
      slackTs: args.deliveryResult.providerMessageId,
    });
  }
  try {
    await persistWithRetry(() =>
      commitAcceptedReply({
        ...(args.agentMessage
          ? { agentMessage: args.agentMessage }
          : undefined),
        conversation: args.conversation,
        conversationMessageId,
        conversationId: args.conversationId,
        providerConversationBindings:
          args.deliveryResult?.providerConversationBindings,
      }),
    );
  } catch (error) {
    logException(
      new Error("Assistant message persistence failed"),
      "conversation.assistant.message_persist.failed",
      {
        "error.type": error instanceof Error ? error.name : typeof error,
      },
    );
  }
}
