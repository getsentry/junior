/**
 * Search the top-level agents that one root Conversation may reach: root
 * Conversations allowed by `policies/conversation-access.md`. The SQL query
 * selects candidates, then `canAccessConversation` decides each one, so the
 * access rule has one owner.
 */
import type { User } from "@sentry/junior-plugin-api";
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
import {
  canAccessConversation,
  readConversationAccessFromSql,
} from "@/api/conversations/access";
import { conversationBriefSchema } from "@/chat/briefs/schema";
import { hasAnnotationKey } from "@/chat/conversations/sql/annotation-filter";
import type { ConversationStatus } from "@/chat/conversations/store";
import { getDb } from "@/chat/db";
import {
  juniorConversationBriefs,
  juniorConversationParticipants,
  juniorConversations,
  juniorDestinations,
  juniorIdentities,
} from "@/db/schema";

/** One top-level agent that the requester may read, find, and message. */
export interface TopLevelAgent {
  /** The viewer archived this Conversation. */
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
  /** Include Conversations that the person archived. */
  includeArchived: boolean;
  limit: number;
  /** Words to match in the latest Brief or the title. */
  query?: string;
}

/**
 * Search root Conversations that `requesterConversationId` may reach for
 * `viewer`, the person of the current Turn. Without a viewer, only public
 * Conversations match. Newest activity first, or best match for a query.
 */
export async function searchTopLevelAgents(args: {
  requesterConversationId: string;
  search: TopLevelAgentSearch;
  viewer?: User;
}): Promise<TopLevelAgent[]> {
  const { requesterConversationId, search, viewer } = args;
  const db = getDb();
  const requester = (
    await readConversationAccessFromSql(db, [requesterConversationId], viewer)
  ).get(requesterConversationId);
  if (!requester?.tenant || requester.visibility === null) {
    return [];
  }

  const briefs = juniorConversationBriefs;
  const newer = alias(juniorConversationBriefs, "newer_briefs");
  const query = search.query?.trim() || undefined;
  const tsquery = sql`websearch_to_tsquery('english', ${query ?? ""})`;
  const searchVector = sql`to_tsvector('english', ${briefs.searchText})`;
  const viewerEmail = viewer?.email.trim().toLowerCase() || undefined;

  // The access rule below decides. This filter only keeps the candidate
  // set small: public targets, or private targets that the viewer started.
  const ownedByViewer =
    viewer && requester.visibility !== "public"
      ? or(
          eq(juniorIdentities.userId, viewer.id),
          viewerEmail
            ? and(
                eq(juniorIdentities.emailVerified, true),
                eq(juniorIdentities.emailNormalized, viewerEmail),
              )
            : undefined,
        )
      : undefined;
  const conditions: (SQL | undefined)[] = [
    isNull(juniorConversations.parentConversationId),
    // An unkept Quick question is a private side thread.
    isNull(juniorConversations.quickQuestionAt),
    isNull(juniorConversations.transcriptPurgedAt),
    ne(juniorConversations.conversationId, requesterConversationId),
    eq(juniorDestinations.provider, requester.tenant.provider),
    eq(juniorDestinations.providerTenantId, requester.tenant.providerTenantId),
    ownedByViewer
      ? or(eq(juniorDestinations.visibility, "public"), ownedByViewer)
      : eq(juniorDestinations.visibility, "public"),
    search.annotation
      ? hasAnnotationKey(juniorConversations.conversationId, search.annotation)
      : undefined,
    search.conversationIds
      ? inArray(juniorConversations.conversationId, [...search.conversationIds])
      : undefined,
    viewer && !search.includeArchived
      ? isNull(juniorConversationParticipants.archivedAt)
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
  const rows = await db
    .select({
      archivedAt: juniorConversationParticipants.archivedAt,
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
      juniorIdentities,
      eq(juniorIdentities.id, juniorConversations.actorIdentityId),
    )
    .leftJoin(
      juniorConversationParticipants,
      and(
        eq(
          juniorConversationParticipants.rootConversationId,
          juniorConversations.conversationId,
        ),
        eq(juniorConversationParticipants.userId, viewer?.id ?? ""),
      ),
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

  const access = await readConversationAccessFromSql(
    db,
    rows.map((row) => row.conversationId),
    viewer,
  );
  return rows.flatMap((row) => {
    const target = access.get(row.conversationId);
    if (!target || !canAccessConversation({ requester, target })) {
      return [];
    }
    const brief = row.briefContent
      ? conversationBriefSchema.parse(row.briefContent)
      : undefined;
    return [
      {
        archived: row.archivedAt !== null,
        conversationId: row.conversationId,
        status: row.status,
        ...(brief ? { summary: brief.summary } : undefined),
        ...(row.title ? { title: row.title } : undefined),
        updatedAtMs: row.lastActivityAt.getTime(),
      },
    ];
  });
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}
