/**
 * Event embeddings: a derived index for search by meaning over the history of
 * one Conversation. After each completed Turn, the event search task stores
 * lexemes (`event-lexemes.ts`) and embeds the newest searchable events that
 * have no vector of the configured model.
 *
 * Each run embeds a bounded slice, newest first, and older history gets
 * vectors last. The heartbeat backfill (`event-search-backfill.ts`) embeds
 * the rest in recently active Conversations. Keyword search needs no
 * vectors, so it covers every event at once. Retries are safe: a stored
 * vector is skipped, and a write replaces only its own row.
 */
import type {
  PluginEmbedder,
  PluginRegistration,
  PluginTaskContext,
} from "@sentry/junior-plugin-api";
import { refreshEmbeddings } from "@/db/embeddings";
import { and, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import type { JuniorDatabase } from "@/db/db";
import {
  juniorConversationEventEmbeddings,
  juniorConversationEvents,
} from "@/db/schema";
import { getDb } from "@/chat/db";
import { createConversationEmbedder } from "./embedding";
import { storeConversationEventLexemes } from "./event-lexemes";
import {
  eventSearchTextSql,
  SEARCHABLE_EVENT_TYPES,
} from "./event-search-text";

// About 2,000 tokens. The rest of a long event stays in keyword search.
const MAX_EMBEDDED_CHARS = 8_000;
const MAX_EVENTS_PER_RUN = 256;
const EMBEDDING_BATCH_SIZE = 32;
/** How long the event search index of one Conversation stays locked. */
export const EVENT_INDEX_LOCK_TTL_MS = 10 * 60 * 1_000;
// Longer than the 10 s budget of a heartbeat backfill run.
const EVENT_INDEX_LOCK_WAIT_MS = 30_000;

/**
 * Lock of the event search index of one Conversation. The task and the
 * heartbeat backfill take it, so they do not embed the same events twice.
 * The `junior:event-search:` prefix keeps the key the same in plugin state.
 */
export function eventIndexLockKey(conversationId: string): string {
  return `junior:event-search:index:${conversationId}`;
}

/**
 * Embed the newest searchable events of one Conversation that have no
 * vector of the embedder's model. Return how many it stored.
 */
export async function embedConversationEvents(
  db: JuniorDatabase,
  embedder: PluginEmbedder,
  conversationId: string,
  limits: { deadlineMs?: number; maxEvents?: number } = {},
): Promise<number> {
  const events = juniorConversationEvents;
  const embeddings = juniorConversationEventEmbeddings;
  const text = sql<string>`left(${eventSearchTextSql()}, ${MAX_EMBEDDED_CHARS})`;
  const refresh = await refreshEmbeddings<{ seq: number; text: string }>({
    batchSize: EMBEDDING_BATCH_SIZE,
    deadlineMs: limits.deadlineMs,
    embedder,
    maxItems: limits.maxEvents ?? MAX_EVENTS_PER_RUN,
    listMissing: async ({ after, limit }) =>
      await db
        .select({ seq: events.seq, text })
        .from(events)
        .leftJoin(
          embeddings,
          and(
            eq(embeddings.conversationId, events.conversationId),
            eq(embeddings.seq, events.seq),
            eq(embeddings.provider, embedder.provider),
            eq(embeddings.model, embedder.model),
          ),
        )
        .where(
          and(
            eq(events.conversationId, conversationId),
            inArray(events.type, [...SEARCHABLE_EVENT_TYPES]),
            isNull(embeddings.seq),
            // Text of only whitespace, such as newlines, has nothing to embed.
            sql`${eventSearchTextSql()} ~ '[^[:space:]]'`,
            after ? lt(events.seq, after.seq) : undefined,
          ),
        )
        .orderBy(desc(events.seq))
        .limit(limit),
    write: async (rows, batch) => {
      await db
        .insert(embeddings)
        .values(
          rows.map(({ item, vector }) => ({
            conversationId,
            dimensions: batch.dimensions,
            embedding: vector,
            model: batch.model,
            provider: batch.provider,
            seq: item.seq,
          })),
        )
        .onConflictDoUpdate({
          target: [embeddings.conversationId, embeddings.seq],
          set: {
            dimensions: sql`excluded.dimensions`,
            embedding: sql`excluded.embedding`,
            model: sql`excluded.model`,
            provider: sql`excluded.provider`,
            createdAt: sql`now()`,
          },
        });
    },
  });
  return refresh.embedded;
}

/**
 * Core task registration that stores lexemes after each completed Turn and,
 * when `embedEvents` is set, embeds events too.
 */
export function eventSearchTaskRegistration(options: {
  embedEvents: boolean;
}): PluginRegistration {
  return {
    manifest: {
      name: "event-search",
      displayName: "Event search",
      description: "Lexemes and embeddings for Conversation history search",
    },
    tasks: {
      indexEvents: {
        async run(context: PluginTaskContext) {
          const run = await context.run.load();
          const attempt = await context.state.withLock(
            eventIndexLockKey(run.conversationId),
            EVENT_INDEX_LOCK_TTL_MS,
            async () => {
              // Wait for both before the lock is released, even when one fails.
              const [lexemeResult, embeddingResult] = await Promise.allSettled([
                storeConversationEventLexemes(getDb(), run.conversationId),
                options.embedEvents
                  ? embedConversationEvents(
                      getDb(),
                      createConversationEmbedder({
                        cost: {
                          conversationId: run.conversationId,
                          turnId: run.runId,
                        },
                        operation: "conversation_embedding",
                      }),
                      run.conversationId,
                    )
                  : 0,
              ]);
              if (lexemeResult.status === "rejected") {
                throw lexemeResult.reason;
              }
              if (embeddingResult.status === "rejected") {
                throw embeddingResult.reason;
              }
              context.log.info("Conversation events indexed", {
                conversationId: run.conversationId,
                embedded: embeddingResult.value,
                lexemes: lexemeResult.value,
              });
            },
            // The heartbeat backfill holds the lock for at most its run
            // budget. Waiting indexes this Turn's events now instead of after
            // the backfill marks the index done.
            { waitMs: EVENT_INDEX_LOCK_WAIT_MS },
          );
          if (!attempt.acquired) {
            context.log.info("Conversation event index busy", {
              conversationId: run.conversationId,
            });
          }
        },
      },
    },
  };
}
