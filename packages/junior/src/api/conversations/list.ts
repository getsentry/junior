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
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDb, getSqlExecutor } from "@/chat/db";
import type { Conversation } from "@/chat/conversations/store";
import { conversationKindFromRow } from "@/chat/conversations/sql/conversation-row";
import { locationFromRow } from "@/chat/conversations/sql/location";
import { parseSessionSource } from "@/chat/source";
import type { JuniorDatabase } from "@/db/db";
import {
  juniorCodeChanges,
  juniorConversationBriefs,
  juniorConversationParticipants,
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
    filter,
    includePrivateBriefs = false,
    limit,
    query,
    status,
  }: {
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
  return db
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
    .where(
      and(
        isNull(juniorConversations.parentConversationId),
        // An unkept Quick question is a private side thread.
        isNull(juniorConversations.quickQuestionAt),
        conversationFeedMembershipFilter(status, filter),
        conversationIds
          ? inArray(juniorConversations.conversationId, conversationIds)
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
      // Pins sort first so an old pinned root stays inside the feed limit.
      ...(filter?.kind === "viewer" && status === "active"
        ? [desc(conversationPinnedForUser(filter.userId))]
        : []),
      desc(juniorConversations.lastActivityAt),
      asc(juniorConversations.conversationId),
    )
    .limit(limit);
}

type ConversationRow = Awaited<ReturnType<typeof conversationRows>>[number];

/**
 * Read the viewer's active conversations that wait on them but fall outside
 * the newest page. Needs attention shows every conversation that waits on the
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

const feedTree = alias(juniorConversations, "feed_tree");

/**
 * Return a query for a token that changes when the viewer's default feed
 * page can change. It reads the same newest page as the feed, so its cost
 * does not grow with the viewer's history.
 *
 * A write that changes what a Conversation shows bumps its `detail_version`,
 * so the sum over each page root's tree covers the rows and their child
 * agents. A new or newly active root changes the page. Pins bump no detail
 * version, so they are part of the token too. Waiting roots outside the
 * page move the Review items token.
 */
export function conversationFeedVersionQuery(
  db: JuniorDatabase,
  userId: string,
) {
  const pin = juniorConversationParticipants;
  const page = db
    .select({
      conversationId: juniorConversations.conversationId,
      pinnedAt: pin.pinnedAt,
      pinPosition: pin.pinPosition,
    })
    .from(juniorConversations)
    .leftJoin(
      pin,
      and(
        eq(pin.rootConversationId, juniorConversations.conversationId),
        eq(pin.userId, userId),
      ),
    )
    .where(
      and(
        isNull(juniorConversations.parentConversationId),
        isNull(juniorConversations.quickQuestionAt),
        conversationFeedMembershipFilter("active", { kind: "viewer", userId }),
      ),
    )
    // The feed's order. The joined pin replaces its per-row pin lookup, which
    // makes the plan cost high enough to start JIT compilation.
    .orderBy(
      desc(isNotNull(pin.pinnedAt)),
      desc(juniorConversations.lastActivityAt),
      asc(juniorConversations.conversationId),
    )
    .limit(CONVERSATION_FEED_LIMIT)
    .as("feed_page");
  const tree = db
    .select({
      version: sql<string>`concat_ws(':', count(*), sum(${feedTree.detailVersion}))`,
    })
    .from(feedTree)
    .where(eq(feedTree.rootConversationId, page.conversationId));
  return db
    .select({
      version: sql<string>`md5(coalesce(string_agg(
        concat_ws('@', ${page.conversationId}, ${page.pinnedAt}, ${page.pinPosition}, (${tree})),
        ',' order by ${page.conversationId}
      ), ''))`,
    })
    .from(page);
}

/** Decode a conversation row with the linked user name and identity-scoped provider fields. */
function conversationFromRow(row: ConversationRow): Conversation {
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
    kind: conversationKindFromRow(value),
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
 */
export async function readConversationFeedFromSql(
  options: {
    actorEmail?: string;
    codeRepositoryId?: string;
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
  const status =
    query || options.codeRepositoryId ? "all" : (options.status ?? "active");
  const rows = await conversationRows(db, {
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
    limit: options.limit ?? CONVERSATION_FEED_LIMIT,
    query,
    status,
  });
  if (filter?.kind === "viewer" && status === "active") {
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
    q?: string;
    status?: "active" | "archived";
    viewer?: User;
  } = {},
): Promise<ConversationFeed> {
  return conversationFeedSchema.parse(
    await readConversationFeedFromSql(options),
  );
}
