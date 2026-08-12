import type { User } from "@sentry/junior-plugin-api";
import { and, asc, desc, eq, isNull, type SQL } from "drizzle-orm";
import { getDb } from "@/chat/db";
import type { Conversation } from "@/chat/conversations/store";
import { locationFromRow } from "@/chat/conversations/sql/location";
import { parseSessionSource } from "@/chat/source";
import type { JuniorDatabase } from "@/db/db";
import {
  juniorConversations,
  juniorDestinations,
  juniorIdentities,
  juniorUsers,
} from "@/db/schema";
import { resolveSlackTeamDomains } from "@/chat/slack/team-domain";
import { conversationSummaryFromStoredConversation } from "./projection";
import { readConversationAccessFromSql } from "./access";
import {
  conversationHasParticipantEmail,
  conversationHasParticipantUser,
  viewerConversationMembership,
} from "./membership";
import { conversationFeedSchema } from "../schema/conversation";
import type { ConversationFeed } from "../schema/conversation";
import { readRootConversationMetricsFromSql } from "./usage";
import { readConversationAuxiliaryCostsFromSql } from "./auxiliary-costs";

const CONVERSATION_FEED_LIMIT = 50;

type ConversationFeedMembership =
  | { kind: "viewer"; userId: string }
  | { kind: "actorEmail"; email: string };

function conversationFeedMembershipFilter(
  filter?: ConversationFeedMembership,
): SQL | undefined {
  if (!filter) return undefined;
  if (filter.kind === "viewer") {
    return viewerConversationMembership({
      actorMatch: eq(juniorIdentities.userId, filter.userId),
      participantMatch: conversationHasParticipantUser(filter.userId),
    });
  }
  return viewerConversationMembership({
    actorMatch: eq(juniorUsers.primaryEmailNormalized, filter.email),
    participantMatch: conversationHasParticipantEmail(filter.email),
  });
}

async function conversationRows(
  db: JuniorDatabase,
  limit: number,
  filter?: ConversationFeedMembership,
) {
  return db
    .select({
      conversation: juniorConversations,
      destination: juniorDestinations,
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
        isNull(juniorConversations.archivedAt),
        conversationFeedMembershipFilter(filter),
      ),
    )
    .orderBy(
      desc(juniorConversations.lastActivityAt),
      asc(juniorConversations.conversationId),
    )
    .limit(limit);
}

type ConversationRow = Awaited<ReturnType<typeof conversationRows>>[number];

/** Decode a conversation row with the linked user name and identity-scoped provider fields. */
function conversationFromRow(row: ConversationRow): Conversation {
  const value = row.conversation;
  const sessionSource =
    value.sessionSource === null
      ? undefined
      : parseSessionSource(value.sessionSource);
  if (value.sessionSource !== null && !sessionSource) {
    throw new Error("Conversation record session source is invalid");
  }
  const actorFullName = row.userDisplayName?.trim()
    ? row.userDisplayName
    : row.identityDisplayName;
  const actor =
    row.identityProvider === "slack"
      ? {
          platform: "slack" as const,
          ...(row.identityEmail ? { email: row.identityEmail } : {}),
          ...(actorFullName ? { fullName: actorFullName } : {}),
          ...(row.identitySubjectId
            ? { slackUserId: row.identitySubjectId }
            : {}),
          ...(row.identityHandle ? { slackUserName: row.identityHandle } : {}),
          ...(row.identityTenantId ? { teamId: row.identityTenantId } : {}),
        }
      : undefined;
  const location = locationFromRow(row.destination);
  return {
    schemaVersion: 1,
    conversationId: value.conversationId,
    createdAtMs: value.createdAt.getTime(),
    lastActivityAtMs: value.lastActivityAt.getTime(),
    updatedAtMs: value.updatedAt.getTime(),
    execution: {
      status: value.executionStatus,
      ...(value.runId ? { runId: value.runId } : {}),
      ...(value.executionUpdatedAt
        ? { updatedAtMs: value.executionUpdatedAt.getTime() }
        : {}),
    },
    ...(actor ? { actor } : {}),
    ...(location ? { location } : {}),
    ...(value.archivedAt ? { archivedAtMs: value.archivedAt.getTime() } : {}),
    ...(value.channelName ? { channelName: value.channelName } : {}),
    ...(value.source ? { source: value.source } : {}),
    ...(sessionSource ? { sessionSource } : {}),
    ...(value.title ? { title: value.title } : {}),
    ...(value.transcriptPurgedAt
      ? { transcriptPurgedAtMs: value.transcriptPurgedAt.getTime() }
      : {}),
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
      conversation: juniorConversations,
      destination: juniorDestinations,
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
        ...(row.destination?.visibility === "public"
          ? { locationId: row.destination.id }
          : {}),
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
 */
export async function readConversationFeedFromSql(
  options: {
    actorEmail?: string;
    limit?: number;
    viewer?: User;
  } = {},
): Promise<ConversationFeed> {
  const nowMs = Date.now();
  const db = getDb();
  const rows = await conversationRows(
    db,
    options.limit ?? CONVERSATION_FEED_LIMIT,
    conversationFeedFilter(options),
  );
  const conversations = rows.map((row) => conversationFromRow(row));
  const conversationIds = conversations.map(
    (conversation) => conversation.conversationId,
  );
  const [
    accessByConversation,
    auxiliaryCostsByRoot,
    metricsByRoot,
    teamDomainByTeamId,
  ] = await Promise.all([
    readConversationAccessFromSql(db, conversationIds, options.viewer),
    readConversationAuxiliaryCostsFromSql(db, conversationIds, {
      includeDescendants: true,
    }),
    readRootConversationMetricsFromSql(db, conversationIds),
    resolveSlackTeamDomains(
      conversations.flatMap((conversation) =>
        conversation.sessionSource?.platform === "slack"
          ? [conversation.sessionSource.teamId]
          : [],
      ),
    ),
  ]);
  return {
    conversations: conversations.map((conversation, index) => {
      const row = rows[index]!;
      const metrics = metricsByRoot.get(conversation.conversationId);
      return conversationSummaryFromStoredConversation({
        conversation,
        access: accessByConversation.get(conversation.conversationId),
        auxiliaryCosts: auxiliaryCostsByRoot.get(conversation.conversationId),
        durationMs: metrics?.durationMs ?? row.conversation.durationMs,
        teamDomainByTeamId,
        ...(row.destination?.visibility === "public"
          ? { locationId: row.destination.id }
          : {}),
        usage: metrics?.usage ?? row.conversation.usage ?? undefined,
      });
    }),
    generatedAt: new Date(nowMs).toISOString(),
    source: "conversation_index",
  };
}

/**
 * Load a bounded feed with an optional viewer-primary linked-user filter.
 * This filter is not an authorization boundary.
 */
export async function readConversationFeed(
  options: { actorEmail?: string; viewer?: User } = {},
): Promise<ConversationFeed> {
  return conversationFeedSchema.parse(
    await readConversationFeedFromSql(options),
  );
}
