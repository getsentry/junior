/**
 * One embedding per Conversation: a derived index for semantic Conversation
 * search. Its text is the Conversation metadata: the title and summary.
 * A search compares only vectors of the same provider, model, and size as
 * its query. The metadata task stores the vector of each new summary. The
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
} from "@sentry/junior-plugin-api/embeddings";
import {
  and,
  asc,
  eq,
  gt,
  isNotNull,
  isNull,
  sql,
  type AnyColumn,
  type SQL,
} from "drizzle-orm";
import type { JuniorDatabase } from "@/db/db";
import { juniorConversationEmbeddings, juniorConversations } from "@/db/schema";
import { botConfig } from "@/chat/config";
import { mapBounded } from "@/chat/fan-out";
import { embedTexts, type ConversationModelCost } from "@/chat/core-model";
import type { ConversationMetadata } from "@/chat/conversations/metadata/store";
import { GEN_AI_PROVIDER_NAME } from "@/chat/pi/client";

// About 2,000 tokens, well inside the input limit of each supported model.
const MAX_EMBEDDED_CHARS = 8_000;
const BACKFILL_BATCH_SIZE = 32;
const EMBEDDING_WRITE_CONCURRENCY = 4;

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

interface MetadataItem {
  conversationId: string;
  text: string;
  throughSeq: number;
}

function metadataText(title: string | null | undefined, summary: string) {
  return title ? `${title}\n${summary}` : summary;
}

/**
 * Store one batch of metadata vectors. A row is replaced only by a vector of
 * the same or newer metadata, so an older Turn never replaces a newer vector,
 * and a backfill can replace a vector of another model.
 *
 * A vector is stored only while its Conversation still has that or newer
 * metadata. The share lock on the Conversation row holds until the insert
 * commits. Purge clears the metadata with an update before it deletes the
 * embeddings, so it either waits for this insert and then deletes it, or
 * runs first and this write skips the Conversation. Each Conversation gets
 * its own transaction, so a write holds one row lock and cannot deadlock with
 * a purge that locks a tree's rows in another order.
 */
async function writeConversationEmbeddings(
  db: JuniorDatabase,
  rows: Array<{ item: MetadataItem; vector: number[] }>,
  batch: EmbeddingBatch,
): Promise<void> {
  await mapBounded(
    rows,
    (row) => writeConversationEmbedding(db, row, batch),
    EMBEDDING_WRITE_CONCURRENCY,
  );
}

async function writeConversationEmbedding(
  db: JuniorDatabase,
  { item, vector }: { item: MetadataItem; vector: number[] },
  batch: EmbeddingBatch,
): Promise<void> {
  const table = juniorConversationEmbeddings;
  await db.transaction(async (tx) => {
    const [current] = await tx
      .select({ metadataThroughSeq: juniorConversations.metadataThroughSeq })
      .from(juniorConversations)
      .where(eq(juniorConversations.conversationId, item.conversationId))
      .for("share");
    const throughSeq = current?.metadataThroughSeq;
    if (throughSeq === null || throughSeq === undefined) return;
    if (throughSeq < item.throughSeq) return;
    await tx
      .insert(table)
      .values({
        conversationId: item.conversationId,
        dimensions: batch.dimensions,
        embedding: vector,
        legacyBriefVersion: null,
        model: batch.model,
        provider: batch.provider,
        throughSeq: item.throughSeq,
      })
      .onConflictDoUpdate({
        target: table.conversationId,
        set: {
          dimensions: sql`excluded.dimensions`,
          embedding: sql`excluded.embedding`,
          legacyBriefVersion: null,
          model: sql`excluded.model`,
          provider: sql`excluded.provider`,
          throughSeq: sql`excluded.through_seq`,
          createdAt: sql`now()`,
        },
        setWhere: sql`${table.throughSeq} is null or ${table.throughSeq} <= excluded.through_seq`,
      });
  });
}

/** Whether a stored row is the embedder's vector of this or newer metadata. */
function hasCurrentVector(
  embedder: PluginEmbedder,
  throughSeq: AnyColumn | number,
): SQL | undefined {
  const table = juniorConversationEmbeddings;
  return and(
    eq(table.provider, embedder.provider),
    eq(table.model, embedder.model),
    sql`${table.throughSeq} >= ${throughSeq}`,
  );
}

/**
 * Store the Conversation embedding of stored Conversation metadata. Skip it
 * when the Conversation already has a vector of the embedder's model for this
 * or newer metadata, so a task retry embeds once.
 */
export async function storeConversationEmbedding(
  db: JuniorDatabase,
  embedder: PluginEmbedder,
  args: { conversationId: string; metadata: ConversationMetadata },
): Promise<void> {
  const { summary, throughSeq, title } = args.metadata;
  if (throughSeq === undefined || !summary?.trim()) {
    return;
  }
  const table = juniorConversationEmbeddings;
  const [current] = await db
    .select({ conversationId: table.conversationId })
    .from(table)
    .where(
      and(
        eq(table.conversationId, args.conversationId),
        hasCurrentVector(embedder, throughSeq),
      ),
    )
    .limit(1);
  if (current) {
    return;
  }
  const text = metadataText(title, summary);
  const embedding = await embedText(embedder, { inputType: "document", text });
  await writeConversationEmbeddings(
    db,
    [
      {
        item: { conversationId: args.conversationId, text, throughSeq },
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
 * Embed the metadata of each Conversation that has no vector of the
 * embedder's model for it, in Conversation id order. Return whether no such
 * Conversation was left, and how many it embedded.
 */
export async function backfillConversationEmbeddings(args: {
  db: JuniorDatabase;
  deadlineMs: number;
  embedder: PluginEmbedder;
}) {
  const conversations = juniorConversations;
  const embeddings = juniorConversationEmbeddings;
  return await refreshEmbeddings<MetadataItem>({
    batchSize: BACKFILL_BATCH_SIZE,
    deadlineMs: args.deadlineMs,
    embedder: args.embedder,
    listMissing: async ({ after, limit }) => {
      const rows = await args.db
        .select({
          conversationId: conversations.conversationId,
          summary: conversations.summary,
          throughSeq: conversations.metadataThroughSeq,
          title: conversations.title,
        })
        .from(conversations)
        .leftJoin(
          embeddings,
          and(
            eq(embeddings.conversationId, conversations.conversationId),
            hasCurrentVector(args.embedder, conversations.metadataThroughSeq),
          ),
        )
        .where(
          and(
            isNotNull(conversations.summary),
            isNotNull(conversations.metadataThroughSeq),
            isNull(embeddings.conversationId),
            after
              ? gt(conversations.conversationId, after.conversationId)
              : undefined,
          ),
        )
        .orderBy(asc(conversations.conversationId))
        .limit(limit);
      return rows.flatMap((row) =>
        row.summary && row.throughSeq !== null
          ? [
              {
                conversationId: row.conversationId,
                text: metadataText(row.title, row.summary),
                throughSeq: row.throughSeq,
              },
            ]
          : [],
      );
    },
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
