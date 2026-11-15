/**
 * One embedding per Conversation: a derived index for semantic Conversation
 * search. Its text is the Conversation metadata: the title and summary.
 * Vectors are stored per model. A search compares only vectors of the same
 * provider, model, and size as its query.
 */
import { eq, sql, type SQL } from "drizzle-orm";
import type { JuniorDatabase } from "@/db/db";
import { juniorConversationEmbeddings } from "@/db/schema";
import { botConfig } from "@/chat/config";
import { embedTexts, type ConversationModelCost } from "@/chat/core-model";
import type { ConversationMetadata } from "@/chat/conversations/metadata/store";

// About 2,000 tokens, well inside the input limit of each supported model.
const MAX_EMBEDDED_CHARS = 8_000;

/** One embedding vector and the model that made it. */
export interface ConversationVector {
  model: string;
  provider: string;
  vector: number[];
}

/** Embed one text as a Conversation document or as a search query. */
export type ConversationEmbedder = (input: {
  inputType: "document" | "query";
  text: string;
}) => Promise<ConversationVector>;

/** Create the embedder that charges its cost to one Conversation. */
export function createConversationEmbedder(args: {
  cost: ConversationModelCost;
  operation: "conversation_embedding" | "conversation_search_embedding";
}): ConversationEmbedder {
  return async ({ inputType, text }) => {
    const result = await embedTexts({
      cost: args.cost,
      inputType,
      modelId: botConfig.embeddingModelId,
      operation: args.operation,
      texts: [text.slice(0, MAX_EMBEDDED_CHARS)],
    });
    const vector = result.vectors[0];
    if (!vector) {
      throw new Error("Embedding provider returned no vector");
    }
    return { model: result.model, provider: result.provider, vector };
  };
}

/**
 * Store the Conversation embedding of stored Conversation metadata. Skip it
 * when the Conversation already has a vector for this or newer metadata, so a
 * task retry embeds once and an older Turn never replaces a newer vector.
 */
export async function storeConversationEmbedding(
  db: JuniorDatabase,
  embed: ConversationEmbedder,
  args: { conversationId: string; metadata: ConversationMetadata },
): Promise<void> {
  const { summary, throughSeq, title } = args.metadata;
  if (throughSeq === undefined || !summary) {
    return;
  }
  const table = juniorConversationEmbeddings;
  const [current] = await db
    .select({ throughSeq: table.throughSeq })
    .from(table)
    .where(eq(table.conversationId, args.conversationId))
    .limit(1);
  if (current?.throughSeq != null && current.throughSeq >= throughSeq) {
    return;
  }
  const embedding = await embed({
    inputType: "document",
    text: title ? `${title}\n${summary}` : summary,
  });
  const row = {
    dimensions: embedding.vector.length,
    embedding: embedding.vector,
    legacyBriefVersion: null,
    model: embedding.model,
    provider: embedding.provider,
    throughSeq,
  };
  await db
    .insert(table)
    .values({ conversationId: args.conversationId, ...row })
    .onConflictDoUpdate({
      target: table.conversationId,
      set: { ...row, createdAt: sql`now()` },
      setWhere: sql`${table.throughSeq} is null or ${table.throughSeq} < excluded.through_seq`,
    });
}

/**
 * Cosine similarity of the stored vector to a query vector. Null for a
 * vector of another model or size. CASE fixes the order, so Postgres never
 * compares vectors of different sizes, which fails.
 */
export function conversationSimilarity(
  query: ConversationVector,
): SQL<number | null> {
  const table = juniorConversationEmbeddings;
  return sql<
    number | null
  >`CASE WHEN ${table.provider} = ${query.provider} AND ${table.model} = ${query.model} AND ${table.dimensions} = ${query.vector.length} THEN 1 - (${table.embedding} <=> ${JSON.stringify(query.vector)}::vector) END`;
}
