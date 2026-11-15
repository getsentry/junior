import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { JuniorDatabase } from "@/db/db";
import { juniorConversations } from "@/db/schema";
import { nextDetailVersion } from "@/chat/conversations/sql/detail-version";
import { resolveRootVisibility } from "@/chat/conversations/sql/privacy";
import type { ConversationOutcomeStatus } from "./schema";

/**
 * The word-search vector of a Conversation's title and summary. It matches
 * the expression of `junior_conversations_search_idx`, so searches use it.
 */
export const conversationSearchVector = sql`to_tsvector('english', coalesce(${juniorConversations.title}, '') || ' ' || coalesce(${juniorConversations.summary}, ''))`;

/** The stored Conversation metadata that a Turn may update. */
export type ConversationMetadata = {
  outcomeStatus?: ConversationOutcomeStatus;
  summary?: string;
  throughSeq?: number;
  title?: string;
};

/** Read the Conversation metadata of one Conversation. */
export async function readConversationMetadata(
  db: JuniorDatabase,
  conversationId: string,
): Promise<ConversationMetadata | undefined> {
  const [row] = await db
    .select({
      outcomeStatus: juniorConversations.outcomeStatus,
      summary: juniorConversations.summary,
      throughSeq: juniorConversations.metadataThroughSeq,
      title: juniorConversations.title,
    })
    .from(juniorConversations)
    .where(eq(juniorConversations.conversationId, conversationId))
    .limit(1);
  if (!row) return undefined;
  return {
    ...(row.outcomeStatus ? { outcomeStatus: row.outcomeStatus } : undefined),
    ...(row.summary ? { summary: row.summary } : undefined),
    ...(row.throughSeq !== null ? { throughSeq: row.throughSeq } : undefined),
    ...(row.title ? { title: row.title } : undefined),
  };
}

/**
 * Store the summary and outcome status that cover events through
 * `throughSeq`. Returns false when stored metadata already covers that event,
 * so a retry or an older Turn never replaces newer metadata.
 */
export async function writeConversationMetadata(
  db: JuniorDatabase,
  input: {
    conversationId: string;
    outcomeStatus: ConversationOutcomeStatus;
    summary: string;
    throughSeq: number;
  },
): Promise<boolean> {
  return await db.transaction(async (tx) => {
    const [conversation] = await tx
      .select({ transcriptPurgedAt: juniorConversations.transcriptPurgedAt })
      .from(juniorConversations)
      .where(eq(juniorConversations.conversationId, input.conversationId))
      .for("update");
    if (!conversation) {
      throw new Error(`Conversation ${input.conversationId} is unavailable`);
    }
    // Purge cleared the metadata of a private Conversation. A summary written
    // now would bring purged content back.
    if (conversation.transcriptPurgedAt) {
      const root = await resolveRootVisibility(
        { db: () => tx },
        input.conversationId,
      );
      if (root.visibility !== "public") {
        throw new Error(
          `Cannot store metadata for purged non-public Conversation ${input.conversationId}`,
        );
      }
    }
    const updated = await tx
      .update(juniorConversations)
      .set({
        detailVersion: nextDetailVersion,
        metadataThroughSeq: input.throughSeq,
        outcomeStatus: input.outcomeStatus,
        summary: input.summary,
      })
      .where(
        and(
          eq(juniorConversations.conversationId, input.conversationId),
          or(
            isNull(juniorConversations.metadataThroughSeq),
            lt(juniorConversations.metadataThroughSeq, input.throughSeq),
          ),
        ),
      )
      .returning({ conversationId: juniorConversations.conversationId });
    return updated.length > 0;
  });
}
