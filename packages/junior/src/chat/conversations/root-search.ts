/**
 * Search the root Conversations that one requester may find: public roots of
 * any surface, and roots at the Destination of the requester's root. No other
 * private Conversation is returned, so no result leaks private data into the
 * requester. See `policies/conversation-access.md`.
 */
import {
  and,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNull,
  lt,
  ne,
  notExists,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { JuniorDatabase } from "@/db/db";
import {
  parseStoredBrief,
  type BriefLink,
  type BriefOutcomeStatus,
} from "@/chat/briefs/schema";
import { treeHasAnnotationKey } from "@/chat/conversations/sql/annotation-filter";
import { listedConversation } from "@/chat/conversations/sql/listed";
import type { ConversationStatus } from "@/chat/conversations/store";
import {
  juniorConversationBriefs,
  juniorConversations,
  juniorDestinations,
} from "@/db/schema";

const MAX_LINKS = 5;

/** One root Conversation that the requester may find. */
export interface RootConversation {
  /** The Conversation is archived, for everyone. */
  archived: boolean;
  /** Provider display name of the Destination, such as a Slack channel name. */
  channelName?: string;
  conversationId: string;
  /** Matching Brief text for a query, else the Brief summary. */
  excerpt?: string;
  /** Top links of the latest Brief. */
  links: BriefLink[];
  /** Outcome status of the latest Brief. */
  outcomeStatus?: BriefOutcomeStatus;
  /** Provider Destination id, such as a Slack channel id. */
  providerDestinationId?: string;
  status: ConversationStatus;
  /** Summary of the latest Brief. A new Conversation may have none yet. */
  summary?: string;
  title?: string;
  /** Its transcript is purged. Only the Brief and title remain. */
  transcriptPurged: boolean;
  updatedAtMs: number;
}

/** Filters for one root Conversation search. All are optional. */
export interface RootConversationSearch {
  /** Only roots with activity at or after this time. */
  afterMs?: number;
  /** Annotation key, such as a pull request key. Nested keys continue with `#`. */
  annotation?: string;
  /** Only roots with activity before this time. */
  beforeMs?: number;
  /** Provider Destination id, such as a Slack channel id. */
  channelId?: string;
  conversationIds?: readonly string[];
  /** Include archived Conversations. */
  includeArchived: boolean;
  limit: number;
  /** Outcome status of the latest Brief. */
  outcomeStatus?: BriefOutcomeStatus;
  /** Words to match in the latest Brief or the title. */
  query?: string;
}

/**
 * Search the root Conversations, outside the requester's own tree, that the
 * requester may find. Newest activity first, or best match for a query.
 */
export async function searchRootConversations(
  db: JuniorDatabase,
  args: {
    requesterConversationId: string;
    search: RootConversationSearch;
  },
): Promise<RootConversation[]> {
  const { requesterConversationId, search } = args;
  const briefs = juniorConversationBriefs;
  const newer = alias(juniorConversationBriefs, "newer_briefs");
  const requesterRoot = alias(juniorConversations, "requester_roots");
  const query = search.query?.trim() || undefined;
  const tsquery = sql`websearch_to_tsquery('english', ${query ?? ""})`;
  const searchVector = sql`to_tsvector('english', ${briefs.searchText})`;
  const outcomeStatus = sql<string>`${briefs.content}->'outcome'->>'status'`;
  // A child requester searches with the access of its root, and its own
  // tree is never a result.
  const [requester] = await db
    .select({ rootId: juniorConversations.rootConversationId })
    .from(juniorConversations)
    .where(eq(juniorConversations.conversationId, requesterConversationId))
    .limit(1);
  const requesterRootId = requester?.rootId ?? requesterConversationId;
  const conditions: (SQL | undefined)[] = [
    listedConversation(),
    // Only valid roots, so `limit` counts only real results.
    eq(
      juniorConversations.rootConversationId,
      juniorConversations.conversationId,
    ),
    ne(juniorConversations.conversationId, requesterRootId),
    or(
      eq(juniorDestinations.visibility, "public"),
      // Conversations share a Destination only when they share an audience.
      eq(
        juniorConversations.destinationId,
        db
          .select({ destinationId: requesterRoot.destinationId })
          .from(requesterRoot)
          .where(eq(requesterRoot.conversationId, requesterRootId)),
      ),
    ),
    search.annotation
      ? treeHasAnnotationKey(
          juniorConversations.conversationId,
          search.annotation,
        )
      : undefined,
    search.conversationIds
      ? inArray(juniorConversations.conversationId, [...search.conversationIds])
      : undefined,
    search.includeArchived ? undefined : isNull(juniorConversations.archivedAt),
    search.channelId
      ? eq(juniorDestinations.providerDestinationId, search.channelId)
      : undefined,
    search.outcomeStatus
      ? sql`${outcomeStatus} = ${search.outcomeStatus}`
      : undefined,
    search.afterMs !== undefined
      ? gte(juniorConversations.lastActivityAt, new Date(search.afterMs))
      : undefined,
    search.beforeMs !== undefined
      ? lt(juniorConversations.lastActivityAt, new Date(search.beforeMs))
      : undefined,
    query
      ? or(
          sql`${searchVector} @@ ${tsquery}`,
          ilike(juniorConversations.title, `%${escapeLike(query)}%`),
        )
      : undefined,
  ];

  const newestFirst = desc(juniorConversations.lastActivityAt);
  const order = query
    ? [
        desc(sql`coalesce(ts_rank_cd(${searchVector}, ${tsquery}), 0)`),
        newestFirst,
      ]
    : [newestFirst];
  const excerpt = query
    ? sql<
        string | null
      >`ts_headline('english', ${briefs.searchText}, ${tsquery}, 'MaxFragments=2, MinWords=8, MaxWords=40, FragmentDelimiter=" … ", StartSel=**, StopSel=**')`
    : sql<string | null>`null`;
  const rows = await db
    .select({
      archivedAt: juniorConversations.archivedAt,
      briefContent: briefs.content,
      channelName: juniorDestinations.displayName,
      conversationId: juniorConversations.conversationId,
      excerpt: excerpt.as("excerpt"),
      lastActivityAt: juniorConversations.lastActivityAt,
      providerDestinationId: juniorDestinations.providerDestinationId,
      status: juniorConversations.executionStatus,
      title: juniorConversations.title,
      transcriptPurgedAt: juniorConversations.transcriptPurgedAt,
    })
    .from(juniorConversations)
    .innerJoin(
      juniorDestinations,
      eq(juniorDestinations.id, juniorConversations.destinationId),
    )
    .leftJoin(
      briefs,
      and(
        eq(briefs.conversationId, juniorConversations.conversationId),
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
      ),
    )
    .where(and(...conditions))
    .orderBy(...order)
    .limit(search.limit);

  return rows.map((row) => {
    const brief = row.briefContent
      ? parseStoredBrief(row.briefContent)
      : undefined;
    return {
      archived: row.archivedAt !== null,
      ...(row.channelName ? { channelName: row.channelName } : undefined),
      conversationId: row.conversationId,
      ...(row.excerpt ? { excerpt: row.excerpt } : undefined),
      links: brief?.links.slice(0, MAX_LINKS) ?? [],
      ...(brief ? { outcomeStatus: brief.outcome.status } : undefined),
      ...(row.providerDestinationId
        ? { providerDestinationId: row.providerDestinationId }
        : undefined),
      status: row.status,
      ...(brief ? { summary: brief.summary } : undefined),
      ...(row.title ? { title: row.title } : undefined),
      transcriptPurged: row.transcriptPurgedAt !== null,
      updatedAtMs: row.lastActivityAt.getTime(),
    };
  });
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}
