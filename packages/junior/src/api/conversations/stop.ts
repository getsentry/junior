import type { User } from "@sentry/junior-plugin-api";
import { stopConversationTurn } from "@/chat/conversations/stop";
import { getConversationStore, getDb } from "@/chat/db";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { getVercelConversationWorkQueue } from "@/chat/task-execution/vercel-queue";
import { throwApiError } from "../http";
import type { StopConversationTurnResponse } from "../schema/conversation";
import { readConversationAccessFromSql } from "./access";

/** Stop the active Turn for one conversation participant. */
export async function stopConversationTurnForViewer(
  viewer: User,
  conversationId: string,
  options?: { queue?: ConversationWorkQueue },
): Promise<StopConversationTurnResponse> {
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
    throwApiError(403, "Only conversation participants can stop this turn.");
  }

  try {
    const result = await stopConversationTurn({
      conversationId,
      conversationStore: getConversationStore(),
      queue: options?.queue ?? getVercelConversationWorkQueue(),
    });
    return { conversationId, status: result.status };
  } catch (error) {
    throwApiError(500, "Unable to stop the active turn.", error);
  }
}
