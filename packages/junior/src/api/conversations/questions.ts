import type { User } from "@sentry/junior-plugin-api";
import { asc, eq } from "drizzle-orm";
import { getDb, getSqlExecutor } from "@/chat/db";
import { loadConversationSlackTenantIds } from "@/chat/conversations/sql/event-actor";
import { inboxItemQuestion } from "@/chat/inbox-items/request";
import { juniorQuestions } from "@/db/schema";
import { throwApiError } from "../http";
import { resolveMentions } from "../mentions";
import type { ConversationQuestionsReport } from "../schema/conversation-questions";
import { readConversationAccessFromSql } from "./access";

/**
 * Load the questions that agents asked in one Conversation, with their
 * answers, for its transcript. It reads only the Conversation's own data,
 * not the Inbox. Only a viewer who can see the Conversation's private
 * content reads them. Others get the same 404 as a missing Conversation.
 */
export async function requireConversationQuestions(
  conversationId: string,
  viewer: User | undefined,
): Promise<ConversationQuestionsReport> {
  const executor = getSqlExecutor();
  const [access, rows, tenants] = await Promise.all([
    readConversationAccessFromSql(getDb(), [conversationId], viewer),
    getDb()
      .select()
      .from(juniorQuestions)
      .where(eq(juniorQuestions.conversationId, conversationId))
      .orderBy(asc(juniorQuestions.createdAt), asc(juniorQuestions.id)),
    loadConversationSlackTenantIds(executor, [conversationId]),
  ]);
  if (!access.get(conversationId)?.canViewPrivateContent) {
    throwApiError(404, "Conversation not found.");
  }
  const tenantId = tenants.get(conversationId);
  const mentions = await resolveMentions(
    executor,
    rows.map((row) => ({
      tenantId,
      texts: [row.title, row.body, inboxItemQuestion(row.request)?.question],
    })),
  );
  return {
    conversationId,
    questions: rows.map((row, index) => ({
      body: row.body,
      createdAt: row.createdAt.toISOString(),
      id: row.id,
      title: row.title,
      updatedAt: row.updatedAt.toISOString(),
      ...(row.answer ? { answer: row.answer } : undefined),
      ...(mentions[index]!.length > 0
        ? { mentions: mentions[index] }
        : undefined),
      ...(row.request ? { request: row.request } : undefined),
      ...(row.turnId ? { turnId: row.turnId } : undefined),
    })),
  };
}
