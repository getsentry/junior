import type { User } from "@sentry/junior-plugin-api";
import {
  canPauseConversationDelivery,
  pauseConversationDelivery,
  resumeConversationDelivery,
} from "@/chat/conversations/delivery-pause";
import { getConversationStore, getDb } from "@/chat/db";
import { throwApiError } from "../http";
import type {
  ConversationDeliveryBody,
  ConversationDeliveryResponse,
} from "../schema/conversation-delivery";
import { readConversationAccessFromSql } from "./access";

/**
 * Detach a root from its Location, or attach it again. Only a participant
 * can change it, the same as rename. A mention in the Location attaches it
 * again too.
 */
export async function setConversationDeliveryForViewer(
  viewer: User,
  conversationId: string,
  body: ConversationDeliveryBody,
): Promise<ConversationDeliveryResponse> {
  const access = await readConversationAccessFromSql(
    getDb(),
    [conversationId],
    viewer,
  );
  const conversation = access.get(conversationId)?.isParticipant
    ? await getConversationStore().get({ conversationId })
    : undefined;
  if (!conversation) throwApiError(404, "Conversation not found.");
  if (!canPauseConversationDelivery(conversation)) {
    throwApiError(409, "Only a conversation with a Slack thread can detach.");
  }
  if (body.paused) {
    await pauseConversationDelivery(conversationId);
  } else {
    await resumeConversationDelivery(conversationId);
  }
  return { paused: body.paused };
}
