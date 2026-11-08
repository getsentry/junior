/**
 * Search the top-level agents that one root Conversation may find: public
 * root Conversations of any surface. Private Conversations are never
 * returned, so no result leaks private data into the requester.
 */
import {
  and,
  desc,
  eq,
  gt,
  ilike,
  inArray,
  isNull,
  ne,
  notExists,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { parseStoredBrief } from "@/chat/briefs/schema";
import { treeHasAnnotationKey } from "@/chat/conversations/sql/annotation-filter";
import type { ConversationStatus } from "@/chat/conversations/store";
import { getDb } from "@/chat/db";
import {
  juniorConversationBriefs,
  juniorConversations,
  juniorDestinations,
} from "@/db/schema";

/** One public top-level agent that the requester may find. */
export interface TopLevelAgent {
  /** The Conversation is archived, for everyone. */
  archived: boolean;
  conversationId: string;
  status: ConversationStatus;
  /** Summary of the latest Brief. A new Conversation may have none yet. */
  summary?: string;
  title?: string;
  updatedAtMs: number;
}

/** Filters for one top-level agent search. All are optional. */
export interface TopLevelAgentSearch {
  /** Annotation key, such as a pull request key. Nested keys continue with `#`. */
  annotation?: string;
  conversationIds?: readonly string[];
  /** Include archived Conversations. */
  includeArchived: boolean;
  limit: number;
  /** Words to match in the latest Brief or the title. */
  query?: string;
}

/**
 * Search public root Conversations other than `requesterConversationId`.
 * Newest activity first, or best match for a query.
 */
export async function searchTopLevelAgents(args: {
  requesterConversationId: string;
  search: TopLevelAgentSearch;
}): Promise<TopLevelAgent[]> {
  const { requesterConversationId, search } = args;
  const db = getDb();

  const briefs = juniorConversationBriefs;
  const newer = alias(juniorConversationBriefs, "newer_briefs");
  const query = search.query?.trim() || undefined;
  const tsquery = sql`websearch_to_tsquery('english', ${query ?? ""})`;
  const searchVector = sql`to_tsvector('english', ${briefs.searchText})`;
  const conditions: (SQL | undefined)[] = [
    isNull(juniorConversations.parentConversationId),
    // Only valid roots, so `limit` counts only real results.
    eq(
      juniorConversations.rootConversationId,
      juniorConversations.conversationId,
    ),
    // An unkept Quick question is a private side thread.
    isNull(juniorConversations.quickQuestionAt),
    isNull(juniorConversations.transcriptPurgedAt),
    ne(juniorConversations.conversationId, requesterConversationId),
    eq(juniorDestinations.visibility, "public"),
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
  const rows = await db
    .select({
      archivedAt: juniorConversations.archivedAt,
      briefContent: briefs.content,
      conversationId: juniorConversations.conversationId,
      lastActivityAt: juniorConversations.lastActivityAt,
      status: juniorConversations.executionStatus,
      title: juniorConversations.title,
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
      conversationId: row.conversationId,
      status: row.status,
      ...(brief ? { summary: brief.summary } : undefined),
      ...(row.title ? { title: row.title } : undefined),
      updatedAtMs: row.lastActivityAt.getTime(),
    };
  });
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}
