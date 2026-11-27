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
  exists,
  gte,
  ilike,
  inArray,
  isNull,
  lt,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { JuniorDatabase } from "@/db/db";
import type * as z from "zod";
import type { PluginEmbedder } from "@sentry/junior-plugin-api";
import {
  conversationSimilarity,
  embedConversationQuery,
} from "@/chat/conversations/embedding";
import { conversationSearchVector } from "@/chat/conversations/metadata/store";
import { loadAnnotationLabeler } from "@/chat/conversations/annotation-labels";
import { listConversationAnnotationsById } from "@/chat/plugins/annotations";
import {
  hasMatchingAnnotation,
  treeHasMatchingAnnotation,
  type AnnotationFilter,
} from "@/chat/conversations/sql/annotation-filter";
import type {
  ConversationKind,
  ConversationStatus,
} from "@/chat/conversations/store";
import {
  juniorConversationEmbeddings,
  juniorConversationParticipants,
  juniorConversations,
  juniorDestinations,
} from "@/db/schema";
import { isPublicConversation } from "@/chat/conversations/sql/privacy";

const MAX_LINKS = 5;
// Lowest cosine similarity that admits a Conversation with no word match.
// Not tuned yet. Memory recall admits short memories at 0.55 with the same
// default model (`openai/text-embedding-3-small`). A summary is a longer
// document, so a short query scores lower against it. Retune it when the
// embedding model changes.
const MIN_VECTOR_SIMILARITY = 0.4;

/** One linked resource of a search result. */
export interface ConversationSearchLink {
  label: string;
  url: string;
}

/** One Conversation that the requester may find. */
export interface ConversationSearchResult {
  /** The Conversation is archived, for everyone. */
  archived: boolean;
  /** Provider display name of the Destination, such as a Slack channel name. */
  channelName?: string;
  conversationId: string;
  /** Matching title or summary text for a query. */
  excerpt?: string;
  kind?: ConversationKind;
  /** Top linked resources, such as pull requests, of the Conversation tree. */
  links: ConversationSearchLink[];
  /** Provider Destination id, such as a Slack channel id. */
  providerDestinationId?: string;
  rootConversationId: string;
  status: ConversationStatus;
  /** A new Conversation has none until its first Turn completes. */
  summary?: string;
  title?: string;
  /** Its transcript is purged. Only the summary and title remain. */
  transcriptPurged: boolean;
  updatedAtMs: number;
}

/** Provider-owned channel filter and match details for Conversation search. */
export interface ConversationSearchChannelPort {
  channelFilterSchema: z.ZodString;
  /**
   * Describe the provider channel of a match. `includeUrl` asks for the
   * provider thread link, for when there is no dashboard link.
   */
  describeMatch(
    match: ConversationSearchResult,
    options: { includeUrl: boolean },
  ): Promise<{
    channel_id?: string;
    channel_name?: string;
    url?: string;
  }>;
  resolveChannel(input: string): Promise<string>;
}

/** Filters for one Conversation search. All are optional. */
export interface ConversationSearch {
  /** Only Conversations with activity at or after this time. */
  afterMs?: number;
  /** Only Conversations with an Annotation of these objects. */
  annotation?: AnnotationFilter;
  /**
   * Match `annotation` only on the Conversation itself. Without it, a root
   * also matches when one of its child agents has the Annotation.
   */
  annotationOnSelf?: boolean;
  /** Only Conversations with activity before this time. */
  beforeMs?: number;
  /** Provider Destination id of the root, such as a Slack channel id. */
  channelId?: string;
  conversationIds?: readonly string[];
  /** Include archived Conversations. */
  includeArchived: boolean;
  limit: number;
  /** Words or meaning to match in the title or summary. */
  query?: string;
  /**
   * Return only root Conversations, not their child agents. With `team`,
   * the requester's own tree still returns its child agents.
   */
  rootsOnly: boolean;
  /**
   * Also search the requester's own tree, except the requester, and rank
   * it first. Then rank the Conversations where this person is a
   * Participant.
   */
  team?: { personUserId?: string | undefined };
  /** Only Conversations whose root has this User as a Participant. */
  participantUserId?: string;
  /** Only Conversations whose agent has one of these statuses. */
  statuses?: readonly ConversationStatus[];
}

/**
 * Search the Conversations, outside the requester's own tree unless
 * `team` is set, that the requester may find. Newest activity first, or best match for a query.
 * With an embedder, a query also matches by the meaning of the Conversation
 * metadata, and a match by meaning alone needs `MIN_VECTOR_SIMILARITY`.
 */
export async function searchConversations(
  db: JuniorDatabase,
  args: {
    embedder?: PluginEmbedder;
    requesterConversationId: string;
    search: ConversationSearch;
  },
): Promise<ConversationSearchResult[]> {
  const { embedder, requesterConversationId, search } = args;
  const conversations = juniorConversations;
  const roots = alias(juniorConversations, "target_roots");
  const requesterRoot = alias(juniorConversations, "requester_roots");
  const embeddings = juniorConversationEmbeddings;
  const query = search.query?.trim() || undefined;
  const queryVector =
    query && embedder
      ? await embedConversationQuery(embedder, query)
      : undefined;
  // SQL null for a stale vector or a vector of another model.
  const similarity = queryVector
    ? conversationSimilarity(queryVector)
    : undefined;
  const tsquery = sql`websearch_to_tsquery('english', ${query ?? ""})`;
  const searchVector = conversationSearchVector;
  // A child requester searches with the access of its root, and its own
  // tree is never a result.
  const [requester] = await db
    .select({ rootId: conversations.rootConversationId })
    .from(conversations)
    .where(eq(conversations.conversationId, requesterConversationId))
    .limit(1);
  const requesterRootId = requester?.rootId ?? requesterConversationId;
  const ownTree = eq(conversations.rootConversationId, requesterRootId);
  const participates = (userId: string) =>
    exists(
      db
        .select({ one: sql`1` })
        .from(juniorConversationParticipants)
        .where(
          and(
            eq(
              juniorConversationParticipants.rootConversationId,
              roots.conversationId,
            ),
            eq(juniorConversationParticipants.userId, userId),
          ),
        ),
    );
  const { team } = search;
  const conditions: (SQL | undefined)[] = [
    // Lists hide an unkept Quick question and its children.
    isNull(roots.quickQuestionAt),
    isNull(conversations.quickQuestionAt),
    search.rootsOnly
      ? or(
          eq(conversations.conversationId, conversations.rootConversationId),
          team ? ownTree : undefined,
        )
      : undefined,
    team
      ? ne(conversations.conversationId, requesterConversationId)
      : ne(conversations.rootConversationId, requesterRootId),
    or(
      isPublicConversation(conversations),
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
          // A root matches when any Conversation in its tree has the
          // Annotation.
          search.annotationOnSelf
            ? undefined
            : treeHasMatchingAnnotation(
                conversations.conversationId,
                search.annotation,
              ),
          hasMatchingAnnotation(
            conversations.conversationId,
            search.annotation,
          ),
        )
      : undefined,
    search.statuses
      ? inArray(conversations.executionStatus, [...search.statuses])
      : undefined,
    search.participantUserId
      ? participates(search.participantUserId)
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
  const teamRank = team
    ? [
        desc(
          sql`case when ${ownTree} then 2 when ${team.personUserId ? participates(team.personUserId) : sql`false`} then 1 else 0 end`,
        ),
      ]
    : [];
  const order = query
    ? [
        ...teamRank,
        desc(
          similarity ? sql`${wordRank} + coalesce(${similarity}, 0)` : wordRank,
        ),
        newestFirst,
      ]
    : [...teamRank, newestFirst];
  const excerpt = query
    ? sql<
        string | null
      >`ts_headline('english', coalesce(${conversations.summary}, ''), ${tsquery}, 'MaxFragments=2, MinWords=8, MaxWords=40, FragmentDelimiter=" … ", StartSel=**, StopSel=**')`
    : sql<string | null>`null`;
  const rows = await db
    .select({
      archivedAt: conversations.archivedAt,
      rootArchivedAt: roots.archivedAt,
      channelName: juniorDestinations.displayName,
      conversationId: conversations.conversationId,
      excerpt: excerpt.as("excerpt"),
      kind: conversations.kind,
      lastActivityAt: conversations.lastActivityAt,
      providerDestinationId: juniorDestinations.providerDestinationId,
      rootConversationId: roots.conversationId,
      status: conversations.executionStatus,
      summary: conversations.summary,
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
    // Only the vector of the current metadata counts.
    .leftJoin(
      embeddings,
      and(
        eq(embeddings.conversationId, conversations.conversationId),
        eq(embeddings.throughSeq, conversations.metadataThroughSeq),
      ),
    )
    .where(and(...conditions))
    .orderBy(...order)
    .limit(search.limit);

  const annotations = await listConversationAnnotationsById(
    db,
    rows.map((row) => row.conversationId),
  );
  const label = await loadAnnotationLabeler();
  return rows.map((row) => {
    const links = (annotations.get(row.conversationId) ?? [])
      .flatMap(({ url, ...annotation }) =>
        url ? [{ label: label({ ...annotation, url }), url }] : [],
      )
      .slice(0, MAX_LINKS);
    return {
      archived: row.archivedAt !== null || row.rootArchivedAt !== null,
      ...(row.channelName ? { channelName: row.channelName } : undefined),
      conversationId: row.conversationId,
      ...(row.excerpt ? { excerpt: row.excerpt } : undefined),
      ...(row.kind ? { kind: row.kind } : undefined),
      links,
      ...(row.providerDestinationId
        ? { providerDestinationId: row.providerDestinationId }
        : undefined),
      rootConversationId: row.rootConversationId,
      status: row.status,
      ...(row.summary ? { summary: row.summary } : undefined),
      ...(row.title ? { title: row.title } : undefined),
      transcriptPurged: row.transcriptPurgedAt !== null,
      updatedAtMs: row.lastActivityAt.getTime(),
    };
  });
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}
