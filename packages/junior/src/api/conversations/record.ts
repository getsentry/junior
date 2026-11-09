import { eq } from "drizzle-orm";
import { getDb } from "@/chat/db";
import type { Conversation } from "@/chat/conversations/store";
import { conversationKindFromRow } from "@/chat/conversations/sql/conversation-row";
import { conversationStatusSql } from "@/chat/conversations/sql/status";
import { locationFromRow } from "@/chat/conversations/sql/location";
import { parseSessionSource } from "@/chat/source";
import type { JuniorDatabase } from "@/db/db";
import {
  juniorConversations,
  juniorDestinations,
  juniorIdentities,
  juniorUsers,
} from "@/db/schema";

/** The columns of one Conversation record, for `selectConversationRecords`. */
export const conversationRecordColumns = {
  conversation: juniorConversations,
  status: conversationStatusSql(juniorConversations),
  location: juniorDestinations,
  identityDisplayName: juniorIdentities.displayName,
  identityEmail: juniorIdentities.email,
  identityHandle: juniorIdentities.handle,
  identityProvider: juniorIdentities.provider,
  identitySubjectId: juniorIdentities.providerSubjectId,
  identityTenantId: juniorIdentities.providerTenantId,
  userDisplayName: juniorUsers.displayName,
};

/** Left-join conditions from a Conversation to its record tables. */
export const conversationRecordJoins = {
  location: eq(juniorDestinations.id, juniorConversations.destinationId),
  identity: eq(juniorIdentities.id, juniorConversations.actorIdentityId),
  user: eq(juniorUsers.id, juniorIdentities.userId),
};

/**
 * Select Conversation rows with their Location and Actor names. Callers add
 * the filter, order, and limit.
 */
export function selectConversationRecords(db: JuniorDatabase) {
  return db
    .select(conversationRecordColumns)
    .from(juniorConversations)
    .leftJoin(juniorDestinations, conversationRecordJoins.location)
    .leftJoin(juniorIdentities, conversationRecordJoins.identity)
    .leftJoin(juniorUsers, conversationRecordJoins.user);
}

/** One row from `selectConversationRecords`. */
export type ConversationRecordRow = Awaited<
  ReturnType<ReturnType<typeof selectConversationRecords>["where"]>
>[number];

/** Decode a conversation row with the linked user name and identity-scoped provider fields. */
export function conversationFromRecordRow(
  row: ConversationRecordRow,
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
    ...(value.parentConversationId
      ? { parentConversationId: value.parentConversationId }
      : undefined),
    ...(value.archivedAt
      ? { archivedAtMs: value.archivedAt.getTime() }
      : undefined),
    ...(actor ? { actor } : undefined),
    ...(location ? { location } : undefined),
    ...(value.channelName ? { channelName: value.channelName } : undefined),
    ...(value.source ? { source: value.source } : undefined),
    ...(value.title ? { title: value.title } : undefined),
    ...(value.transcriptPurgedAt
      ? { transcriptPurgedAtMs: value.transcriptPurgedAt.getTime() }
      : undefined),
    ...(value.stoppedAt
      ? { stoppedAtMs: value.stoppedAt.getTime() }
      : undefined),
  };
}

/** One Conversation with the stored totals that its detail shows. */
export type ConversationRecord = {
  conversation: Conversation;
  durationMs: number;
  locationId?: string;
  status: ConversationRecordRow["status"];
  usage: ConversationRecordRow["conversation"]["usage"];
  rootConversationId: string | null;
};

/** Decode one `selectConversationRecords` row into a Conversation record. */
export function conversationRecordFromRow(
  row: ConversationRecordRow,
): ConversationRecord {
  return {
    conversation: conversationFromRecordRow(row),
    durationMs: row.conversation.durationMs,
    ...(row.location?.visibility === "public"
      ? { locationId: row.location.id }
      : undefined),
    status: row.status,
    usage: row.conversation.usage,
    rootConversationId: row.conversation.rootConversationId,
  };
}

/** Read one normalized conversation record directly from its SQL row. */
export async function readConversationRecordFromSql(
  conversationId: string,
): Promise<ConversationRecord | undefined> {
  const rows = await selectConversationRecords(getDb())
    .where(eq(juniorConversations.conversationId, conversationId))
    .limit(1);
  const row = rows[0];
  return row ? conversationRecordFromRow(row) : undefined;
}
