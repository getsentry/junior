import type { User } from "@sentry/junior-plugin-api";
import { webActorFromEmail } from "@/chat/conversations/web-input";
import { getConversationStore, getDb } from "@/chat/db";
import { steerWebPendingMessages } from "@/chat/task-execution/store";
import { throwApiError } from "../http";
import type {
  SteerConversationPendingMessagesBody,
  SteerConversationPendingMessagesResponse,
} from "../schema/conversation";
import { readConversationAccessFromSql } from "./access";

/**
 * Steer the viewer's own queued web messages into the conversation now.
 *
 * Only the author can steer a message. Ids that are not the viewer's queued
 * web messages, or that Junior already read, are left out of the result.
 */
export async function steerConversationPendingMessagesForViewer(
  viewer: User,
  conversationId: string,
  body: SteerConversationPendingMessagesBody,
): Promise<SteerConversationPendingMessagesResponse> {
  const conversation = await getConversationStore().get({ conversationId });
  if (!conversation) {
    throwApiError(404, "Conversation not found.");
  }

  const access = await readConversationAccessFromSql(
    getDb(),
    [conversationId],
    viewer,
  );
  if (!access.get(conversationId)?.isParticipant) {
    throwApiError(
      403,
      "Only conversation participants can steer queued messages.",
    );
  }

  const result = await steerWebPendingMessages({
    authorId: webActorFromEmail(viewer.email).userId,
    conversationId,
    inboundMessageIds: body.inboundMessageIds,
  });
  return {
    conversationId,
    steeredInboundMessageIds: result.steeredInboundMessageIds,
  };
}
