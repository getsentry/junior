import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";
import type { JuniorSqlDatabase } from "@/db/db";
import {
  juniorConversationEvents,
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
    const text = sql<string>`${juniorConversationEvents.payload}->>'text'`;
    const rank = sql<number>`ts_rank_cd(to_tsvector('english', ${text}), ${tsquery})`;
    const excerpt = sql<string>`ts_headline('english', ${text}, ${tsquery}, 'MaxFragments=2, MinWords=8, MaxWords=40, FragmentDelimiter=" … ", StartSel=**, StopSel=**')`;
    const role = sql<
      ConversationSearchResult["role"]
    >`${juniorConversationEvents.payload}->>'role'`;
    const messageId = sql<string>`${juniorConversationEvents.payload}->>'messageId'`;

    const bestPerConversation = db
      .selectDistinctOn([juniorConversations.conversationId], {
        conversationId: juniorConversations.conversationId,
        excerpt: excerpt.as("excerpt"),
        lastActivityAt: juniorConversations.lastActivityAt,
        messageCreatedAt: juniorConversationEvents.createdAt,
        messageId: messageId.as("message_id"),
        providerDestinationId: juniorDestinations.providerDestinationId,
        rank: rank.as("rank"),
        role: role.as("role"),
      })
      .from(juniorConversationEvents)
      .innerJoin(
        juniorConversations,
        eq(
          juniorConversations.conversationId,
          juniorConversationEvents.conversationId,
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
          eq(juniorConversationEvents.type, "message"),
          sql`${role} in ('user', 'assistant')`,
          sql`to_tsvector('english', ${text}) @@ ${tsquery}`,
        ),
      )
      .orderBy(
        juniorConversations.conversationId,
        desc(rank),
        desc(juniorConversationEvents.createdAt),
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
