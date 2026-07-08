import { and, asc, eq } from "drizzle-orm";
import type { JuniorSqlDatabase } from "@/chat/sql/db";
import type {
  ConversationMessage,
  ConversationMessageStore,
  NewConversationMessage,
} from "../messages";
import { juniorConversationMessages } from "./schema";

type ConversationMessageRow = typeof juniorConversationMessages.$inferSelect;

function messageFromRow(row: ConversationMessageRow): ConversationMessage {
  return {
    conversationId: row.conversationId,
    messageId: row.messageId,
    role: row.role,
    text: row.text,
    createdAtMs: row.createdAt.getTime(),
    ...(row.authorIdentityId ? { authorIdentityId: row.authorIdentityId } : {}),
    ...(row.meta ? { meta: row.meta } : {}),
    ...(row.repliedAt ? { repliedAtMs: row.repliedAt.getTime() } : {}),
  };
}

class SqlConversationMessageStore implements ConversationMessageStore {
  constructor(private readonly executor: JuniorSqlDatabase) {}

  async record(
    conversationId: string,
    messages: NewConversationMessage[],
  ): Promise<void> {
    if (messages.length === 0) {
      return;
    }
    await this.executor
      .db()
      .insert(juniorConversationMessages)
      .values(
        messages.map((message) => ({
          conversationId,
          messageId: message.messageId,
          role: message.role,
          authorIdentityId: message.authorIdentityId ?? null,
          text: message.text,
          meta: message.meta ?? null,
          repliedAt: null,
          createdAt: new Date(message.createdAtMs),
        })),
      )
      .onConflictDoNothing();
  }

  async markReplied(
    conversationId: string,
    messageId: string,
    repliedAtMs: number,
  ): Promise<void> {
    await this.executor
      .db()
      .update(juniorConversationMessages)
      .set({ repliedAt: new Date(repliedAtMs) })
      .where(
        and(
          eq(juniorConversationMessages.conversationId, conversationId),
          eq(juniorConversationMessages.messageId, messageId),
        ),
      );
  }

  async list(
    conversationId: string,
    opts: { limit?: number } = {},
  ): Promise<ConversationMessage[]> {
    const query = this.executor
      .db()
      .select()
      .from(juniorConversationMessages)
      .where(eq(juniorConversationMessages.conversationId, conversationId))
      .orderBy(
        asc(juniorConversationMessages.createdAt),
        asc(juniorConversationMessages.messageId),
      );
    const rows =
      opts.limit === undefined
        ? await query
        : await query.limit(Math.max(0, opts.limit));
    return rows.map(messageFromRow);
  }
}

/** Create a SQL-backed conversation message store. */
export function createSqlConversationMessageStore(
  executor: JuniorSqlDatabase,
): ConversationMessageStore {
  return new SqlConversationMessageStore(executor);
}
