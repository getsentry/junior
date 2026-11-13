/**
 * Embedding of the latest Brief of each Conversation: a derived index for
 * semantic Conversation search. Vectors are stored per model. A search
 * compares only vectors of the same provider, model, and size as its query.
 */
import { eq, sql, type SQL } from "drizzle-orm";
import type { JuniorDatabase } from "@/db/db";
import { juniorConversationBriefEmbeddings } from "@/db/schema";
import { botConfig } from "@/chat/config";
import { embedTexts, type ConversationModelCost } from "@/chat/core-model";
import type { ConversationBriefVersion } from "./store";

// About 2,000 tokens, well inside the input limit of each supported model.
// Brief search text starts with the title, summary, intent, and outcome, so
// the cut drops only trailing facts and link labels.
const MAX_EMBEDDED_CHARS = 8_000;

/** One embedding vector and the model that made it. */
export interface BriefVector {
  model: string;
  provider: string;
  vector: number[];
}

/** Embed one text as a Brief document or as a search query. */
export type BriefEmbedder = (input: {
  inputType: "document" | "query";
  text: string;
}) => Promise<BriefVector>;

/** Create the Brief embedder that charges its cost to one Conversation. */
export function createBriefEmbedder(args: {
  cost: ConversationModelCost;
  operation: "brief_embedding" | "conversation_search_embedding";
}): BriefEmbedder {
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
 * Store the embedding of a stored Brief. Skip it when the Conversation
 * already has a vector for this or a newer Brief version, so a task retry
 * embeds once and an older Turn never replaces a newer vector.
 */
export async function storeBriefEmbedding(
  db: JuniorDatabase,
  embed: BriefEmbedder,
  brief: ConversationBriefVersion,
): Promise<void> {
  if (!brief.searchText) {
    return;
  }
  const table = juniorConversationBriefEmbeddings;
  const [current] = await db
    .select({ briefVersion: table.briefVersion })
    .from(table)
    .where(eq(table.conversationId, brief.conversationId))
    .limit(1);
  if (current && current.briefVersion >= brief.version) {
    return;
  }
  const embedding = await embed({
    inputType: "document",
    text: brief.searchText,
  });
  const row = {
    briefVersion: brief.version,
    dimensions: embedding.vector.length,
    embedding: embedding.vector,
    model: embedding.model,
    provider: embedding.provider,
  };
  await db
    .insert(table)
    .values({ conversationId: brief.conversationId, ...row })
    .onConflictDoUpdate({
      target: table.conversationId,
      set: { ...row, createdAt: sql`now()` },
      setWhere: sql`${table.briefVersion} < excluded.brief_version`,
    });
}

/**
 * Cosine similarity of the stored vector to a query vector. Null for a
 * vector of another model or size. CASE fixes the order, so Postgres never
 * compares vectors of different sizes, which fails.
 */
export function briefSimilarity(query: BriefVector): SQL<number | null> {
  const table = juniorConversationBriefEmbeddings;
  return sql<
    number | null
  >`CASE WHEN ${table.provider} = ${query.provider} AND ${table.model} = ${query.model} AND ${table.dimensions} = ${query.vector.length} THEN 1 - (${table.embedding} <=> ${JSON.stringify(query.vector)}::vector) END`;
}
