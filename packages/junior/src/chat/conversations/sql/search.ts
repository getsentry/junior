import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { JuniorSqlDatabase } from "@/db/db";
import {
  juniorConversationMessages,
  juniorConversations,
  juniorDestinations,
} from "@/db/schema";
import type {
  ConversationSearchResult,
  ConversationSearchScope,
  ConversationSearchStore,
} from "../search";

class SqlConversationSearchStore implements ConversationSearchStore {
  constructor(private readonly executor: JuniorSqlDatabase) {}

  async search(args: {
    currentConversationId: string;
    limit: number;
    query: string;
    scope: ConversationSearchScope;
  }): Promise<ConversationSearchResult[]> {
    const db = this.executor.db();
    const tsquery = sql`websearch_to_tsquery('english', ${args.query})`;
    const rank = sql<number>`ts_rank_cd(to_tsvector('english', ${juniorConversationMessages.text}), ${tsquery})`;
    const excerpt = sql<string>`ts_headline('english', ${juniorConversationMessages.text}, ${tsquery}, 'MaxFragments=2, MinWords=8, MaxWords=40, FragmentDelimiter=" … ", StartSel=**, StopSel=**')`;
    const role = sql<
      ConversationSearchResult["role"]
    >`${juniorConversationMessages.role}`;

    const bestPerConversation = db
      .selectDistinctOn([juniorConversations.conversationId], {
        conversationId: juniorConversations.conversationId,
        excerpt: excerpt.as("excerpt"),
        lastActivityAt: juniorConversations.lastActivityAt,
        messageCreatedAt: juniorConversationMessages.createdAt,
        messageId: juniorConversationMessages.messageId,
        providerDestinationId: juniorDestinations.providerDestinationId,
        rank: rank.as("rank"),
        role: role.as("role"),
      })
      .from(juniorConversationMessages)
      .innerJoin(
        juniorConversations,
        eq(
          juniorConversations.conversationId,
          juniorConversationMessages.conversationId,
        ),
      )
      .innerJoin(
        juniorDestinations,
        eq(juniorDestinations.id, juniorConversations.destinationId),
      )
      .where(
        and(
          eq(juniorConversations.source, "slack"),
          isNull(juniorConversations.parentConversationId),
          isNull(juniorConversations.transcriptPurgedAt),
          ne(juniorConversations.conversationId, args.currentConversationId),
          eq(juniorDestinations.provider, args.scope.provider),
          eq(juniorDestinations.providerTenantId, args.scope.providerTenantId),
          eq(juniorDestinations.visibility, "public"),
          inArray(juniorConversationMessages.role, ["user", "assistant"]),
          sql`to_tsvector('english', ${juniorConversationMessages.text}) @@ ${tsquery}`,
        ),
      )
      .orderBy(
        juniorConversations.conversationId,
        desc(rank),
        desc(juniorConversationMessages.createdAt),
      )
      .as("best_conversation_matches");

    const rows = await db
      .select()
      .from(bestPerConversation)
      .orderBy(
        desc(bestPerConversation.rank),
        desc(bestPerConversation.lastActivityAt),
      )
      .limit(args.limit);

    return rows.map((row) => ({
      conversationId: row.conversationId,
      excerpt: row.excerpt,
      messageCreatedAtMs: row.messageCreatedAt.getTime(),
      messageId: row.messageId,
      providerDestinationId: row.providerDestinationId,
      role: row.role,
    }));
  }
}

/** Create a SQL-backed public workspace conversation search store. */
export function createSqlConversationSearchStore(
  executor: JuniorSqlDatabase,
): ConversationSearchStore {
  return new SqlConversationSearchStore(executor);
}
