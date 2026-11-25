import type { User } from "@sentry/junior-plugin-api";
import {
  and,
  asc,
  desc,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  not,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";
import { alias, type AnyPgColumn } from "drizzle-orm/pg-core";
import { getDb, getSqlExecutor } from "@/chat/db";
import type { JuniorDatabase } from "@/db/db";
import { listedConversation } from "@/chat/conversations/sql/listed";
import {
  juniorCodeChanges,
  juniorConversationAnnotations,
  juniorConversationParticipants,
  juniorConversations,
  juniorDestinations,
  juniorIdentities,
  juniorInboxItems,
  juniorUsers,
} from "@/db/schema";
import {
  inboxItemNeedsInput,
  inboxItemOwnedByConversation,
} from "@/chat/inbox-items/access";
import { resolveSlackTeamDomains } from "@/chat/slack/team-domain";
import { readAutomationTitlesByConversationId } from "@/chat/automations/execution-stats";
import { conversationSummaryFromStoredConversation } from "./projection";
import {
  conversationAccessFromRows,
  readConversationAccessRows,
  readPrivateSpaceMemberships,
} from "./access";
import {
  conversationPinnedForUser,
  conversationIsMemberRoot,
  rootSpaceReadableBy,
  conversationIsNotUnsubscribedRoot,
  type ConversationMember,
  readMemberParticipants,
  rootVisibleToViewer,
} from "./membership";
import {
  conversationFromRecordRow,
  conversationRecordColumns,
  conversationRecordJoins,
} from "./record";
import {
  conversationIsActiveSql,
  conversationTurnFailedSql,
} from "@/chat/conversations/sql/status";
import { nestFeedThreads, readFeedThreadRecords } from "./threads";
import {
  CONVERSATION_FEED_WAITING_LIMIT,
  type ConversationFeed,
  type ConversationFeedInclude,
} from "../schema/conversation-feed";
import {
  childAgentTotalsReport,
  readConversationTreeMetricsFromSql,
} from "./usage";
import { readConversationAuxiliaryCostsFromSql } from "./auxiliary-costs";
import { listConversationAnnotationsById } from "@/chat/plugins/annotations";
import { listConversationSidebarAnnotations } from "@/chat/plugins/conversation-sidebar";
import { listConversationWork } from "@/chat/plugins/unfinished-work";
import { readConversationTrees } from "@/chat/conversations/sql/conversation-tree";
import { waitingConversationIdsQuery } from "@/chat/inbox-items/waiting";
import {
  hasUnexpiredAuthorizationRequest,
  treeAwaitsAuthorization,
} from "@/chat/conversations/sql/authorization-wait";
import { lastMessageAtSql } from "@/chat/conversations/sql/last-message";
import { isConversationPriority } from "./priority";
import { readSpaceRefs } from "@/chat/spaces/conversations";
import { readLastUserMessageAtByConversation } from "./user-message-activity";
import {
  latestMessageSeqQuery,
  readConversationActivityPreviews,
} from "./activity-preview";
import { conversationSearchVector } from "@/chat/conversations/metadata/store";
import { annotationUrls, feedLinksSql, pickFeedLinks } from "./feed-links";
import { feedMediaSql } from "./feed-media";
import { feedViewerAnswer, feedViewerAnswerSql } from "./feed-answer";
import { readFirstHumanMessageTexts } from "./first-message";
import { readConversationTreeStates } from "./tree-state";
import { attachActivityPreviewMentions } from "./mentions";
import { conversationSlackTenantId } from "@/chat/conversations/sql/event-actor";
import { readConversationParticipants } from "./participants";
import {
  decodeConversationFeedCursor,
  encodeConversationFeedCursor,
  type ConversationFeedCursor,
} from "./feed-cursor";
import { isPublicConversation } from "@/chat/conversations/sql/privacy";

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
    rootSpaceReadableBy(member),
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
    rootVisibleToViewer(viewerUserId),
  );
}

/**
 * Keep the roots of one Space with the status that the viewer may find. A
 * private Space shows its roots only to its members.
 */
function conversationSpaceFilter(
  spaceId: string,
  status: "active" | "archived" | "all",
  viewerUserId: string | undefined,
): SQL | undefined {
  return and(
    eq(juniorConversations.spaceId, spaceId),
    status === "archived"
      ? isNotNull(juniorConversations.archivedAt)
      : status === "active"
        ? isNull(juniorConversations.archivedAt)
        : undefined,
    rootVisibleToViewer(viewerUserId),
  );
}

async function conversationRows(
  db: JuniorDatabase,
  {
    codeRepository,
    conversationIds,
    cursor,
    filter,
    include = [],
    includePrivateMatches = false,
    limit,
    pinnedForUserId,
    query,
    space,
    status,
    waitingForUserId,
  }: {
    codeRepository?: { id: string; viewerUserId?: string };
    /** Read only these root conversations. */
    conversationIds?: string[];
    /** Read only rows after this feed position. */
    cursor?: ConversationFeedCursor;
    filter: ConversationFeedMembership | undefined;
    /** Extra row content to read in the same statement. */
    include?: readonly ConversationFeedInclude[];
    includePrivateMatches?: boolean;
    limit?: number;
    /** Read only the rows that this user pinned (`true`) or did not pin. */
    pinnedForUserId?: { pinned: boolean; userId: string };
    query?: string | undefined;
    /** Read only the roots of this Space, in place of membership. */
    space?: { id: string; viewerUserId?: string };
    status: "active" | "archived" | "all";
    /** Read only the root conversations that wait on this user. */
    waitingForUserId?: string;
  },
) {
  const rows = db
    .select({
      ...conversationRecordColumns(),
      // Keep microseconds so the next page starts exactly after this row.
      activityCursor: sql<string>`to_char(${juniorConversations.lastActivityAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
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
      latestTurnFailed: conversationTurnFailedSql(juniorConversations),
      links: include.includes("links") ? feedLinksSql(db) : sql<null>`null`,
      media: include.includes("media") ? feedMediaSql(db) : sql<null>`null`,
      viewerAnswer:
        filter?.kind === "viewer"
          ? feedViewerAnswerSql(db, filter.userId)
          : sql<null>`null`,
    })
    .from(juniorConversations)
    .leftJoin(juniorDestinations, conversationRecordJoins.location)
    .leftJoin(juniorIdentities, conversationRecordJoins.identity)
    .leftJoin(juniorUsers, conversationRecordJoins.user)
    .where(
      and(
        listedConversation(),
        space
          ? conversationSpaceFilter(space.id, status, space.viewerUserId)
          : conversationFeedMembershipFilter(status, filter),
        conversationIds
          ? inArray(juniorConversations.conversationId, conversationIds)
          : undefined,
        waitingForUserId
          ? inArray(
              juniorConversations.conversationId,
              waitingConversationIdsQuery(db, waitingForUserId),
            )
          : undefined,
        pinnedForUserId
          ? pinnedForUserId.pinned
            ? conversationPinnedForUser(pinnedForUserId.userId)
            : not(conversationPinnedForUser(pinnedForUserId.userId))
          : undefined,
        // Match the sort below: newer activity first, then the smaller id.
        cursor
          ? sql<boolean>`(${juniorConversations.lastActivityAt} < ${cursor.at}::timestamptz or (${juniorConversations.lastActivityAt} = ${cursor.at}::timestamptz and ${juniorConversations.conversationId} > ${cursor.conversationId}))`
          : undefined,
        codeRepository
          ? conversationCodeRepositoryFilter(
              codeRepository.id,
              codeRepository.viewerUserId,
            )
          : undefined,
        query
          ? or(
              sql<boolean>`strpos(lower(coalesce(${juniorConversations.title}, '')), ${query}) > 0`,
              and(
                includePrivateMatches
                  ? undefined
                  : isPublicConversation(juniorConversations),
                sql<boolean>`${conversationSearchVector} @@ websearch_to_tsquery('english', ${query})`,
              ),
              annotationMatch(db, query, includePrivateMatches),
            )
          : undefined,
      ),
    )
    .orderBy(
      desc(juniorConversations.lastActivityAt),
      asc(juniorConversations.conversationId),
    )
    .$dynamic();
  return limit === undefined ? rows : rows.limit(limit);
}

const searchAnnotated = alias(juniorConversations, "search_annotated");

/**
 * Match a root whose tree has an Annotation with the text in its label or
 * title, such as `getsentry/roach#12`. The feed shows the annotations of
 * the whole tree, so search reads the same rows. Private annotations match
 * only where the feed shows them.
 */
function annotationMatch(
  db: JuniorDatabase,
  query: string,
  includePrivate: boolean,
) {
  const annotation = juniorConversationAnnotations.annotation;
  return exists(
    db
      .select({ one: sql`1` })
      .from(juniorConversationAnnotations)
      .innerJoin(
        searchAnnotated,
        eq(
          searchAnnotated.conversationId,
          juniorConversationAnnotations.conversationId,
        ),
      )
      .where(
        and(
          eq(
            searchAnnotated.rootConversationId,
            juniorConversations.conversationId,
          ),
          includePrivate
            ? undefined
            : isPublicConversation(juniorConversations),
          sql<boolean>`strpos(lower(concat_ws(' ', ${annotation}->>'label', ${annotation}->>'title')), ${query}) > 0`,
        ),
      ),
  );
}

/**
 * Feed rows show last activity only as an age in whole minutes. A running
 * row shows its running state in place of the age, so it shows no activity.
 * Every status but `idle` and `failed` shows as running, as in
 * `statusFromConversation`.
 */
function shownActivityMinute(
  executionStatus: SQLWrapper,
  lastActivityAt: SQLWrapper,
) {
  return sql`case
    when ${executionStatus} in ('idle', 'failed')
    then date_trunc('minute', ${lastActivityAt})
  end`;
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
 * Status and tree state come from stored watermarks, not from the rules
 * that derive them, so a poll reads no Events or read positions.
 * Each write that a status or the tree state reads moves `detail_version` on
 * its Conversation, so the token holds that version for each idle row and
 * tree member. Every Event of a live Turn moves it too, and a running row
 * shows its running state, so a running Conversation adds only that it runs
 * and the open Inbox items that it added. The end of the Turn writes
 * the row. Watches and Timers live outside SQL. A Turn makes or cancels one,
 * and the end of that Turn moves the version, so a read after it sees the
 * change. A Watch that expires on its own moves nothing, so its row shows
 * `watching` until the feed reads again. An authorization request expires
 * with no write, so the token counts the live ones.
 * Idle rows show an age in whole minutes, so the token holds that minute.
 * The rows are in feed order, so a move that reorders them moves the token.
 * The newest Message of each role stands for the preview and participants,
 * and moves the token during a live Turn. Waiting roots outside the page,
 * and the viewer's own Inbox items, move the Inbox items token.
 */
export function conversationFeedVersionQuery(
  db: JuniorDatabase,
  userId: string,
) {
  const pin = juniorConversationParticipants;
  const conversationId = juniorConversations.conversationId;
  // The open Inbox items that a running Conversation added. A take or a
  // reassign writes `updated_at`, and it changes whom the item waits on.
  const ownedItemsVersion = (conversation: AnyPgColumn) =>
    sql`(select concat(count(*), '/', max(${juniorInboxItems.updatedAt})) from ${juniorInboxItems} where ${and(
      inboxItemOwnedByConversation(conversation),
      inboxItemNeedsInput(),
    )})`;
  const rowState = (row: typeof juniorConversations) =>
    sql`case
      when ${conversationIsActiveSql(row)}
      then concat('active:', ${ownedItemsVersion(row.conversationId)})
      else ${row.detailVersion}::text
    end`;
  // The tree's members, and the state of each one but the root, which its
  // row holds. The tree counts the root's live authorization requests too.
  // A running Thread hides its version, but its row shows its title, which
  // a Turn can set, and an archive hides it, so the tree holds both.
  const child = sql`${feedTree.conversationId} <> ${conversationId}`;
  const active = conversationIsActiveSql(feedTree);
  const tree = db
    .select({
      version: sql<string>`concat_ws(':',
        count(*),
        sum(${feedTree.detailVersion}) filter (where ${child} and not ${active}),
        count(*) filter (where ${child} and ${active}),
        md5(string_agg(${ownedItemsVersion(feedTree.conversationId)}, ',' order by ${feedTree.conversationId}) filter (
          where ${child} and ${active}
        )),
        count(*) filter (where ${child} and ${active} and ${feedTree.archivedAt} is not null),
        md5(string_agg(${feedTree.title}, ',' order by ${feedTree.conversationId}) filter (
          where ${child} and ${active} and ${feedTree.kind} = 'root'
        )),
        count(*) filter (where ${hasUnexpiredAuthorizationRequest(feedTree.conversationId)})
      )`,
    })
    .from(feedTree)
    .where(
      or(
        eq(feedTree.conversationId, conversationId),
        eq(feedTree.rootConversationId, conversationId),
      ),
    );
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
      lastActivityAt: juniorConversations.lastActivityAt,
      pinnedAt: pin.pinnedAt,
      pinPosition: pin.pinPosition,
      state: rowState(juniorConversations).as("state"),
      title: juniorConversations.title,
      activity: shownActivityMinute(
        juniorConversations.executionStatus,
        juniorConversations.lastActivityAt,
      ).as("activity"),
      assistantSeq:
        sql<number>`(${latestMessageSeqQuery(db, "assistant", conversationId)})`.as(
          "assistant_seq",
        ),
      userSeq:
        sql<number>`(${latestMessageSeqQuery(db, "user", conversationId)})`.as(
          "user_seq",
        ),
      threads: sql<string>`(${tree})`.as("threads"),
      annotations: sql<string>`(${annotations})`.as("annotations"),
    })
    .from(juniorConversations)
    .leftJoin(
      pin,
      and(eq(pin.rootConversationId, conversationId), eq(pin.userId, userId)),
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
    status: byRow(page.state),
    activity: byRow(page.activity),
    messages: byRow(page.assistantSeq, page.userSeq),
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
 *
 * Each page holds up to `limit` rows by activity, and `nextCursor` reads the
 * next one. A row with new activity moves to an earlier page, so clients
 * remove repeats when they join pages.
 */
export async function readConversationFeedFromSql(
  options: {
    actorEmail?: string;
    codeRepositoryId?: string;
    /** `nextCursor` of the previous page. */
    cursor?: string | undefined;
    /** Extra row content that costs a query. */
    include?: readonly ConversationFeedInclude[];
    limit?: number;
    /** Receives how many waiting rows from outside the page were added. */
    onWaitingRows?: (count: number) => void;
    q?: string | undefined;
    spaceId?: string | undefined;
    status?: "active" | "archived";
    viewer?: User;
  } = {},
): Promise<ConversationFeed> {
  const nowMs = Date.now();
  const db = getDb();
  const filter =
    options.codeRepositoryId || options.spaceId
      ? undefined
      : conversationFeedFilter(options);
  const query = options.q?.trim().toLowerCase() || undefined;
  const status: "active" | "archived" | "all" =
    query || options.codeRepositoryId ? "all" : (options.status ?? "active");
  const cursor = options.cursor
    ? decodeConversationFeedCursor(options.cursor)
    : undefined;
  const limit = options.limit ?? CONVERSATION_FEED_LIMIT;
  // The viewer's active feed shows every pin on the first page, before the
  // pages by activity. Pins are not paged, so the cursor stays a plain
  // activity position.
  const pinsFirst = filter?.kind === "viewer" && status === "active";
  const include = options.include ?? [];
  const feedQuery = {
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
    ...(options.spaceId
      ? {
          space: {
            id: options.spaceId,
            ...(options.viewer
              ? { viewerUserId: options.viewer.id }
              : undefined),
          },
        }
      : undefined),
    filter,
    include,
    includePrivateMatches: filter?.kind === "viewer",
    query,
    status,
  };
  const firstPage = pinsFirst && !cursor;
  const [pinnedRows, pageRows, waitingRows] = await Promise.all([
    firstPage
      ? conversationRows(db, {
          ...feedQuery,
          pinnedForUserId: { pinned: true, userId: filter.userId },
        })
      : [],
    conversationRows(db, {
      ...feedQuery,
      ...(cursor ? { cursor } : undefined),
      // One more row than the page tells if another page follows.
      limit: limit + 1,
      ...(pinsFirst
        ? { pinnedForUserId: { pinned: false, userId: filter.userId } }
        : undefined),
    }),
    // Needs you shows every conversation that waits on the viewer, so the
    // first page also holds the waiting ones that fall outside it.
    firstPage
      ? conversationRows(db, {
          filter,
          include,
          includePrivateMatches: true,
          // Pins already show. The waiting rows inside the page sort first,
          // so this reads past them to one more row than the cap.
          limit: limit + CONVERSATION_FEED_WAITING_LIMIT + 1,
          pinnedForUserId: { pinned: false, userId: filter.userId },
          status: "active",
          waitingForUserId: filter.userId,
        })
      : [],
  ]);
  const page = pageRows.slice(0, limit);
  const lastRow = pageRows.length > limit ? page.at(-1) : undefined;
  const rows = [...pinnedRows, ...page];
  let waitingRowsTruncated = false;
  if (firstPage) {
    const loaded = new Set(rows.map((row) => row.conversation.conversationId));
    const outsidePage = waitingRows.filter(
      (row) => !loaded.has(row.conversation.conversationId),
    );
    waitingRowsTruncated = outsidePage.length > CONVERSATION_FEED_WAITING_LIMIT;
    const waiting = outsidePage.slice(0, CONVERSATION_FEED_WAITING_LIMIT);
    options.onWaitingRows?.(waiting.length);
    rows.push(...waiting);
  }
  const conversations = rows.map((row) => conversationFromRecordRow(row));
  const conversationIds = conversations.map(
    (conversation) => conversation.conversationId,
  );
  // Every child of these roots, read once for work owners and Threads.
  const conversationTrees = readConversationTrees(db, conversationIds);
  const [
    accessRows,
    tree,
    participantsByRoot,
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
    automationTitleByConversation,
    firstHumanMessageTextByConversation,
    treeStateByConversation,
    threadRecords,
    spaceRefs,
  ] = await Promise.all([
    readConversationAccessRows(db, conversationIds),
    conversationTrees,
    // The viewer's rows give both access and pin marks. Without a viewer, an
    // actor email feed reads only its pin marks. Feed rows are roots, so
    // these roots cover the access check.
    readMemberParticipants(
      db,
      conversationIds,
      options.viewer
        ? { userId: options.viewer.id }
        : filter
          ? feedMember(filter)
          : undefined,
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
    conversationTrees
      .then((tree) => listConversationWork(conversationIds, tree))
      .then(async (work) => ({
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
    readAutomationTitlesByConversationId(conversations),
    readFirstHumanMessageTexts(db, conversations),
    readConversationTreeStates(db, conversationIds, options.viewer?.id),
    // A Thread shows only while its root is not archived.
    readFeedThreadRecords(
      db,
      conversations
        .filter((conversation) => conversation.archivedAtMs === undefined)
        .map(({ conversationId }) => conversationId),
    ),
    readSpaceRefs(
      db,
      conversations.flatMap(({ spaceId }) => (spaceId ? [spaceId] : [])),
    ),
  ]);
  // This reads only when a row is in a private Space.
  const memberSpaceIds = options.viewer
    ? await readPrivateSpaceMemberships(db, accessRows, options.viewer.id)
    : new Set<string>();
  const accessByConversation = conversationAccessFromRows(
    accessRows,
    options.viewer ? new Set(participantsByRoot.keys()) : new Set(),
    memberSpaceIds,
  );
  const tenantByConversation = new Map(
    rows.flatMap((row) => {
      const tenantId = conversationSlackTenantId({
        provider: row.location?.provider,
        providerTenantId: row.location?.providerTenantId,
        sessionSource: row.conversation.sessionSource,
      });
      return tenantId ? [[row.conversation.conversationId, tenantId]] : [];
    }),
  );
  const visibleAnnotationsByConversation = new Map(
    conversationIds.map((conversationId) => [
      conversationId,
      accessByConversation.get(conversationId)?.canViewPrivateContent
        ? (annotationsByConversation.get(conversationId) ?? [])
        : [],
    ]),
  );
  const [visibleActivityPreviews, sidebarAnnotationsByConversation] =
    await Promise.all([
      attachActivityPreviewMentions(
        getSqlExecutor(),
        new Map(
          [...activityPreviewByConversation].filter(
            ([conversationId]) =>
              accessByConversation.get(conversationId)?.canViewPrivateContent,
          ),
        ),
        tenantByConversation,
      ),
      listConversationSidebarAnnotations(
        conversationIds,
        visibleAnnotationsByConversation,
      ),
    ]);
  const threadsByRoot = nestFeedThreads(
    threadRecords,
    tree,
    accessByConversation,
  );
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
        ...(filter
          ? participantsByRoot.get(conversation.conversationId)
          : undefined),
        status: row.status,
        automationTitle: automationTitleByConversation.get(
          conversation.conversationId,
        ),
        conversation,
        access,
        // Only members may learn a private Space's name.
        space:
          conversation.spaceId &&
          (!access?.privateSpaceId || access.canViewPrivateContent)
            ? (spaceRefs.get(conversation.spaceId) ?? null)
            : null,
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
      const activityPreview = visibleActivityPreviews.get(
        conversation.conversationId,
      );
      const participants = access?.canViewPrivateContent
        ? participantsByConversation.get(conversation.conversationId)
        : undefined;
      const threads = threadsByRoot.get(conversation.conversationId);
      // Files and links are private content.
      const media = access?.canViewPrivateContent ? row.media : null;
      const links =
        access?.canViewPrivateContent && row.links
          ? pickFeedLinks(
              conversation.conversationId,
              row.links,
              annotationUrls(
                visibleAnnotationsByConversation.get(
                  conversation.conversationId,
                ),
              ),
            )
          : [];
      const lastMessageAt = row.lastMessageAt?.toISOString();
      const treeRead = treeStateByConversation.get(conversation.conversationId);
      // The viewer saw the answer as they gave it, but like the summary it
      // holds private content.
      const viewerAnswer = access?.canViewPrivateContent
        ? feedViewerAnswer(row.viewerAnswer)
        : undefined;
      return {
        ...summary,
        ...work,
        ...treeRead,
        ...(row.awaitingAuthorization
          ? { awaitingAuthorization: true as const }
          : undefined),
        ...(row.latestTurnFailed
          ? { latestTurnFailed: true as const }
          : undefined),
        ...(lastMessageAt ? { lastMessageAt } : undefined),
        ...(threads ? { threads: threads.threads } : undefined),
        ...(threads?.omittedThreadCount
          ? { omittedThreadCount: threads.omittedThreadCount }
          : undefined),
        ...(participants && participants.length > 0
          ? { participants }
          : undefined),
        ...(activityPreview ? { activityPreview } : undefined),
        ...(viewerAnswer ? { viewerAnswer } : undefined),
        ...(media?.length ? { media } : undefined),
        ...(links.length > 0 ? { links } : undefined),
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
    ...(lastRow
      ? {
          nextCursor: encodeConversationFeedCursor({
            at: lastRow.activityCursor,
            conversationId: lastRow.conversation.conversationId,
          }),
        }
      : undefined),
    source: "conversation_index",
    ...(waitingRowsTruncated
      ? { waitingRowsTruncated: true as const }
      : undefined),
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
    include?: readonly ConversationFeedInclude[];
    onWaitingRows?: (count: number) => void;
    q?: string | undefined;
    spaceId?: string | undefined;
    status?: "active" | "archived";
    viewer?: User;
  } = {},
): Promise<ConversationFeed> {
  // Not parsed here: each caller's edge validates what it sends. The HTTP
  // route parses the feed in `jsonResponse`, and the MCP SDK checks
  // `structuredContent` against the tool's output schema.
  return readConversationFeedFromSql(options);
}
