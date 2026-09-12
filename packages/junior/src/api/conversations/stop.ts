import type { User } from "@sentry/junior-plugin-api";
import { stopConversationTurn } from "@/chat/conversations/stop";
import { getConversationStore, getDb } from "@/chat/db";
import { getVercelConversationWorkQueue } from "@/chat/task-execution/vercel-queue";
import { throwApiError } from "../http";
import type { StopConversationResponse } from "../schema/conversation";
import { readConversationAccessFromSql } from "./access";

/** Stop the active Conversation Turn for one participant. */
export async function stopConversationForViewer(
  viewer: User,
  conversationId: string,
): Promise<StopConversationResponse> {
  const conversationStore = getConversationStore();
  if (!(await conversationStore.get({ conversationId }))) {
    throwApiError(404, "Conversation not found.");
  }
  const access = await readConversationAccessFromSql(
    getDb(),
    [conversationId],
    viewer,
  );
  if (!access.get(conversationId)?.isParticipant) {
    throwApiError(403, "Only conversation participants can stop this work.");
  }
  try {
    const result = await stopConversationTurn({
      conversationId,
      conversationStore,
      queue: getVercelConversationWorkQueue(),
    });
    return { conversationId, status: result.status };
  } catch (error) {
    throwApiError(500, "Unable to stop this conversation.", error);
  }
}
