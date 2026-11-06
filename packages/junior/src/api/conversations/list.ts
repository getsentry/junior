import type { User } from "@sentry/junior-plugin-api";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  not,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { getDb, getSqlExecutor } from "@/chat/db";
import type { Conversation } from "@/chat/conversations/store";
import { locationFromRow } from "@/chat/conversations/sql/location";
import { parseSessionSource } from "@/chat/source";
import type { JuniorDatabase } from "@/db/db";
import {
  juniorCodeChanges,
  juniorConversationBriefs,
  juniorConversations,
  juniorDestinations,
  juniorIdentities,
  juniorUsers,
} from "@/db/schema";
import { conversationReadColumns } from "@/db/schema/conversations";
import { resolveSlackTeamDomains } from "@/chat/slack/team-domain";
import { readAutomationTitlesByConversationId } from "@/chat/automations/execution-stats";
import { conversationSummaryFromStoredConversation } from "./projection";
import { readConversationAccessFromSql } from "./access";
import {
  conversationArchivedForEmail,
  conversationArchivedForUser,
  conversationPinnedForUser,
  conversationViewerMarks,
  conversationHasParticipantUser,
  conversationIsMemberRoot,
  conversationNotArchivedForEmail,
  conversationNotArchivedForUser,
  viewerConversationMembership,
} from "./membership";
import { conversationFeedSchema } from "../schema/conversation";
import type { ConversationFeed } from "../schema/conversation";
import {
  childAgentTotalsReport,
  readConversationTreeMetricsFromSql,
} from "./usage";
import { readConversationAuxiliaryCostsFromSql } from "./auxiliary-costs";
import { listConversationAnnotationsById } from "@/chat/plugins/annotations";
import { listConversationSidebarAnnotations } from "@/chat/plugins/conversation-sidebar";
import { listConversationWork } from "@/chat/plugins/unfinished-work";
import { listWaitingConversations } from "@/chat/review-items/store";
import { isConversationPriority } from "./priority";
import { readLastUserMessageAtByConversation } from "./user-message-activity";
import { readConversationActivityPreviews } from "./activity-preview";
import { readFirstHumanMessageTexts } from "./first-message";
import { attachActivityPreviewMentions } from "./mentions";
import { readConversationParticipants } from "./participants";
import {
  decodeConversationFeedCursor,
  encodeConversationFeedCursor,
  type ConversationFeedCursor,
} from "./feed-cursor";

const CONVERSATION_FEED_LIMIT = 50;

type ConversationFeedMembership =
  | { kind: "viewer"; userId: string }
  | { kind: "actorEmail"; email: string };

function conversationFeedMembershipFilter(
  status: "active" | "archived" | "all",
  filter: ConversationFeedMembership | undefined,
): SQL | undefined {
  if (!filter) return status === "archived" ? sql`false` : undefined;
  if (filter.kind === "viewer") {
    return and(
      conversationIsMemberRoot({ userId: filter.userId }),
      status === "archived"
        ? conversationArchivedForUser(filter.userId)
        : status === "all"
          ? undefined
          : conversationNotArchivedForUser(filter.userId),
    );
  }
  return and(
    conversationIsMemberRoot({ email: filter.email }),
    status === "archived"
      ? conversationArchivedForEmail(filter.email)
      : status === "all"
        ? undefined
        : conversationNotArchivedForEmail(filter.email),
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
      viewerUserId
        ? viewerConversationMembership({
            actorMatch: eq(juniorIdentities.userId, viewerUserId),
            participantMatch: conversationHasParticipantUser(viewerUserId),
          })
        : undefined,
    ),
  );
}

async function conversationRows(
  db: JuniorDatabase,
  {
    codeRepository,
    conversationIds,
    cursor,
    filter,
    includePrivateBriefs = false,
    limit,
    pinnedForUserId,
    query,
    status,
  }: {
    codeRepository?: { id: string; viewerUserId?: string };
    /** Read only these root conversations. */
    conversationIds?: string[];
    /** Read only rows after this feed position. */
    cursor?: ConversationFeedCursor;
    filter: ConversationFeedMembership | undefined;
    includePrivateBriefs?: boolean;
    limit?: number;
    /** Read only the rows that this user pinned (`true`) or did not pin. */
    pinnedForUserId?: { pinned: boolean; userId: string };
    query?: string;
    status: "active" | "archived" | "all";
  },
) {
  const rows = db
    .select({
      conversation: conversationReadColumns(),
      // Keep microseconds so the next page starts exactly after this row.
      activityCursor: sql<string>`to_char(${juniorConversations.lastActivityAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      location: juniorDestinations,
      identityDisplayName: juniorIdentities.displayName,
      identityEmail: juniorIdentities.email,
      identityHandle: juniorIdentities.handle,
      identityProvider: juniorIdentities.provider,
      identitySubjectId: juniorIdentities.providerSubjectId,
      identityTenantId: juniorIdentities.providerTenantId,
      userDisplayName: juniorUsers.displayName,
    })
    .from(juniorConversations)
    .leftJoin(
      juniorDestinations,
      eq(juniorDestinations.id, juniorConversations.destinationId),
    )
    .leftJoin(
      juniorIdentities,
      eq(juniorIdentities.id, juniorConversations.actorIdentityId),
    )
    .leftJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
    .where(
      and(
        isNull(juniorConversations.parentConversationId),
        // An unkept Quick question is a private side thread.
        isNull(juniorConversations.quickQuestionAt),
        conversationFeedMembershipFilter(status, filter),
        conversationIds
          ? inArray(juniorConversations.conversationId, conversationIds)
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
      desc(juniorConversations.lastActivityAt),
      asc(juniorConversations.conversationId),
    )
    .$dynamic();
  return limit === undefined ? rows : rows.limit(limit);
}

type ConversationRow = Awaited<ReturnType<typeof conversationRows>>[number];

/**
 * Read the viewer's active conversations that wait on them but fall outside
 * the first page. Needs attention shows every conversation that waits on the
 * viewer, so an old one must come back to the feed.
 */
async function waitingRowsOutsidePage(
  db: JuniorDatabase,
  filter: ConversationFeedMembership & { kind: "viewer" },
  page: ConversationRow[],
): Promise<ConversationRow[]> {
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

/** Decode a conversation row with the linked user name and identity-scoped provider fields. */
function conversationFromRow(
  row: Omit<ConversationRow, "activityCursor">,
): Conversation {
  const value = row.conversation;
  // TODO(dcramer): Remove this source_json decode after locationFromRow drops
  // its legacy SessionSource fallback.
  const legacySessionSource =
    value.sessionSource === null
      ? undefined
      : parseSessionSource(value.sessionSource);
  if (value.sessionSource !== null && !legacySessionSource) {
    throw new Error("Conversation legacy source_json is invalid");
  }
  const actorFullName = row.userDisplayName?.trim()
    ? row.userDisplayName
    : row.identityDisplayName;
  const actor =
    row.identityProvider === "slack"
      ? {
          platform: "slack" as const,
          ...(row.identityEmail ? { email: row.identityEmail } : undefined),
          ...(actorFullName ? { fullName: actorFullName } : undefined),
          ...(row.identitySubjectId
            ? { slackUserId: row.identitySubjectId }
            : undefined),
          ...(row.identityHandle
            ? { slackUserName: row.identityHandle }
            : undefined),
          ...(row.identityTenantId
            ? { teamId: row.identityTenantId }
            : undefined),
        }
      : undefined;
  const location = locationFromRow(
    value.location,
    row.location,
    legacySessionSource,
  );
  return {
    schemaVersion: 1,
    conversationId: value.conversationId,
    createdAtMs: value.createdAt.getTime(),
    lastActivityAtMs: value.lastActivityAt.getTime(),
    updatedAtMs: value.updatedAt.getTime(),
    execution: {
      status: value.executionStatus,
      ...(value.runId ? { runId: value.runId } : undefined),
      ...(value.executionUpdatedAt
        ? { updatedAtMs: value.executionUpdatedAt.getTime() }
        : undefined),
    },
    ...(actor ? { actor } : undefined),
    ...(location ? { location } : undefined),
    ...(value.channelName ? { channelName: value.channelName } : undefined),
    ...(value.source ? { source: value.source } : undefined),
    ...(value.title ? { title: value.title } : undefined),
    ...(value.transcriptPurgedAt
      ? { transcriptPurgedAtMs: value.transcriptPurgedAt.getTime() }
      : undefined),
  };
}

/** Read one normalized conversation record directly from its SQL row. */
export async function readConversationRecordFromSql(
  conversationId: string,
): Promise<
  | {
      conversation: Conversation;
      durationMs: number;
      locationId?: string;
      usage: ConversationRow["conversation"]["usage"];
      rootConversationId: string | null;
    }
  | undefined
> {
  const db = getDb();
  const rows = await db
    .select({
      conversation: conversationReadColumns(),
      location: juniorDestinations,
      identityDisplayName: juniorIdentities.displayName,
      identityEmail: juniorIdentities.email,
      identityHandle: juniorIdentities.handle,
      identityProvider: juniorIdentities.provider,
      identitySubjectId: juniorIdentities.providerSubjectId,
      identityTenantId: juniorIdentities.providerTenantId,
      userDisplayName: juniorUsers.displayName,
    })
    .from(juniorConversations)
    .leftJoin(
      juniorDestinations,
      eq(juniorDestinations.id, juniorConversations.destinationId),
    )
    .leftJoin(
      juniorIdentities,
      eq(juniorIdentities.id, juniorConversations.actorIdentityId),
    )
    .leftJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
    .where(eq(juniorConversations.conversationId, conversationId))
    .limit(1);
  const row = rows[0];
  return row
    ? {
        conversation: conversationFromRow(row),
        durationMs: row.conversation.durationMs,
        ...(row.location?.visibility === "public"
          ? { locationId: row.location.id }
          : undefined),
        usage: row.conversation.usage,
        rootConversationId: row.conversation.rootConversationId,
      }
    : undefined;
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
    cursor?: string;
    limit?: number;
    q?: string;
    status?: "active" | "archived";
    viewer?: User;
  } = {},
): Promise<ConversationFeed> {
  const nowMs = Date.now();
  const db = getDb();
  const filter = options.codeRepositoryId
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
    filter,
    includePrivateBriefs: filter?.kind === "viewer",
    query,
    status,
  };
  const [pinnedRows, pageRows] = await Promise.all([
    pinsFirst && !cursor
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
  ]);
  const page = pageRows.slice(0, limit);
  const lastRow = pageRows.length > limit ? page.at(-1) : undefined;
  const rows = [...pinnedRows, ...page];
  if (pinsFirst && !cursor) {
    rows.push(...(await waitingRowsOutsidePage(db, filter, rows)));
  }
  const conversations = rows.map((row) => conversationFromRow(row));
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
    automationTitleByConversation,
    firstHumanMessageTextByConversation,
  ] = await Promise.all([
    readConversationAccessFromSql(db, conversationIds, options.viewer),
    conversationViewerMarks(
      db,
      conversationIds,
      filter?.kind === "viewer"
        ? { userId: filter.userId }
        : filter?.kind === "actorEmail"
          ? { email: filter.email }
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
    readAutomationTitlesByConversationId(conversations),
    readFirstHumanMessageTexts(db, conversations),
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
  const sidebarAnnotationsByConversation =
    await listConversationSidebarAnnotations(
      conversationIds,
      visibleAnnotationsByConversation,
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
        ...viewerMarksByConversation.get(conversation.conversationId),
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
      const participants = access?.canViewPrivateContent
        ? participantsByConversation.get(conversation.conversationId)
        : undefined;
      return {
        ...summary,
        ...work,
        ...(participants && participants.length > 0
          ? { participants }
          : undefined),
        ...(activityPreview ? { activityPreview } : undefined),
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
    ...(lastRow
      ? {
          nextCursor: encodeConversationFeedCursor({
            at: lastRow.activityCursor,
            conversationId: lastRow.conversation.conversationId,
          }),
        }
      : undefined),
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
