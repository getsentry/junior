import { and, asc, eq, sql } from "drizzle-orm";
import type { JuniorSqlDatabase } from "@/chat/sql/db";
import type {
  ConversationMessage,
  ConversationMessageStore,
  NewConversationMessage,
} from "../messages";
import { juniorConversationMessages, juniorConversations } from "./schema";

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
    await this.executor.transaction(async () => {
      await this.ensureConversation(conversationId, messages[0]!.createdAtMs);
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
        // `role`/`text`/`author_identity_id`/`created_at` are immutable source
        // facts; only the runtime-derived `meta` bag is refreshed on redelivery
        // so late image-hydration and routing marks survive. The refresh is a
        // key-wise merge, never a replacement: a writer that omits keys (e.g.
        // a legacy import without author display facts) must not erase what an
        // earlier writer recorded. `replied_at` is owned by markReplied and
        // never touched here.
        .onConflictDoUpdate({
          target: [
            juniorConversationMessages.conversationId,
            juniorConversationMessages.messageId,
          ],
          set: {
            meta: sql`nullif(coalesce(${juniorConversationMessages.meta}, '{}'::jsonb) || coalesce(excluded.meta, '{}'::jsonb), '{}'::jsonb)`,
          },
        });
    });
  }

  /**
   * Establish the conversation metadata row on first contact, matching the
   * step store's lazy-upsert: the visible transcript can be recorded before
   * activity recording has created the row, and this table FKs to it.
   */
  private async ensureConversation(
    conversationId: string,
    atMs: number,
  ): Promise<void> {
    const at = new Date(atMs);
    await this.executor
      .db()
      .insert(juniorConversations)
      .values({
        conversationId,
        createdAt: at,
        lastActivityAt: at,
        updatedAt: at,
        executionStatus: "idle",
      })
      .onConflictDoNothing({ target: juniorConversations.conversationId });
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
