import type { User } from "@sentry/junior-plugin-api";
import { getConversationStore, getDb } from "@/chat/db";
import { cancelHumanFacingPendingMessages } from "@/chat/task-execution/store";
import { throwApiError } from "../http";
import type {
  CancelConversationPendingMessagesBody,
  CancelConversationPendingMessagesResponse,
} from "../schema/conversation";
import { readConversationAccessFromSql } from "./access";

/** Cancel accepted human-facing mailbox rows for one conversation participant. */
export async function cancelConversationPendingMessagesForViewer(
  viewer: User,
  conversationId: string,
  body: CancelConversationPendingMessagesBody = {},
): Promise<CancelConversationPendingMessagesResponse> {
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
      "Only conversation participants can cancel queued messages.",
    );
  }

  try {
    const result = await cancelHumanFacingPendingMessages({
      conversationId,
      ...(body.inboundMessageIds
        ? { inboundMessageIds: body.inboundMessageIds }
        : {}),
      ...(body.receivedBefore
        ? { receivedBeforeMs: Date.parse(body.receivedBefore) }
        : {}),
      conversationStore: getConversationStore(),
    });
    return {
      cancelledCount: result.cancelledInboundMessageIds.length,
      cancelledInboundMessageIds: result.cancelledInboundMessageIds,
      conversationId,
    };
  } catch (error) {
    throwApiError(500, "Unable to cancel queued messages.", error);
  }
}
