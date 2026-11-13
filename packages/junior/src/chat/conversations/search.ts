/**
 * Search the Conversations that one requester may find: Conversations whose
 * root is public, of any surface, and Conversations whose root is at the
 * Destination of the requester's root. No other private Conversation is
 * returned, so no result leaks private data into the requester. See
 * `policies/conversation-access.md`.
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
import { briefSimilarity, type BriefEmbedder } from "@/chat/briefs/embedding";
import {
  parseStoredBrief,
  type BriefLink,
  type BriefOutcomeStatus,
} from "@/chat/briefs/schema";
import {
  hasAnnotationKey,
  treeHasAnnotationKey,
} from "@/chat/conversations/sql/annotation-filter";
import type {
  ConversationKind,
  ConversationStatus,
} from "@/chat/conversations/store";
import {
  juniorConversationBriefEmbeddings,
  juniorConversationBriefs,
  juniorConversations,
  juniorDestinations,
} from "@/db/schema";

const MAX_LINKS = 5;
// Lowest cosine similarity that admits a Conversation with no word match.
// Not tuned yet. Memory recall admits short memories at 0.55 with the same
// default model (`openai/text-embedding-3-small`). A Brief is a longer
// document, so a short query scores lower against it. Retune it when the
// embedding model changes.
const MIN_VECTOR_SIMILARITY = 0.4;

/** One Conversation that the requester may find. */
export interface ConversationSearchResult {
  /** The Conversation is archived, for everyone. */
  archived: boolean;
  /** Provider display name of the Destination, such as a Slack channel name. */
  channelName?: string;
  conversationId: string;
  /** Matching Brief text for a query. */
  excerpt?: string;
  kind?: ConversationKind;
  /** Top links of the latest Brief. */
  links: BriefLink[];
  /** Outcome status of the latest Brief. */
  outcomeStatus?: BriefOutcomeStatus;
  /** Provider Destination id, such as a Slack channel id. */
  providerDestinationId?: string;
  rootConversationId: string;
  status: ConversationStatus;
  /** Summary of the latest Brief. A new Conversation may have none yet. */
  summary?: string;
  title?: string;
  /** Its transcript is purged. Only the Brief and title remain. */
  transcriptPurged: boolean;
  updatedAtMs: number;
}

/** Filters for one Conversation search. All are optional. */
export interface ConversationSearch {
  /** Only Conversations with activity at or after this time. */
  afterMs?: number;
  /** Annotation key, such as a pull request key. Nested keys continue with `#`. */
  annotation?: string;
  /** Only Conversations with activity before this time. */
  beforeMs?: number;
  /** Provider Destination id of the root, such as a Slack channel id. */
  channelId?: string;
  conversationIds?: readonly string[];
  /** Include archived Conversations. */
  includeArchived: boolean;
  limit: number;
  /** Outcome status of the latest Brief. */
  outcomeStatus?: BriefOutcomeStatus;
  /** Words or meaning to match in the latest Brief, or words in the title. */
  query?: string;
  /** Return only root Conversations, not their child agents. */
  rootsOnly: boolean;
}

/**
 * Search the Conversations, outside the requester's own tree, that the
 * requester may find. Newest activity first, or best match for a query.
 * With an embedder, a query also matches by the meaning of the latest
 * Brief, and a match by meaning alone needs `MIN_VECTOR_SIMILARITY`.
 */
export async function searchConversations(
  db: JuniorDatabase,
  args: {
    embedder?: BriefEmbedder;
    requesterConversationId: string;
    search: ConversationSearch;
  },
): Promise<ConversationSearchResult[]> {
  const { embedder, requesterConversationId, search } = args;
  const conversations = juniorConversations;
  const briefs = juniorConversationBriefs;
  const newer = alias(juniorConversationBriefs, "newer_briefs");
  const roots = alias(juniorConversations, "target_roots");
  const requesterRoot = alias(juniorConversations, "requester_roots");
  const embeddings = juniorConversationBriefEmbeddings;
  const query = search.query?.trim() || undefined;
  const queryVector =
    query && embedder
      ? await embedder({ inputType: "query", text: query })
      : undefined;
  // SQL null for a stale vector or a vector of another model.
  const similarity = queryVector ? briefSimilarity(queryVector) : undefined;
  const tsquery = sql`websearch_to_tsquery('english', ${query ?? ""})`;
  const searchVector = sql`to_tsvector('english', ${briefs.searchText})`;
  const outcomeStatus = sql<string>`${briefs.content}->'outcome'->>'status'`;
  // A child requester searches with the access of its root, and its own
  // tree is never a result.
  const [requester] = await db
    .select({ rootId: conversations.rootConversationId })
    .from(conversations)
    .where(eq(conversations.conversationId, requesterConversationId))
    .limit(1);
  const requesterRootId = requester?.rootId ?? requesterConversationId;
  const conditions: (SQL | undefined)[] = [
    // The root decides visibility. Lists hide an unkept Quick question and
    // its children.
    isNull(roots.quickQuestionAt),
    isNull(conversations.quickQuestionAt),
    search.rootsOnly
      ? eq(conversations.conversationId, conversations.rootConversationId)
      : undefined,
    ne(conversations.rootConversationId, requesterRootId),
    or(
      eq(juniorDestinations.visibility, "public"),
      // Conversations share a Destination only when they share an audience.
      eq(
        roots.destinationId,
        db
          .select({ destinationId: requesterRoot.destinationId })
          .from(requesterRoot)
          .where(eq(requesterRoot.conversationId, requesterRootId)),
      ),
    ),
    search.annotation
      ? or(
          // A root matches when any Conversation in its tree has the key.
          treeHasAnnotationKey(conversations.conversationId, search.annotation),
          hasAnnotationKey(conversations.conversationId, search.annotation),
        )
      : undefined,
    search.conversationIds
      ? inArray(conversations.conversationId, [...search.conversationIds])
      : undefined,
    // Auto-archive marks only the root, so a child agent is archived with it.
    search.includeArchived
      ? undefined
      : and(isNull(conversations.archivedAt), isNull(roots.archivedAt)),
    search.channelId
      ? eq(juniorDestinations.providerDestinationId, search.channelId)
      : undefined,
    search.outcomeStatus
      ? sql`${outcomeStatus} = ${search.outcomeStatus}`
      : undefined,
    search.afterMs !== undefined
      ? gte(conversations.lastActivityAt, new Date(search.afterMs))
      : undefined,
    search.beforeMs !== undefined
      ? lt(conversations.lastActivityAt, new Date(search.beforeMs))
      : undefined,
    query
      ? or(
          sql`${searchVector} @@ ${tsquery}`,
          ilike(conversations.title, `%${escapeLike(query)}%`),
          similarity
            ? sql`${similarity} >= ${MIN_VECTOR_SIMILARITY}`
            : undefined,
        )
      : undefined,
  ];

  const newestFirst = desc(conversations.lastActivityAt);
  // Normalization 32 maps the word rank to [0, 1), next to the similarity,
  // so a Conversation that matches both ways ranks first.
  const wordRank = sql`coalesce(ts_rank_cd(${searchVector}, ${tsquery}, 32), 0)`;
  const order = query
    ? [
        desc(
          similarity ? sql`${wordRank} + coalesce(${similarity}, 0)` : wordRank,
        ),
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
      archivedAt: conversations.archivedAt,
      rootArchivedAt: roots.archivedAt,
      briefContent: briefs.content,
      channelName: juniorDestinations.displayName,
      conversationId: conversations.conversationId,
      excerpt: excerpt.as("excerpt"),
      kind: conversations.kind,
      lastActivityAt: conversations.lastActivityAt,
      providerDestinationId: juniorDestinations.providerDestinationId,
      rootConversationId: roots.conversationId,
      status: conversations.executionStatus,
      title: conversations.title,
      transcriptPurgedAt: conversations.transcriptPurgedAt,
    })
    .from(conversations)
    .innerJoin(
      roots,
      eq(roots.conversationId, conversations.rootConversationId),
    )
    .innerJoin(
      juniorDestinations,
      eq(juniorDestinations.id, roots.destinationId),
    )
    .leftJoin(
      briefs,
      and(
        eq(briefs.conversationId, conversations.conversationId),
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
    // Only the vector of the latest Brief counts.
    .leftJoin(
      embeddings,
      and(
        eq(embeddings.conversationId, briefs.conversationId),
        eq(embeddings.briefVersion, briefs.version),
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
      archived: row.archivedAt !== null || row.rootArchivedAt !== null,
      ...(row.channelName ? { channelName: row.channelName } : undefined),
      conversationId: row.conversationId,
      ...(row.excerpt ? { excerpt: row.excerpt } : undefined),
      ...(row.kind ? { kind: row.kind } : undefined),
      links: brief?.links.slice(0, MAX_LINKS) ?? [],
      ...(brief ? { outcomeStatus: brief.outcome.status } : undefined),
      ...(row.providerDestinationId
        ? { providerDestinationId: row.providerDestinationId }
        : undefined),
      rootConversationId: row.rootConversationId,
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
