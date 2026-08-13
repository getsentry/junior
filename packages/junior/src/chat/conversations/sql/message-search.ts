import {
  and,
  desc,
  eq,
  gte,
  ilike,
  isNull,
  lt,
  ne,
  sql,
  type SQL,
} from "drizzle-orm";
import type { JuniorSqlDatabase } from "@/db/db";
import {
  juniorConversationAnnotations,
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

function escapeLikePrefix(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

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
    if (args.filters.activeAfterMs !== undefined) {
      conditions.push(
        gte(
          juniorConversations.lastActivityAt,
          new Date(args.filters.activeAfterMs),
        ),
      );
    }
    if (args.filters.activeBeforeMs !== undefined) {
      conditions.push(
        lt(
          juniorConversations.lastActivityAt,
          new Date(args.filters.activeBeforeMs),
        ),
      );
    }
    if (args.filters.annotationKeyPrefix) {
      const annotationConditions: SQL[] = [
        eq(
          juniorConversationAnnotations.conversationId,
          juniorConversations.conversationId,
        ),
        ilike(
          juniorConversationAnnotations.key,
          `${escapeLikePrefix(args.filters.annotationKeyPrefix)}%`,
        ),
      ];
      if (args.filters.annotationPlugin) {
        annotationConditions.push(
          eq(juniorConversationAnnotations.plugin, args.filters.annotationPlugin),
        );
      }
      conditions.push(
        sql`exists (
          select 1
          from ${juniorConversationAnnotations}
          where ${and(...annotationConditions)}
        )`,
      );
    }

    const bestPerConversation = db
      .selectDistinctOn([juniorConversations.conversationId], {
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
      ...(row.channelName ? { channelName: row.channelName } : {}),
    }));
  }
}

/** Create a SQL-backed public workspace message search store. */
export function createSqlConversationMessageSearchStore(
  executor: JuniorSqlDatabase,
): ConversationMessageSearchStore {
  return new SqlConversationMessageSearchStore(executor);
}
