import { eq } from "drizzle-orm";
import { getDb } from "@/chat/db";
import type { Conversation } from "@/chat/conversations/store";
import { conversationKindFromRow } from "@/chat/conversations/sql/conversation-row";
import { locationFromRow } from "@/chat/conversations/sql/location";
import { parseSessionSource } from "@/chat/source";
import type { JuniorDatabase } from "@/db/db";
import {
  juniorConversations,
  juniorDestinations,
  juniorIdentities,
  juniorUsers,
} from "@/db/schema";

/**
 * Select Conversation rows with their Location and Actor names. Callers add
 * the filter, order, and limit.
 */
export function selectConversationRecords(db: JuniorDatabase) {
  return db
    .select({
      conversation: juniorConversations,
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
    .leftJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId));
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

/** Read one normalized conversation record directly from its SQL row. */
export async function readConversationRecordFromSql(
  conversationId: string,
): Promise<
  | {
      conversation: Conversation;
      durationMs: number;
      locationId?: string;
      usage: ConversationRecordRow["conversation"]["usage"];
      rootConversationId: string | null;
    }
  | undefined
> {
  const rows = await selectConversationRecords(getDb())
    .where(eq(juniorConversations.conversationId, conversationId))
    .limit(1);
  const row = rows[0];
  return row
    ? {
        conversation: conversationFromRecordRow(row),
        durationMs: row.conversation.durationMs,
        ...(row.location?.visibility === "public"
          ? { locationId: row.location.id }
          : undefined),
        usage: row.conversation.usage,
        rootConversationId: row.conversation.rootConversationId,
      }
    : undefined;
}
