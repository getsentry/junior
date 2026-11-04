import type { User } from "@sentry/junior-plugin-api";
import { ConversationForkError } from "@/chat/conversations/fork";
import { answerQuickQuestion } from "@/chat/conversations/quick-question";
import { getDb } from "@/chat/db";
import type { QuickQuestionBody } from "../schema/conversation-fork";
import { readConversationAccessFromSql } from "./access";
import { throwApiError } from "../http";

/** Answer a Quick question in a Conversation that the viewer can read. */
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
  if (!access.get(conversationId)?.canViewPrivateContent) {
    throwApiError(403, "You do not have access to this conversation.");
  }
  try {
    return await answerQuickQuestion({ conversationId, ...body, viewer });
  } catch (error) {
    if (error instanceof ConversationForkError) {
      throwApiError(409, error.message);
    }
    throw error;
  }
}
