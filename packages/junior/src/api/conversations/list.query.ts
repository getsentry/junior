import { asc, desc, eq, isNull } from "drizzle-orm";
import { getDb } from "@/chat/db";
import type { Conversation } from "@/chat/conversations/store";
import type { JuniorDatabase } from "@/db/db";
import {
  juniorConversations,
  juniorDestinations,
  juniorIdentities,
} from "@/db/schema";
import { conversationSummaryFromStoredConversation } from "./projection";
import type { ConversationFeed } from "./schema";

const CONVERSATION_FEED_LIMIT = 50;

async function conversationRows(db: JuniorDatabase, limit: number) {
  return db
    .select({
      conversation: juniorConversations,
      destinationVisibility: juniorDestinations.visibility,
      identityDisplayName: juniorIdentities.displayName,
      identityEmail: juniorIdentities.email,
      identityHandle: juniorIdentities.handle,
      identityProvider: juniorIdentities.provider,
      identitySubjectId: juniorIdentities.providerSubjectId,
      identityTenantId: juniorIdentities.providerTenantId,
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
    .where(isNull(juniorConversations.parentConversationId))
    .orderBy(
      desc(juniorConversations.lastActivityAt),
      asc(juniorConversations.conversationId),
    )
    .limit(limit);
}

type ConversationRow = Awaited<ReturnType<typeof conversationRows>>[number];

function conversationFromRow(row: ConversationRow): Conversation {
  const value = row.conversation;
  const actor =
    row.identityProvider === "slack"
      ? {
          platform: "slack" as const,
          ...(row.identityEmail ? { email: row.identityEmail } : {}),
          ...(row.identityDisplayName
            ? { fullName: row.identityDisplayName }
            : {}),
          ...(row.identitySubjectId
            ? { slackUserId: row.identitySubjectId }
            : {}),
          ...(row.identityHandle ? { slackUserName: row.identityHandle } : {}),
          ...(row.identityTenantId ? { teamId: row.identityTenantId } : {}),
        }
      : undefined;
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
    ...(value.channelName ? { channelName: value.channelName } : {}),
    ...(value.source ? { source: value.source } : {}),
    ...(value.title ? { title: value.title } : {}),
    ...(value.transcriptPurgedAt
      ? { transcriptPurgedAtMs: value.transcriptPurgedAt.getTime() }
      : {}),
    ...(row.destinationVisibility
      ? {
          visibility:
            row.destinationVisibility === "public" ? "public" : "private",
        }
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
      usage: ConversationRow["conversation"]["usage"];
    }
  | undefined
> {
  const db = getDb();
  const rows = await db
    .select({
      conversation: juniorConversations,
      destinationVisibility: juniorDestinations.visibility,
      identityDisplayName: juniorIdentities.displayName,
      identityEmail: juniorIdentities.email,
      identityHandle: juniorIdentities.handle,
      identityProvider: juniorIdentities.provider,
      identitySubjectId: juniorIdentities.providerSubjectId,
      identityTenantId: juniorIdentities.providerTenantId,
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
    .where(eq(juniorConversations.conversationId, conversationId))
    .limit(1);
  const row = rows[0];
  return row
    ? {
        conversation: conversationFromRow(row),
        durationMs: row.conversation.durationMs,
        usage: row.conversation.usage,
      }
    : undefined;
}

/** Build the dashboard conversation feed directly from durable SQL rows. */
export async function readConversationFeedFromSql(
  limit = CONVERSATION_FEED_LIMIT,
): Promise<ConversationFeed> {
  const nowMs = Date.now();
  const rows = await conversationRows(getDb(), limit);
  return {
    conversations: rows.map((row) =>
      conversationSummaryFromStoredConversation({
        conversation: conversationFromRow(row),
        durationMs: row.conversation.durationMs,
        usage: row.conversation.usage ?? undefined,
      }),
    ),
    generatedAt: new Date(nowMs).toISOString(),
    source: "conversation_index",
  };
}
