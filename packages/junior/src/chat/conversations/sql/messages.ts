import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { JuniorSqlDatabase } from "@/db/db";
import type {
  ConversationMessage,
  ConversationMessageStore,
  NewConversationMessage,
} from "../messages";
import { ensureConversationRow } from "./conversation-row";
import { juniorConversationMessages } from "@/db/schema";

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
    // The newest message in the batch drives the retention clock: callers
    // persist the full working set oldest-first, so the first entry would pin
    // the clock to history and greatest() would never advance it.
    const newestCreatedAtMs = Math.max(
      ...messages.map((message) => message.createdAtMs),
    );
    await this.executor.transaction(async () => {
      await ensureConversationRow(
        this.executor,
        conversationId,
        newestCreatedAtMs,
      );
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

  async markReplied(
    conversationId: string,
    messageId: string,
    repliedAtMs: number,
  ): Promise<void> {
    await this.executor
      .db()
      .update(juniorConversationMessages)
      .set({
        repliedAt: sql`coalesce(${juniorConversationMessages.repliedAt}, ${new Date(repliedAtMs)})`,
      })
      .where(
        and(
          eq(juniorConversationMessages.conversationId, conversationId),
          eq(juniorConversationMessages.messageId, messageId),
          isNull(juniorConversationMessages.repliedAt),
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
