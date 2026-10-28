import type { User } from "@sentry/junior-plugin-api";
import { getProductionSlackAdapter } from "@/chat/app/production";
import { stopConversationTurn } from "@/chat/conversations/stop";
import { webActorFromEmail } from "@/chat/conversations/web-input";
import { legacyWebMailboxMetadataSchema } from "@/chat/conversations/web-mailbox";
import { getConversationStore, getDb } from "@/chat/db";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { clearSlackPendingReactions } from "@/chat/task-execution/slack-work";
import type { InboundMessage } from "@/chat/task-execution/store";
import { throwApiError } from "../http";
import type { StopConversationTurnResponse } from "../schema/conversation-stop";
import { readConversationAccessFromSql } from "./access";

/**
 * Stop the active Turn for one conversation participant.
 *
 * The stop also removes the human messages queued before it. The viewer's own
 * web text comes back in the response so the dashboard can restore it to the
 * composer instead of losing it.
 */
export async function stopConversationTurnForViewer(
  viewer: User,
  conversationId: string,
  services: { queue: ConversationWorkQueue },
): Promise<StopConversationTurnResponse> {
  const conversationStore = getConversationStore();
  const conversation = await conversationStore.get({ conversationId });
  if (!conversation) {
    throwApiError(404, "Conversation not found.");
  }

  const access = await readConversationAccessFromSql(
    getDb(),
    [conversationId],
    viewer,
  );
  if (!access.get(conversationId)?.isParticipant) {
    throwApiError(403, "Only conversation participants can stop this turn.");
  }

  try {
    const result = await stopConversationTurn({
      conversationId,
      conversationStore,
      queue: services.queue,
    });
    if (result.status === "no_work") {
      return {
        conversationId,
        status: "no_work",
        stoppedInboundMessageIds: [],
        stoppedMessages: [],
      };
    }
    await clearSlackPendingReactions({
      getSlackAdapter: getProductionSlackAdapter,
      messages: result.pendingMessages,
    });
    return {
      conversationId,
      status: "requested",
      stoppedInboundMessageIds: result.pendingMessages.map(
        (message) => message.inboundMessageId,
      ),
      stoppedMessages: viewerWebMessages(result.pendingMessages, viewer),
    };
  } catch (error) {
    throwApiError(500, "Unable to stop the active turn.", error);
  }
}

function viewerWebMessages(
  messages: readonly InboundMessage[],
  viewer: User,
): StopConversationTurnResponse["stoppedMessages"] {
  const viewerUserId = webActorFromEmail(viewer.email).userId;
  return messages.flatMap((message) => {
    if (message.source !== "web") return [];
    const metadata = legacyWebMailboxMetadataSchema.safeParse(
      message.input.metadata,
    );
    if (!metadata.success) return [];
    if (metadata.data.authorUserId !== viewerUserId) return [];
    const text = message.input.text.trim();
    return text ? [{ inboundMessageId: message.inboundMessageId, text }] : [];
  });
}
