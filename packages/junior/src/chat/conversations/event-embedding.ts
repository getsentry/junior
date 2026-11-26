/**
 * Event embeddings: a derived index for search by meaning over the history of
 * one Conversation. After each Turn that ends, the event search task or the
 * Turn itself stores lexemes (`event-lexemes.ts`) and embeds the newest
 * searchable events that have no vector of the configured model.
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
import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { JuniorDatabase } from "@/db/db";
import {
  juniorConversationEventEmbeddings,
  juniorConversationEventLexemes,
  juniorConversationEvents,
} from "@/db/schema";
import { getDb } from "@/chat/db";
import { logException, logInfo } from "@/chat/logging";
import { getStateAdapter } from "@/chat/state/adapter";
import { withLock } from "@/chat/state/locks";
import { createConversationEmbedder } from "./embedding";
import { isEventEmbeddingsEnabled } from "./event-embedding-config";
import { seqIn, storeConversationEventLexemes } from "./event-lexemes";
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
  const lexemes = juniorConversationEventLexemes;
  const text = sql<
    string | null
  >`left(${eventSearchTextSql()}, ${MAX_EMBEDDED_CHARS})`;
  const refresh = await refreshEmbeddings<{ seq: number; text: string }>({
    batchSize: EMBEDDING_BATCH_SIZE,
    deadlineMs: limits.deadlineMs,
    embedder,
    maxItems: limits.maxEvents ?? MAX_EVENTS_PER_RUN,
    listMissing: async ({ after, limit }) => {
      // Find the seqs first, so Postgres reads the text of only this page.
      // In one query, it reads the text of every event in the Conversation,
      // embedded or not, before it applies the limit.
      const missing = await db
        .select({ seq: events.seq })
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
        .leftJoin(
          lexemes,
          and(
            eq(lexemes.conversationId, events.conversationId),
            eq(lexemes.seq, events.seq),
          ),
        )
        .where(
          and(
            eq(events.conversationId, conversationId),
            inArray(events.type, [...SEARCHABLE_EVENT_TYPES]),
            isNull(embeddings.seq),
            // An event without text never gets a vector, so it would stay
            // missing and be read again on every run. Its stored lexemes are
            // empty, so skip it, as the heartbeat backfill does. Text of only
            // stopwords also has empty lexemes and gets no vector. An event
            // without stored lexemes yet is read until a run stores them.
            or(isNull(lexemes.seq), sql`length(${lexemes.lexemes}) > 0`),
            after ? lt(events.seq, after.seq) : undefined,
          ),
        )
        .orderBy(desc(events.seq))
        .limit(limit);
      if (missing.length === 0) return [];
      const texts = await db
        .select({ seq: events.seq, text })
        .from(events)
        .where(
          and(
            eq(events.conversationId, conversationId),
            seqIn(missing.map((row) => row.seq)),
          ),
        );
      const textBySeq = new Map(texts.map((row) => [row.seq, row.text]));
      // An event without text stays in the page with empty text, so the
      // next page starts after it. `refreshEmbeddings` skips it.
      return missing.map(({ seq }) => ({
        seq,
        text: textBySeq.get(seq) ?? "",
      }));
    },
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
 * Store the missing lexemes of one Conversation's events, and their vectors
 * when `embedEvents` is set, under the Conversation's index lock. A Turn
 * that ends calls it, through the event search task or directly. When the
 * lock stays busy, the heartbeat backfill indexes the events later.
 */
export async function indexConversationEvents(args: {
  conversationId: string;
  embedEvents: boolean;
  turnId: string;
}): Promise<void> {
  const { conversationId, turnId } = args;
  const attempt = await withLock(
    getStateAdapter(),
    eventIndexLockKey(conversationId),
    async () => {
      // Wait for both before the lock is released, even when one fails.
      const [lexemeResult, embeddingResult] = await Promise.allSettled([
        storeConversationEventLexemes(getDb(), conversationId),
        args.embedEvents
          ? embedConversationEvents(
              getDb(),
              createConversationEmbedder({
                cost: { conversationId, turnId },
                operation: "conversation_embedding",
              }),
              conversationId,
            )
          : 0,
      ]);
      if (lexemeResult.status === "rejected") {
        throw lexemeResult.reason;
      }
      if (embeddingResult.status === "rejected") {
        throw embeddingResult.reason;
      }
      logInfo("event_search.index.completed", {
        conversationId,
        embedded: embeddingResult.value,
        lexemes: lexemeResult.value,
      });
    },
    // The heartbeat backfill holds the lock for at most its run budget.
    // Waiting indexes this Turn's events now instead of in a later pass.
    { ttlMs: EVENT_INDEX_LOCK_TTL_MS, waitMs: EVENT_INDEX_LOCK_WAIT_MS },
  );
  if (!attempt.acquired) {
    logInfo("event_search.index.busy", { conversationId });
  }
}

/**
 * Index the events of a Turn that ended without the event search task: a
 * failed or stopped Turn, or a completed Turn of a kind without session
 * tasks. A failure is logged, so indexing never changes the Turn's outcome.
 */
export async function indexEndedTurnEvents(args: {
  conversationId: string;
  turnId: string;
}): Promise<void> {
  const { conversationId, turnId } = args;
  try {
    await indexConversationEvents({
      conversationId,
      embedEvents: isEventEmbeddingsEnabled(),
      turnId,
    });
  } catch (error) {
    logException(error, "event_search.index.failed", {
      conversationId,
      turnId,
    });
  }
}

/**
 * Core task registration that indexes the events of a completed Turn:
 * lexemes, and vectors when `embedEvents` is set.
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
          await indexConversationEvents({
            conversationId: run.conversationId,
            embedEvents: options.embedEvents,
            turnId: run.runId,
          });
        },
      },
    },
  };
}
