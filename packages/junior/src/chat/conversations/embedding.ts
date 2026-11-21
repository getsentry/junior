/**
 * One embedding per Conversation: a derived index for semantic Conversation
 * search. Its text is the latest Brief, which summarizes the Conversation.
 * A search compares only vectors of the same provider, model, and size as
 * its query. The Brief task stores the vector of each new Brief. The
 * heartbeat backfill stores the vectors that a model change or a failed
 * task left out.
 */
import type { PluginEmbedder } from "@sentry/junior-plugin-api";
import {
  embedText,
  guardedCosineDistance,
  refreshEmbeddings,
  type EmbeddingBatch,
  type EmbeddingVector,
} from "@/db/embeddings";
import {
  and,
  asc,
  eq,
  gt,
  isNull,
  notExists,
  sql,
  type AnyColumn,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { JuniorDatabase } from "@/db/db";
import {
  juniorConversationBriefs,
  juniorConversationEmbeddings,
} from "@/db/schema";
import { botConfig } from "@/chat/config";
import { embedTexts, type ConversationModelCost } from "@/chat/core-model";
import type { ConversationBriefVersion } from "@/chat/briefs/store";
import { GEN_AI_PROVIDER_NAME } from "@/chat/pi/client";

// About 2,000 tokens, well inside the input limit of each supported model.
// Brief search text starts with the title, summary, intent, and outcome, so
// the cut drops only trailing facts and link labels.
const MAX_EMBEDDED_CHARS = 8_000;
const BACKFILL_BATCH_SIZE = 32;

/** Create the embedder of the configured model that charges its cost to `cost`. */
export function createConversationEmbedder(args: {
  cost: ConversationModelCost;
  operation: "conversation_embedding" | "conversation_search_embedding";
}): PluginEmbedder {
  const model = botConfig.embeddingModelId;
  return {
    model,
    provider: GEN_AI_PROVIDER_NAME,
    async embedTexts(input) {
      return await embedTexts({
        cost: args.cost,
        inputType: input.inputType ?? "document",
        modelId: model,
        operation: args.operation,
        texts: input.texts.map((text) => text.slice(0, MAX_EMBEDDED_CHARS)),
      });
    },
  };
}

/** Embed a search query for `conversationSimilarity`. */
export async function embedConversationQuery(
  embedder: PluginEmbedder,
  text: string,
): Promise<EmbeddingVector> {
  return await embedText(embedder, { inputType: "query", text });
}

interface BriefItem {
  conversationId: string;
  text: string;
  version: number;
}

/**
 * Store one batch of Brief vectors. A row is replaced only by a vector of
 * the same or a newer Brief version, so an older Turn never replaces a newer
 * vector, and a backfill can replace a vector of another model.
 */
async function writeConversationEmbeddings(
  db: JuniorDatabase,
  rows: Array<{ item: BriefItem; vector: number[] }>,
  batch: EmbeddingBatch,
): Promise<void> {
  const table = juniorConversationEmbeddings;
  await db
    .insert(table)
    .values(
      rows.map(({ item, vector }) => ({
        briefVersion: item.version,
        conversationId: item.conversationId,
        dimensions: batch.dimensions,
        embedding: vector,
        model: batch.model,
        provider: batch.provider,
      })),
    )
    .onConflictDoUpdate({
      target: table.conversationId,
      set: {
        briefVersion: sql`excluded.brief_version`,
        dimensions: sql`excluded.dimensions`,
        embedding: sql`excluded.embedding`,
        model: sql`excluded.model`,
        provider: sql`excluded.provider`,
        createdAt: sql`now()`,
      },
      setWhere: sql`${table.briefVersion} <= excluded.brief_version`,
    });
}

/** Whether a stored row is the embedder's vector of this or a newer Brief. */
function hasCurrentVector(
  embedder: PluginEmbedder,
  version: AnyColumn | number,
): SQL | undefined {
  const table = juniorConversationEmbeddings;
  return and(
    eq(table.provider, embedder.provider),
    eq(table.model, embedder.model),
    sql`${table.briefVersion} >= ${version}`,
  );
}

/**
 * Store the Conversation embedding of a stored Brief. Skip it when the
 * Conversation already has a vector of the embedder's model for this or a
 * newer Brief version, so a task retry embeds once.
 */
export async function storeConversationEmbedding(
  db: JuniorDatabase,
  embedder: PluginEmbedder,
  brief: ConversationBriefVersion,
): Promise<void> {
  if (!brief.searchText.trim()) {
    return;
  }
  const table = juniorConversationEmbeddings;
  const [current] = await db
    .select({ conversationId: table.conversationId })
    .from(table)
    .where(
      and(
        eq(table.conversationId, brief.conversationId),
        hasCurrentVector(embedder, brief.version),
      ),
    )
    .limit(1);
  if (current) {
    return;
  }
  const embedding = await embedText(embedder, {
    inputType: "document",
    text: brief.searchText,
  });
  await writeConversationEmbeddings(
    db,
    [
      {
        item: {
          conversationId: brief.conversationId,
          text: brief.searchText,
          version: brief.version,
        },
        vector: embedding.vector,
      },
    ],
    {
      dimensions: embedding.vector.length,
      model: embedding.model,
      provider: embedding.provider,
      vectors: [embedding.vector],
    },
  );
}

/**
 * Embed the latest Brief of each Conversation that has no vector of the
 * embedder's model for it, in Conversation id order. Return whether no such
 * Brief was left, and how many it embedded.
 */
export async function backfillConversationEmbeddings(args: {
  db: JuniorDatabase;
  deadlineMs: number;
  embedder: PluginEmbedder;
}) {
  const briefs = juniorConversationBriefs;
  const embeddings = juniorConversationEmbeddings;
  const newer = alias(briefs, "newer_briefs");
  return await refreshEmbeddings<BriefItem>({
    batchSize: BACKFILL_BATCH_SIZE,
    deadlineMs: args.deadlineMs,
    embedder: args.embedder,
    listMissing: async ({ after, limit }) =>
      await args.db
        .select({
          conversationId: briefs.conversationId,
          text: briefs.searchText,
          version: briefs.version,
        })
        .from(briefs)
        .leftJoin(
          embeddings,
          and(
            eq(embeddings.conversationId, briefs.conversationId),
            hasCurrentVector(args.embedder, briefs.version),
          ),
        )
        .where(
          and(
            // The latest Brief only: no newer version exists.
            notExists(
              args.db
                .select({ one: sql`1` })
                .from(newer)
                .where(
                  and(
                    eq(newer.conversationId, briefs.conversationId),
                    gt(newer.version, briefs.version),
                  ),
                ),
            ),
            isNull(embeddings.conversationId),
            after ? gt(briefs.conversationId, after.conversationId) : undefined,
          ),
        )
        .orderBy(asc(briefs.conversationId))
        .limit(limit),
    write: async (rows, batch) =>
      await writeConversationEmbeddings(args.db, rows, batch),
  });
}

/**
 * Cosine similarity of the stored vector to a query vector. Null for a
 * vector of another model or size.
 */
export function conversationSimilarity(
  query: EmbeddingVector,
): SQL<number | null> {
  const table = juniorConversationEmbeddings;
  const distance = guardedCosineDistance({
    column: table.embedding,
    dimensions: table.dimensions,
    query: query.vector,
    type: "vector",
  });
  return sql<
    number | null
  >`CASE WHEN ${table.provider} = ${query.provider} AND ${table.model} = ${query.model} THEN 1 - ${distance} END`;
}
