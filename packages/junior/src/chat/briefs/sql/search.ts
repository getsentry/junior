import { and, desc, eq, gte, isNull, lt, ne, sql, type SQL } from "drizzle-orm";
import type { JuniorSqlDatabase } from "@/db/db";
import {
  juniorConversationAnnotations,
  juniorConversationBriefs,
  juniorConversations,
  juniorDestinations,
} from "@/db/schema";
import { conversationBriefSchema } from "../brief";
import type {
  ConversationBriefSearchFilters,
  ConversationBriefSearchResult,
  ConversationBriefSearchScope,
  ConversationBriefSearchStore,
} from "../search";

class SqlConversationBriefSearchStore implements ConversationBriefSearchStore {
  constructor(private readonly executor: JuniorSqlDatabase) {}

  async search(args: {
    currentConversationId: string;
    filters: ConversationBriefSearchFilters;
    limit: number;
    scope: ConversationBriefSearchScope;
  }): Promise<ConversationBriefSearchResult[]> {
    const db = this.executor.db();
    const query = args.filters.query?.trim() || undefined;
    const tsquery = query
      ? sql`websearch_to_tsquery('english', ${query})`
      : undefined;
    const latestBriefs = db
      .selectDistinctOn([juniorConversationBriefs.conversationId], {
        content: juniorConversationBriefs.content,
        conversationId: juniorConversationBriefs.conversationId,
        createdAt: juniorConversationBriefs.createdAt,
        searchText: juniorConversationBriefs.searchText,
        version: juniorConversationBriefs.version,
      })
      .from(juniorConversationBriefs)
      .orderBy(
        juniorConversationBriefs.conversationId,
        desc(juniorConversationBriefs.version),
      )
      .as("latest_conversation_briefs");
    const rank = tsquery
      ? sql<number>`ts_rank_cd(to_tsvector('english', ${latestBriefs.searchText}), ${tsquery})`
      : sql<number>`1`;
    const excerpt = tsquery
      ? sql<string>`ts_headline('english', ${latestBriefs.searchText}, ${tsquery}, 'MaxFragments=2, MinWords=8, MaxWords=40, FragmentDelimiter=" … ", StartSel=**, StopSel=**')`
      : sql<string>`${latestBriefs.content}->>'summary'`;
    const outcomeStatus = sql<string>`${latestBriefs.content}->'outcome'->>'status'`;

    const conditions: SQL[] = [
      isNull(juniorConversations.parentConversationId),
      ne(juniorConversations.conversationId, args.currentConversationId),
      eq(juniorDestinations.visibility, "public"),
    ];
    if (args.scope.kind === "public_provider_tenant") {
      conditions.push(
        eq(juniorConversations.source, args.scope.provider),
        eq(juniorDestinations.provider, args.scope.provider),
        eq(juniorDestinations.providerTenantId, args.scope.providerTenantId),
      );
    }
    if (tsquery) {
      conditions.push(
        sql`to_tsvector('english', ${latestBriefs.searchText}) @@ ${tsquery}`,
      );
    }
    if (args.filters.channelId) {
      conditions.push(
        eq(juniorDestinations.providerDestinationId, args.filters.channelId),
      );
    }
    if (args.filters.status) {
      conditions.push(sql`${outcomeStatus} = ${args.filters.status}`);
    }
    if (
      args.filters.afterMs !== undefined &&
      Number.isFinite(args.filters.afterMs)
    ) {
      conditions.push(
        gte(latestBriefs.createdAt, new Date(args.filters.afterMs)),
      );
    }
    if (
      args.filters.beforeMs !== undefined &&
      Number.isFinite(args.filters.beforeMs)
    ) {
      conditions.push(
        lt(latestBriefs.createdAt, new Date(args.filters.beforeMs)),
      );
    }
    if (args.filters.annotation) {
      const annotation = args.filters.annotation.toLowerCase();
      const nestedAnnotationPrefix = `${annotation}#`;
      conditions.push(
        sql`exists (
          select 1
          from ${juniorConversationAnnotations}
          where ${and(
            eq(
              juniorConversationAnnotations.conversationId,
              juniorConversations.conversationId,
            ),
            sql`(
              lower(${juniorConversationAnnotations.key}) = ${annotation}
              or starts_with(
                lower(${juniorConversationAnnotations.key}),
                ${nestedAnnotationPrefix}
              )
            )`,
          )}
        )`,
      );
    }

    const rows = await db
      .select({
        channelName: juniorDestinations.displayName,
        content: latestBriefs.content,
        conversationId: juniorConversations.conversationId,
        excerpt: excerpt.as("excerpt"),
        providerDestinationId: juniorDestinations.providerDestinationId,
        rank: rank.as("rank"),
        title: juniorConversations.title,
        updatedAt: latestBriefs.createdAt,
        version: latestBriefs.version,
      })
      .from(latestBriefs)
      .innerJoin(
        juniorConversations,
        eq(juniorConversations.conversationId, latestBriefs.conversationId),
      )
      .innerJoin(
        juniorDestinations,
        eq(juniorDestinations.id, juniorConversations.destinationId),
      )
      .where(and(...conditions))
      .orderBy(desc(rank), desc(latestBriefs.createdAt))
      .limit(args.limit);

    return rows.map((row) => {
      const content = conversationBriefSchema.parse(row.content);
      return {
        conversationId: row.conversationId,
        excerpt: row.excerpt,
        links: content.links.slice(0, 5),
        outcomeStatus: content.outcome.status,
        providerDestinationId: row.providerDestinationId,
        summary: content.summary,
        updatedAtMs: row.updatedAt.getTime(),
        version: row.version,
        ...(row.channelName ? { channelName: row.channelName } : undefined),
        ...(row.title ? { title: row.title } : undefined),
      };
    });
  }
}

/** Create a SQL-backed latest public Brief search store. */
export function createSqlConversationBriefSearchStore(
  executor: JuniorSqlDatabase,
): ConversationBriefSearchStore {
  return new SqlConversationBriefSearchStore(executor);
}
