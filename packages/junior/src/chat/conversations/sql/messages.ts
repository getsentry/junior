import { isDeepStrictEqual } from "node:util";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { JuniorSqlDatabase } from "@/db/db";
import type {
  ConversationMessageStore,
  NewConversationMessage,
} from "../messages";
import { ensureConversationRow } from "./conversation-row";
import { withConversationEventLock } from "./event-lock";
import { createSqlConversationEventStore } from "./history";
import { juniorConversationMessages, juniorConversations } from "@/db/schema";
import type { NewConversationEvent } from "../history";

type ConversationMessageRow = typeof juniorConversationMessages.$inferSelect;

interface ConversationMessage {
  conversationId: string;
  messageId: string;
  role: NewConversationMessage["role"];
  text: string;
  authorIdentityId?: string;
  meta?: Record<string, unknown>;
  repliedAtMs?: number;
  createdAtMs: number;
}

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
    await withConversationEventLock(this.executor, conversationId, async () => {
      await ensureConversationRow(
        this.executor,
        conversationId,
        newestCreatedAtMs,
      );
      const messageIds = messages.map((message) => message.messageId);
      const existing = new Map(
        (
          await this.executor
            .db()
            .select()
            .from(juniorConversationMessages)
            .where(
              and(
                eq(juniorConversationMessages.conversationId, conversationId),
                inArray(juniorConversationMessages.messageId, messageIds),
              ),
            )
        ).map((row) => [row.messageId, row]),
      );
      const events: NewConversationEvent[] = [];
      for (const message of messages) {
        const current = existing.get(message.messageId);
        const recorded = current
          ? messageFromRow(current)
          : { conversationId, ...message };
        events.push({
          idempotencyKey: `visible-message:${message.messageId}:recorded`,
          data: {
            type: "visible_message_recorded",
            messageId: recorded.messageId,
            role: recorded.role,
            text: recorded.text,
            ...(recorded.authorIdentityId
              ? { authorIdentityId: recorded.authorIdentityId }
              : {}),
            ...(recorded.meta ? { meta: recorded.meta } : {}),
          },
          createdAtMs: recorded.createdAtMs,
        });
        if (current && message.meta) {
          const mergedMeta = {
            ...(current.meta ?? {}),
            ...message.meta,
          };
          if (!isDeepStrictEqual(current.meta ?? {}, mergedMeta)) {
            events.push({
              data: {
                type: "visible_message_metadata_updated",
                messageId: message.messageId,
                meta: mergedMeta,
              },
              createdAtMs: Date.now(),
            });
          }
        }
      }
      await createSqlConversationEventStore(this.executor).append(
        conversationId,
        events,
      );
      await this.executor
        .db()
        .update(juniorConversations)
        .set({ archivedAt: null })
        .where(
          and(
            eq(juniorConversations.conversationId, conversationId),
            isNotNull(juniorConversations.archivedAt),
          ),
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
    await withConversationEventLock(this.executor, conversationId, async () => {
      const rows = await this.executor
        .db()
        .select()
        .from(juniorConversationMessages)
        .where(
          and(
            eq(juniorConversationMessages.conversationId, conversationId),
            eq(juniorConversationMessages.messageId, messageId),
          ),
        )
        .limit(1);
      if (!rows[0] || rows[0].repliedAt) {
        return;
      }
      const recorded = messageFromRow(rows[0]);
      await createSqlConversationEventStore(this.executor).append(
        conversationId,
        [
          {
            idempotencyKey: `visible-message:${messageId}:recorded`,
            data: {
              type: "visible_message_recorded",
              messageId: recorded.messageId,
              role: recorded.role,
              text: recorded.text,
              ...(recorded.authorIdentityId
                ? { authorIdentityId: recorded.authorIdentityId }
                : {}),
              ...(recorded.meta ? { meta: recorded.meta } : {}),
            },
            createdAtMs: recorded.createdAtMs,
          },
          {
            idempotencyKey: `visible-message:${messageId}:replied`,
            data: { type: "visible_message_replied", messageId },
            createdAtMs: repliedAtMs,
          },
        ],
      );
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
    });
  }
}

/** Create a SQL-backed conversation message store. */
export function createSqlConversationMessageStore(
  executor: JuniorSqlDatabase,
): ConversationMessageStore {
  return new SqlConversationMessageStore(executor);
}
