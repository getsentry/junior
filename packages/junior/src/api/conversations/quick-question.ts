import type { User } from "@sentry/junior-plugin-api";
import { ConversationForkError } from "@/chat/conversations/fork";
import { answerQuickQuestion } from "@/chat/conversations/quick-question";
import { getDb } from "@/chat/db";
import type { QuickQuestionBody } from "../schema/conversation-fork";
import { readConversationAccessFromSql } from "./access";
import { throwApiError } from "../http";

/**
 * Answer a Quick question for a participant. The cost belongs to the
 * Conversation, so readers who cannot send cannot ask.
 */
export async function answerQuickQuestionForViewer(
  viewer: User,
  conversationId: string,
  body: QuickQuestionBody,
): Promise<{ text: string }> {
  const access = await readConversationAccessFromSql(
    getDb(),
    [conversationId],
    viewer,
  );
  if (!access.get(conversationId)?.isParticipant) {
    throwApiError(403, "You do not have access to this conversation.");
  }
  const answer = await answerQuickQuestion({
    conversationId,
    ...body,
    viewer,
  }).catch((error: unknown) => {
    if (error instanceof ConversationForkError) {
      throwApiError(409, error.message);
    }
    throw error;
  });
  if (!answer.text) throwApiError(502, "Junior returned no answer.");
  return answer;
}
