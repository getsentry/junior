import type { User } from "@sentry/junior-plugin-api";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDb, getSqlExecutor } from "@/chat/db";
import type { JuniorDatabase } from "@/db/db";
import { listedConversation } from "@/chat/conversations/sql/listed";
import {
  juniorCodeChanges,
  juniorConversationAnnotations,
  juniorConversationBriefs,
  juniorConversationParticipants,
  juniorConversationReadPositions,
  juniorConversations,
  juniorDestinations,
  juniorIdentities,
  juniorUsers,
} from "@/db/schema";
import { resolveSlackTeamDomains } from "@/chat/slack/team-domain";
import { readAutomationTitlesByConversationId } from "@/chat/automations/execution-stats";
import { conversationSummaryFromStoredConversation } from "./projection";
import { readConversationAccessFromSql } from "./access";
import {
  conversationPinnedForUser,
  conversationViewerMarks,
  conversationHasParticipantUser,
  conversationIsMemberRoot,
  conversationIsNotUnsubscribedRoot,
  type ConversationMember,
} from "./membership";
import {
  conversationFromRecordRow,
  conversationRecordColumns,
  conversationRecordJoins,
} from "./record";
import { readFeedThreads } from "./threads";
import { readUnreadConversationIds, unreadReplySql } from "./unread";
import { conversationFeedSchema } from "../schema/conversation-feed";
import type { ConversationFeed } from "../schema/conversation-feed";
import {
  childAgentTotalsReport,
  readConversationTreeMetricsFromSql,
} from "./usage";
import { readConversationAuxiliaryCostsFromSql } from "./auxiliary-costs";
import { listConversationAnnotationsById } from "@/chat/plugins/annotations";
import { listConversationSidebarAnnotations } from "@/chat/plugins/conversation-sidebar";
import { listConversationWork } from "@/chat/plugins/unfinished-work";
import { listWaitingConversations } from "@/chat/review-items/store";
import { treeAwaitsAuthorization } from "@/chat/conversations/sql/authorization-wait";
import { lastMessageAtSql } from "@/chat/conversations/sql/last-message";
import { isConversationPriority } from "./priority";
import { readLastUserMessageAtByConversation } from "./user-message-activity";
import {
  latestMessageSeqQuery,
  readConversationActivityPreviews,
} from "./activity-preview";
import { readConversationFeedBriefs } from "./feed-brief";
import {
  decodeFeedCursor,
  encodeFeedCursor,
  rowsAfterFeedCursor,
  type FeedCursor,
} from "./feed-cursor";
import { readFirstHumanMessageTexts } from "./first-message";
import { attachActivityPreviewMentions } from "./mentions";
import { readConversationParticipants } from "./participants";

const CONVERSATION_FEED_LIMIT = 50;

type ConversationFeedMembership =
  | { kind: "viewer"; userId: string }
  | { kind: "actorEmail"; email: string };

function feedMember(filter: ConversationFeedMembership): ConversationMember {
  return filter.kind === "viewer"
    ? { userId: filter.userId }
    : { email: filter.email };
}

function conversationFeedMembershipFilter(
  status: "active" | "archived" | "all",
  filter: ConversationFeedMembership | undefined,
): SQL | undefined {
  if (!filter) return status === "archived" ? sql`false` : undefined;
  const member = feedMember(filter);
  return and(
    conversationIsMemberRoot(member),
    status === "archived"
      ? isNotNull(juniorConversations.archivedAt)
      : status === "all"
        ? undefined
        : // An unsubscribed person still finds the conversation in archived
          // and search results. Contract: `subscription.ts`.
          and(
            isNull(juniorConversations.archivedAt),
            conversationIsNotUnsubscribedRoot(member),
          ),
  );
}

/**
 * Keep root conversations linked to one code repository. A code change can
 * link a child conversation, so linked ids resolve to their root. Private
 * roots stay visible only to their members.
 */
function conversationCodeRepositoryFilter(
  repositoryId: string,
  viewerUserId: string | undefined,
): SQL | undefined {
  return and(
    sql<boolean>`${juniorConversations.conversationId} IN (
      SELECT coalesce(linked.root_conversation_id, linked.conversation_id)
      FROM ${juniorConversations} AS linked
      WHERE linked.conversation_id IN (
        SELECT unnest(${juniorCodeChanges.conversationIds})
        FROM ${juniorCodeChanges}
        WHERE ${juniorCodeChanges.repositoryId} = ${repositoryId}
      )
    )`,
    or(
      eq(juniorDestinations.visibility, "public"),
      viewerUserId ? conversationHasParticipantUser(viewerUserId) : undefined,
    ),
  );
}

async function conversationRows(
  db: JuniorDatabase,
  {
    after,
    codeRepository,
    conversationIds,
    filter,
    includePrivateBriefs = false,
    limit,
    query,
    status,
  }: {
    /** Read the rows after this position in feed order. */
    after?: FeedCursor;
    codeRepository?: { id: string; viewerUserId?: string };
    /** Read only these root conversations. */
    conversationIds?: string[];
    filter: ConversationFeedMembership | undefined;
    includePrivateBriefs?: boolean;
    limit: number;
    query?: string;
    status: "active" | "archived" | "all";
  },
) {
  // Pins sort first so an old pinned root stays inside the feed limit.
  const pinned =
    filter?.kind === "viewer" && status === "active"
      ? conversationPinnedForUser(filter.userId)
      : undefined;
  return db
    .select({
      ...conversationRecordColumns,
      // The row's place in feed order, for the next page's cursor. The text
      // keeps the full timestamp precision.
      feedPosition: sql<string>`${juniorConversations.lastActivityAt}::text`,
      feedPinned: pinned ? sql<boolean>`${pinned}` : sql<boolean>`false`,
      // A row with no stored time yet, from before the column, reads it
      // from its events. `coalesce` skips that read for every other row.
      lastMessageAt:
        sql<Date | null>`coalesce(${juniorConversations.lastMessageAt}, ${lastMessageAtSql(db)})`.mapWith(
          juniorConversations.lastMessageAt,
        ),
      // The feed row read shows the wait, so it needs no query of its own.
      awaitingAuthorization: treeAwaitsAuthorization(
        juniorConversations.conversationId,
      ),
    })
    .from(juniorConversations)
    .leftJoin(juniorDestinations, conversationRecordJoins.location)
    .leftJoin(juniorIdentities, conversationRecordJoins.identity)
    .leftJoin(juniorUsers, conversationRecordJoins.user)
    .where(
      and(
        listedConversation(),
        conversationFeedMembershipFilter(status, filter),
        conversationIds
          ? inArray(juniorConversations.conversationId, conversationIds)
          : undefined,
        after ? rowsAfterFeedCursor(after, pinned) : undefined,
        codeRepository
          ? conversationCodeRepositoryFilter(
              codeRepository.id,
              codeRepository.viewerUserId,
            )
          : undefined,
        query
          ? or(
              sql<boolean>`strpos(lower(coalesce(${juniorConversations.title}, '')), ${query}) > 0`,
              sql<boolean>`exists (
                select 1
                from ${juniorConversationBriefs}
                where ${juniorConversationBriefs.conversationId} = ${juniorConversations.conversationId}
                  and ${includePrivateBriefs ? sql`true` : eq(juniorDestinations.visibility, "public")}
                  and ${juniorConversationBriefs.version} = (
                    select max(${juniorConversationBriefs.version})
                    from ${juniorConversationBriefs}
                    where ${juniorConversationBriefs.conversationId} = ${juniorConversations.conversationId}
                  )
                  and to_tsvector('english', ${juniorConversationBriefs.searchText})
                    @@ websearch_to_tsquery('english', ${query})
              )`,
            )
          : undefined,
      ),
    )
    .orderBy(
      ...(pinned ? [desc(pinned)] : []),
      desc(juniorConversations.lastActivityAt),
      asc(juniorConversations.conversationId),
    )
    .limit(limit);
}

type FeedRow = Awaited<ReturnType<typeof conversationRows>>[number];

/**
 * Read the viewer's active conversations that wait on them but fall outside
 * the newest page. Needs you shows every conversation that waits on the
 * viewer, so an old one must come back to the feed.
 */
async function waitingRowsOutsidePage(
  db: JuniorDatabase,
  filter: ConversationFeedMembership & { kind: "viewer" },
  page: FeedRow[],
): Promise<FeedRow[]> {
  const loaded = new Set(page.map((row) => row.conversation.conversationId));
  const missing = (await listWaitingConversations(db, filter.userId))
    .map((waiting) => waiting.conversationId)
    .filter((conversationId) => !loaded.has(conversationId));
  if (missing.length === 0) return [];
  return await conversationRows(db, {
    conversationIds: missing,
    filter,
    includePrivateBriefs: true,
    limit: missing.length,
    status: "active",
  });
}

/** Feed rows show last activity only as an age in whole minutes. */
function shownActivityMinute(lastActivityAt: SQLWrapper) {
  return sql`date_trunc('minute', ${lastActivityAt})`;
}

const feedTree = alias(juniorConversations, "feed_tree");
const feedAnnotated = alias(juniorConversations, "feed_annotated");

/**
 * Return a query for a token that changes when the viewer's default feed
 * page can change. It reads the same newest page as the feed, so its cost
 * does not grow with the viewer's history. The token lists a short token
 * for each feed-row input as `name:token`, separated by spaces, so the
 * dashboard can record which inputs moved it.
 *
 * The token holds only what a feed row shows, so a Task's own writes do not
 * move it. Every Event of a live Turn moves `last_activity_at`, but a
 * running row shows its running state in place of the age, so the token
 * holds no activity for it. Other rows show an age in whole minutes, so the
 * token holds its minute. The end of the Turn moves the status.
 * The rows are in feed order, so a move that reorders them moves the token.
 * The newest Message of each role stands for the preview and participants.
 * The row shows only whether a reply is unread, so a scroll that moves the
 * read position does not move the token.
 * Threads and annotations show from the whole tree. Waiting roots outside
 * the page move the Review items token.
 */
export function conversationFeedVersionQuery(
  db: JuniorDatabase,
  userId: string,
) {
  const pin = juniorConversationParticipants;
  const read = juniorConversationReadPositions;
  const conversationId = juniorConversations.conversationId;
  // The fields of each nested Thread row. An archive anywhere in the tree
  // can hide Threads under it.
  const tree = db
    .select({
      version: sql<string>`concat_ws(':',
        count(*) filter (where ${feedTree.archivedAt} is not null),
        string_agg(concat_ws('/',
          ${feedTree.conversationId}, ${feedTree.title},
          ${feedTree.executionStatus}, ${feedTree.stoppedAt},
          ${shownActivityMinute(feedTree.lastActivityAt)}
        ), ',' order by ${feedTree.conversationId}) filter (
          where ${feedTree.kind} = 'thread' and ${feedTree.archivedAt} is null
        )
      )`,
    })
    .from(feedTree)
    .where(eq(feedTree.rootConversationId, conversationId));
  const annotations = db
    .select({
      version: sql<string>`concat_ws(':', count(*), max(${juniorConversationAnnotations.updatedAt}))`,
    })
    .from(juniorConversationAnnotations)
    .innerJoin(
      feedAnnotated,
      eq(
        feedAnnotated.conversationId,
        juniorConversationAnnotations.conversationId,
      ),
    )
    .where(eq(feedAnnotated.rootConversationId, conversationId));
  // Postgres runs the lookups below after the LIMIT, so once for each row
  // on the page.
  const page = db
    .select({
      conversationId,
      channelName: juniorConversations.channelName,
      executionStatus: juniorConversations.executionStatus,
      lastActivityAt: juniorConversations.lastActivityAt,
      pinnedAt: pin.pinnedAt,
      pinPosition: pin.pinPosition,
      stoppedAt: juniorConversations.stoppedAt,
      title: juniorConversations.title,
      // Every other status shows as running, as in `statusFromConversation`.
      activity: sql`case
        when ${juniorConversations.executionStatus} in ('idle', 'failed')
        then ${shownActivityMinute(juniorConversations.lastActivityAt)}
      end`.as("activity"),
      assistantSeq:
        sql<number>`(${latestMessageSeqQuery(db, "assistant", conversationId)})`.as(
          "assistant_seq",
        ),
      userSeq:
        sql<number>`(${latestMessageSeqQuery(db, "user", conversationId)})`.as(
          "user_seq",
        ),
      unread: unreadReplySql(db, userId, conversationId, read.lastReadSeq).as(
        "unread",
      ),
      threads: sql<string>`(${tree})`.as("threads"),
      annotations: sql<string>`(${annotations})`.as("annotations"),
    })
    .from(juniorConversations)
    .leftJoin(
      pin,
      and(eq(pin.rootConversationId, conversationId), eq(pin.userId, userId)),
    )
    .leftJoin(
      read,
      and(eq(read.conversationId, conversationId), eq(read.userId, userId)),
    )
    .where(
      and(
        listedConversation(),
        conversationFeedMembershipFilter("active", { kind: "viewer", userId }),
      ),
    )
    // The feed's order. The joined pin replaces its per-row pin lookup, which
    // makes the plan cost high enough to start JIT compilation.
    .orderBy(
      desc(isNotNull(pin.pinnedAt)),
      desc(juniorConversations.lastActivityAt),
      asc(conversationId),
    )
    .limit(CONVERSATION_FEED_LIMIT)
    .as("feed_page");
  const byRow = (...values: SQLWrapper[]) =>
    sql`string_agg(concat_ws('@', ${page.conversationId}, ${sql.join(values, sql`, `)}), ',' order by ${page.conversationId})`;
  // The feed-row inputs of the token, by name. Order holds the page's ids in
  // feed order. Each other input holds its values by id, so a reorder moves
  // only order.
  const inputs = {
    order: sql`string_agg(${page.conversationId}, ',' order by ${page.pinnedAt} is not null desc, ${page.lastActivityAt} desc, ${page.conversationId})`,
    pin: byRow(page.pinnedAt, page.pinPosition),
    title: byRow(page.title, page.channelName),
    status: byRow(page.executionStatus, page.stoppedAt),
    activity: byRow(page.activity),
    messages: byRow(page.assistantSeq, page.userSeq),
    unread: byRow(page.unread),
    threads: byRow(page.threads),
    annotations: byRow(page.annotations),
  };
  return db
    .select({
      version: sql<string>`concat_ws(' ', ${sql.join(
        Object.entries(inputs).map(
          ([name, input]) =>
            sql`${`${name}:`}::text || left(md5(coalesce(${input}, '')), 8)`,
        ),
        sql`, `,
      )})`,
    })
    .from(page);
}

/** Prefer the authenticated viewer; fall back to actor email membership. */
function conversationFeedFilter(options: {
  actorEmail?: string;
  viewer?: User;
}): ConversationFeedMembership | undefined {
  if (options.viewer) {
    return {
      kind: "viewer",
      userId: options.viewer.id,
    };
  }
  if (options.actorEmail) {
    return {
      kind: "actorEmail",
      email: options.actorEmail,
    };
  }
  return undefined;
}

/**
 * Build a bounded dashboard feed. Prefer the viewer user when present; otherwise
 * keep only roots linked to actorEmail before applying the limit. Membership is
 * root-actor ownership or a materialized participant row for that person.
 *
 * `codeRepositoryId` replaces membership with every root linked to that
 * repository's code changes. Private roots appear only for their members, and
 * per-person archive state does not hide rows.
 */
export async function readConversationFeedFromSql(
  options: {
    actorEmail?: string;
    codeRepositoryId?: string;
    /** The `nextCursor` of the page before. */
    cursor?: string;
    limit?: number;
    q?: string;
    status?: "active" | "archived";
    viewer?: User;
  } = {},
): Promise<ConversationFeed> {
  const nowMs = Date.now();
  const after = options.cursor ? decodeFeedCursor(options.cursor) : undefined;
  const limit = options.limit ?? CONVERSATION_FEED_LIMIT;
  const db = getDb();
  const filter = options.codeRepositoryId
    ? undefined
    : conversationFeedFilter(options);
  const query = options.q?.trim().toLowerCase() || undefined;
  const status =
    query || options.codeRepositoryId ? "all" : (options.status ?? "active");
  const rows = await conversationRows(db, {
    ...(after ? { after } : undefined),
    ...(options.codeRepositoryId
      ? {
          codeRepository: {
            id: options.codeRepositoryId,
            ...(options.viewer
              ? { viewerUserId: options.viewer.id }
              : undefined),
          },
        }
      : undefined),
    filter,
    includePrivateBriefs: filter?.kind === "viewer",
    limit,
    query,
    status,
  });
  // A full page may have more after it.
  const last = rows.length === limit ? rows.at(-1) : undefined;
  const nextCursor = last
    ? encodeFeedCursor({
        conversationId: last.conversation.conversationId,
        lastActivityAt: last.feedPosition,
        pinned: last.feedPinned,
      })
    : undefined;
  // The first page also holds what waits on the viewer, so later pages can
  // repeat one of those rows. The dashboard keeps one row per id.
  if (filter?.kind === "viewer" && status === "active" && !after) {
    rows.push(...(await waitingRowsOutsidePage(db, filter, rows)));
  }
  const conversations = rows.map((row) => conversationFromRecordRow(row));
  const conversationIds = conversations.map(
    (conversation) => conversation.conversationId,
  );
  const [
    accessByConversation,
    viewerMarksByConversation,
    annotationsByConversation,
    auxiliaryCostsByRoot,
    metricsByRoot,
    participantsByConversation,
    teamDomainByTeamId,
    {
      work: conversationWork,
      lastUserMessageAt: lastUserMessageAtByConversation,
    },
    activityPreviewByConversation,
    briefByConversation,
    automationTitleByConversation,
    firstHumanMessageTextByConversation,
    unreadConversationIds,
  ] = await Promise.all([
    readConversationAccessFromSql(db, conversationIds, options.viewer),
    conversationViewerMarks(
      db,
      conversationIds,
      filter ? feedMember(filter) : undefined,
    ),
    listConversationAnnotationsById(db, conversationIds),
    readConversationAuxiliaryCostsFromSql(db, conversationIds),
    readConversationTreeMetricsFromSql(db, conversationIds),
    readConversationParticipants(db, conversationIds),
    resolveSlackTeamDomains(
      conversations.flatMap((conversation) =>
        conversation.location?.provider === "slack"
          ? [conversation.location.teamId]
          : [],
      ),
    ),
    listConversationWork(conversationIds).then(async (work) => ({
      work,
      // Priority uses this time only for finished assigned work. Skip the
      // message scan for every other Conversation.
      lastUserMessageAt: await readLastUserMessageAtByConversation(
        db,
        work.assignedIds.filter(
          (conversationId) => work.finishedAtById[conversationId],
        ),
      ),
    })),
    readConversationActivityPreviews(db, conversationIds),
    readConversationFeedBriefs(db, conversationIds),
    readAutomationTitlesByConversationId(conversations),
    readFirstHumanMessageTexts(db, conversations),
    filter?.kind === "viewer"
      ? readUnreadConversationIds(db, conversationIds, filter.userId)
      : new Set<string>(),
  ]);
  const visibleActivityPreviews = await attachActivityPreviewMentions(
    getSqlExecutor(),
    new Map(
      [...activityPreviewByConversation].filter(
        ([conversationId]) =>
          accessByConversation.get(conversationId)?.canViewPrivateContent,
      ),
    ),
  );
  const visibleAnnotationsByConversation = new Map(
    conversationIds.map((conversationId) => [
      conversationId,
      accessByConversation.get(conversationId)?.canViewPrivateContent
        ? (annotationsByConversation.get(conversationId) ?? [])
        : [],
    ]),
  );
  const [sidebarAnnotationsByConversation, threadsByRoot] = await Promise.all([
    listConversationSidebarAnnotations(
      conversationIds,
      visibleAnnotationsByConversation,
    ),
    // A Thread shows only while its root is not archived.
    readFeedThreads(
      db,
      conversations
        .filter((conversation) => conversation.archivedAtMs === undefined)
        .map(({ conversationId }) => ({
          access: accessByConversation.get(conversationId),
          conversationId,
        })),
    ),
  ]);
  const assignedWork = new Set(conversationWork.assignedIds);
  const unfinishedWork = new Set(conversationWork.unfinishedIds);
  return {
    conversations: conversations.map((conversation, index) => {
      const row = rows[index]!;
      const access = accessByConversation.get(conversation.conversationId);
      const metrics = metricsByRoot.get(conversation.conversationId);
      const auxiliaryCosts = auxiliaryCostsByRoot.get(
        conversation.conversationId,
      );
      const childAgentTotals = childAgentTotalsReport(metrics, auxiliaryCosts);
      const summary = conversationSummaryFromStoredConversation({
        ...viewerMarksByConversation.get(conversation.conversationId),
        unreadReply: unreadConversationIds.has(conversation.conversationId),
        automationTitle: automationTitleByConversation.get(
          conversation.conversationId,
        ),
        conversation,
        access,
        auxiliaryCosts: auxiliaryCosts?.total,
        ...(childAgentTotals ? { childAgentTotals } : undefined),
        durationMs: metrics?.durationMs ?? row.conversation.durationMs,
        firstHumanMessageText: firstHumanMessageTextByConversation.get(
          conversation.conversationId,
        ),
        teamDomainByTeamId,
        ...(row.location?.visibility === "public"
          ? { locationId: row.location.id }
          : undefined),
        usage: metrics?.usage ?? row.conversation.usage ?? undefined,
      });
      const work = {
        ...(assignedWork.has(conversation.conversationId)
          ? { assignedWork: true as const }
          : undefined),
        ...(conversationWork.finishedAtById[conversation.conversationId]
          ? {
              finishedWorkAt:
                conversationWork.finishedAtById[conversation.conversationId],
            }
          : undefined),
        ...(unfinishedWork.has(conversation.conversationId)
          ? { unfinishedWork: true as const }
          : undefined),
      };
      const annotations = access?.canViewPrivateContent
        ? (annotationsByConversation.get(conversation.conversationId) ?? [])
        : [];
      const activityPreview = visibleActivityPreviews.get(
        conversation.conversationId,
      );
      // Like the preview, the Brief holds private content.
      const brief = access?.canViewPrivateContent
        ? briefByConversation.get(conversation.conversationId)
        : undefined;
      const participants = access?.canViewPrivateContent
        ? participantsByConversation.get(conversation.conversationId)
        : undefined;
      const threads = threadsByRoot.get(conversation.conversationId);
      const lastMessageAt = row.lastMessageAt?.toISOString();
      return {
        ...summary,
        ...work,
        ...(row.awaitingAuthorization
          ? { awaitingAuthorization: true as const }
          : undefined),
        ...(lastMessageAt ? { lastMessageAt } : undefined),
        ...(threads ? { threads } : undefined),
        ...(participants && participants.length > 0
          ? { participants }
          : undefined),
        ...(activityPreview ? { activityPreview } : undefined),
        ...(brief ? { brief } : undefined),
        ...(annotations.length > 0 ? { annotations } : undefined),
        ...(sidebarAnnotationsByConversation[conversation.conversationId]
          ? {
              sidebarAnnotations:
                sidebarAnnotationsByConversation[conversation.conversationId],
            }
          : undefined),
        isPriority: isConversationPriority(
          {
            lastSeenAt: summary.lastSeenAt,
            lastUserMessageAt: lastUserMessageAtByConversation.get(
              conversation.conversationId,
            ),
            ...work,
          },
          nowMs,
        ),
      };
    }),
    generatedAt: new Date(nowMs).toISOString(),
    ...(nextCursor ? { nextCursor } : undefined),
    source: "conversation_index",
  };
}

/**
 * Load a bounded feed with an optional viewer-primary linked-user filter.
 *
 * With `viewer` and without `codeRepositoryId`, the feed holds only root
 * Conversations that the viewer started or takes part in, for every `q` and
 * `status`. The `actorEmail` filter and `codeRepositoryId` give no such
 * guarantee, so they are not an authorization boundary.
 */
export async function readConversationFeed(
  options: {
    actorEmail?: string;
    codeRepositoryId?: string;
    cursor?: string;
    q?: string;
    status?: "active" | "archived";
    viewer?: User;
  } = {},
): Promise<ConversationFeed> {
  return conversationFeedSchema.parse(
    await readConversationFeedFromSql(options),
  );
}
