import {
  and,
  desc,
  eq,
  gt,
  gte,
  isNull,
  lt,
  ne,
  notExists,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { JuniorDatabase } from "@/db/db";
import {
  juniorConversationAnnotations,
  juniorConversationBriefs,
  juniorConversations,
  juniorDestinations,
} from "@/db/schema";
import {
  conversationBriefSchema,
  type BriefLink,
  type BriefOutcomeStatus,
} from "./schema";

/** One latest Brief match from a prior public Conversation. */
export interface ConversationBriefSearchResult {
  channelName?: string;
  conversationId: string;
  excerpt: string;
  links: BriefLink[];
  outcomeStatus: BriefOutcomeStatus;
  providerDestinationId?: string;
  summary: string;
  title?: string;
  updatedAtMs: number;
  version: number;
}

/** Public scope available to one Conversation Brief search. */
export type ConversationBriefSearchScope =
  | {
      kind: "public_provider_tenant";
      provider: "slack";
      providerTenantId: string;
    }
  | { kind: "public" };

/** Optional filters for latest public Brief search. */
export interface ConversationBriefSearchFilters {
  /** Only Briefs updated at or after this time. */
  afterMs?: number;
  /** Annotation key, matched case-insensitively. Nested keys may continue with `#`. */
  annotation?: string;
  /** Only Briefs updated before this time. */
  beforeMs?: number;
  /** Provider destination id, available for provider-tenant search. */
  channelId?: string;
  /** Full-text query over indexed Brief content. */
  query?: string;
  /** Current outcome status. */
  status?: BriefOutcomeStatus;
}

/** Search the latest Brief of each public root Conversation in one scope. */
export async function searchConversationBriefs(
  db: JuniorDatabase,
  args: {
    currentConversationId: string;
    filters: ConversationBriefSearchFilters;
    limit: number;
    scope: ConversationBriefSearchScope;
  },
): Promise<ConversationBriefSearchResult[]> {
  const query = args.filters.query?.trim() || undefined;
  const tsquery = query
    ? sql`websearch_to_tsquery('english', ${query})`
    : undefined;
  const briefs = juniorConversationBriefs;
  const newer = alias(juniorConversationBriefs, "newer_briefs");
  // Filter versions first so the search index can select candidates, then
  // keep a candidate only when no newer version exists.
  const searchVector = sql`to_tsvector('english', ${briefs.searchText})`;
  const rank = tsquery
    ? sql<number>`ts_rank_cd(${searchVector}, ${tsquery})`
    : sql<number>`1`;
  const excerpt = tsquery
    ? sql<string>`ts_headline('english', ${briefs.searchText}, ${tsquery}, 'MaxFragments=2, MinWords=8, MaxWords=40, FragmentDelimiter=" … ", StartSel=**, StopSel=**')`
    : sql<string>`${briefs.content}->>'summary'`;
  const outcomeStatus = sql<string>`${briefs.content}->'outcome'->>'status'`;

  const conditions: SQL[] = [
    notExists(
      db
        .select({ one: sql`1` })
        .from(newer)
        .where(
          and(
            eq(newer.conversationId, briefs.conversationId),
            gt(newer.version, briefs.version),
          ),
        ),
    ),
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
    conditions.push(sql`${searchVector} @@ ${tsquery}`);
  }
  if (args.filters.channelId) {
    conditions.push(
      eq(juniorDestinations.providerDestinationId, args.filters.channelId),
    );
  }
  if (args.filters.status) {
    conditions.push(sql`${outcomeStatus} = ${args.filters.status}`);
  }
  if (args.filters.afterMs !== undefined) {
    conditions.push(gte(briefs.createdAt, new Date(args.filters.afterMs)));
  }
  if (args.filters.beforeMs !== undefined) {
    conditions.push(lt(briefs.createdAt, new Date(args.filters.beforeMs)));
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
      content: briefs.content,
      conversationId: juniorConversations.conversationId,
      excerpt: excerpt.as("excerpt"),
      providerDestinationId: juniorDestinations.providerDestinationId,
      rank: rank.as("rank"),
      title: juniorConversations.title,
      updatedAt: briefs.createdAt,
      version: briefs.version,
    })
    .from(briefs)
    .innerJoin(
      juniorConversations,
      eq(juniorConversations.conversationId, briefs.conversationId),
    )
    .innerJoin(
      juniorDestinations,
      eq(juniorDestinations.id, juniorConversations.destinationId),
    )
    .where(and(...conditions))
    .orderBy(desc(rank), desc(briefs.createdAt))
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
