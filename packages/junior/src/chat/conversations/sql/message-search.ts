import { and, desc, eq, isNull, ne, sql, type SQL } from "drizzle-orm";
import type { JuniorSqlDatabase } from "@/db/db";
import {
  juniorConversationEvents,
  juniorConversations,
  juniorDestinations,
} from "@/db/schema";
import type {
  ConversationMessageSearchFilters,
  ConversationMessageSearchResult,
  ConversationMessageSearchScope,
  ConversationMessageSearchStore,
} from "../message-search";

const EXCERPT_WITHOUT_QUERY_CHARS = 240;

class SqlConversationMessageSearchStore implements ConversationMessageSearchStore {
  constructor(private readonly executor: JuniorSqlDatabase) {}

  async search(args: {
    currentConversationId: string;
    filters: ConversationMessageSearchFilters;
    limit: number;
    scope: ConversationMessageSearchScope;
  }): Promise<ConversationMessageSearchResult[]> {
    const db = this.executor.db();
    const query = args.filters.query?.trim() || undefined;
    const text = sql<string>`${juniorConversationEvents.payload}->>'text'`;
    const role = sql<
      ConversationMessageSearchResult["role"]
    >`${juniorConversationEvents.payload}->>'role'`;
    const messageId = sql<string>`${juniorConversationEvents.payload}->>'messageId'`;
    const authorUserId = sql<
      string | null
    >`${juniorConversationEvents.payload}->'meta'->'author'->>'userId'`;
    const tsquery = query
      ? sql`websearch_to_tsquery('english', ${query})`
      : undefined;
    const rank = tsquery
      ? sql<number>`ts_rank_cd(to_tsvector('english', ${text}), ${tsquery})`
      : sql<number>`1`;
    const excerpt = tsquery
      ? sql<string>`ts_headline('english', ${text}, ${tsquery}, 'MaxFragments=2, MinWords=8, MaxWords=40, FragmentDelimiter=" … ", StartSel=**, StopSel=**')`
      : sql<string>`left(${text}, ${EXCERPT_WITHOUT_QUERY_CHARS})`;

    const conditions: SQL[] = [
      eq(juniorConversations.source, "slack"),
      isNull(juniorConversations.parentConversationId),
      isNull(juniorConversations.transcriptPurgedAt),
      ne(juniorConversations.conversationId, args.currentConversationId),
      eq(juniorDestinations.provider, args.scope.provider),
      eq(juniorDestinations.providerTenantId, args.scope.providerTenantId),
      // Public destination visibility is the only cross-thread search boundary.
      eq(juniorDestinations.visibility, "public"),
      eq(juniorConversationEvents.type, "message"),
      sql`${role} in ('user', 'assistant')`,
    ];

    if (tsquery) {
      conditions.push(sql`to_tsvector('english', ${text}) @@ ${tsquery}`);
    }
    if (args.filters.channelId) {
      conditions.push(
        eq(juniorDestinations.providerDestinationId, args.filters.channelId),
      );
    }
    if (args.filters.authorUserId) {
      // Message author, not conversation actor / thread starter.
      conditions.push(eq(authorUserId, args.filters.authorUserId));
    }

    const bestPerConversation = db
      .selectDistinctOn([juniorConversations.conversationId], {
        authorUserId: authorUserId.as("author_user_id"),
        channelName: juniorDestinations.displayName,
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
      .where(and(...conditions))
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
        desc(bestPerConversation.messageCreatedAt),
      )
      .limit(args.limit);

    return rows.map((row) => ({
      conversationId: row.conversationId,
      excerpt: row.excerpt,
      messageCreatedAtMs: row.messageCreatedAt.getTime(),
      messageId: row.messageId,
      providerDestinationId: row.providerDestinationId,
      role: row.role,
      ...(row.authorUserId ? { authorUserId: row.authorUserId } : {}),
      ...(row.channelName ? { channelName: row.channelName } : {}),
    }));
  }
}

/** Create a SQL-backed public workspace conversation search store. */
export function createSqlConversationMessageSearchStore(
  executor: JuniorSqlDatabase,
): ConversationMessageSearchStore {
  return new SqlConversationMessageSearchStore(executor);
}
