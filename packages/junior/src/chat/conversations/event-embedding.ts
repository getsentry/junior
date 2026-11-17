/**
 * Event embeddings: a derived index for search by meaning over the history of
 * one Conversation. After each completed Turn, a background task embeds the
 * newest searchable events that have no vector of the configured model.
 *
 * Each run embeds a bounded slice, newest first, so a long Conversation
 * catches up over later Turns and older history gets vectors last. Keyword
 * search needs no vectors, so it covers every event at once. Retries are
 * safe: a stored vector is skipped, and a write replaces only its own row.
 */
import type {
  PluginRegistration,
  PluginTaskContext,
} from "@sentry/junior-plugin-api";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { JuniorDatabase } from "@/db/db";
import {
  juniorConversationEventEmbeddings,
  juniorConversationEvents,
} from "@/db/schema";
import { botConfig } from "@/chat/config";
import { getDb } from "@/chat/db";
import { embedTexts, type ConversationModelCost } from "@/chat/core-model";
import {
  eventSearchTextSql,
  SEARCHABLE_EVENT_TYPES,
} from "./event-search-text";

// About 2,000 tokens. The rest of a long event stays in keyword search.
const MAX_EMBEDDED_CHARS = 8_000;
const MAX_EVENTS_PER_RUN = 256;
const EMBEDDING_BATCH_SIZE = 32;
const EMBEDDING_LOCK_TTL_MS = 10 * 60 * 1_000;

/** Embeds event text as documents with one model. */
export interface ConversationEventEmbedder {
  embedDocuments(texts: string[]): Promise<{
    model: string;
    provider: string;
    vectors: number[][];
  }>;
  /** Model id that the embedder uses, before the first call. */
  model: string;
}

/** Create the event embedder that charges its cost to one Conversation. */
export function createConversationEventEmbedder(
  cost: ConversationModelCost,
): ConversationEventEmbedder {
  const model = botConfig.embeddingModelId;
  return {
    model,
    async embedDocuments(texts) {
      return await embedTexts({
        cost,
        inputType: "document",
        modelId: model,
        operation: "conversation_embedding",
        texts,
      });
    },
  };
}

/**
 * Embed the newest searchable events of one Conversation that have no
 * vector of the embedder's model. Return how many it stored.
 */
export async function embedConversationEvents(
  db: JuniorDatabase,
  embedder: ConversationEventEmbedder,
  conversationId: string,
): Promise<number> {
  const events = juniorConversationEvents;
  const embeddings = juniorConversationEventEmbeddings;
  const text = sql<string>`left(${eventSearchTextSql()}, ${MAX_EMBEDDED_CHARS})`;
  const rows = await db
    .select({ seq: events.seq, text })
    .from(events)
    .leftJoin(
      embeddings,
      and(
        eq(embeddings.conversationId, events.conversationId),
        eq(embeddings.seq, events.seq),
        eq(embeddings.model, embedder.model),
      ),
    )
    .where(
      and(
        eq(events.conversationId, conversationId),
        inArray(events.type, [...SEARCHABLE_EVENT_TYPES]),
        isNull(embeddings.seq),
        sql`btrim(${eventSearchTextSql()}) <> ''`,
      ),
    )
    .orderBy(desc(events.seq))
    .limit(MAX_EVENTS_PER_RUN);
  for (let start = 0; start < rows.length; start += EMBEDDING_BATCH_SIZE) {
    const batch = rows.slice(start, start + EMBEDDING_BATCH_SIZE);
    const result = await embedder.embedDocuments(batch.map((row) => row.text));
    // The query above finds unembedded events by the embedder's model, so a
    // row of another model would look unembedded on every run.
    if (result.model !== embedder.model) {
      throw new Error(
        `Embedding provider used model ${result.model}, not ${embedder.model}`,
      );
    }
    const values = batch.map((row, index) => {
      const vector = result.vectors[index];
      if (!vector) {
        throw new Error("Embedding provider returned too few vectors");
      }
      return {
        conversationId,
        dimensions: vector.length,
        embedding: vector,
        model: result.model,
        provider: result.provider,
        seq: row.seq,
      };
    });
    await db
      .insert(embeddings)
      .values(values)
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
  }
  return rows.length;
}

/** Core task registration that embeds events after each completed Turn. */
export const eventEmbeddingTaskRegistration: PluginRegistration = {
  manifest: {
    name: "event-embeddings",
    displayName: "Event embeddings",
    description: "Embeddings for search by meaning in Conversation history",
  },
  tasks: {
    embedEvents: {
      async run(context: PluginTaskContext) {
        const run = await context.run.load();
        await context.state.withLock(
          `event-embeddings:${run.conversationId}`,
          EMBEDDING_LOCK_TTL_MS,
          async () => {
            const embedded = await embedConversationEvents(
              getDb(),
              createConversationEventEmbedder({
                conversationId: run.conversationId,
                turnId: run.runId,
              }),
              run.conversationId,
            );
            context.log.info("Conversation events embedded", {
              conversationId: run.conversationId,
              embedded,
            });
          },
        );
      },
    },
  },
};
