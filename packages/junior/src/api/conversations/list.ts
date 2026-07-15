import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { getDb } from "@/chat/db";
import type { Conversation } from "@/chat/conversations/store";
import type { JuniorDatabase } from "@/db/db";
import {
  juniorConversations,
  juniorDestinations,
  juniorIdentities,
} from "@/db/schema";
import { conversationSummaryFromStoredConversation } from "./projection";
import { conversationFeedSchema } from "./schema";
import type { ConversationFeed } from "./schema";
import type { ApiRoute } from "../route";
import { parseQuery } from "../http";
import { conversationFeedQuerySchema } from "../schema";

const CONVERSATION_FEED_LIMIT = 50;

async function conversationRows(
  db: JuniorDatabase,
  limit: number,
  actorEmail?: string,
) {
  return db
    .select({
      conversation: juniorConversations,
      destinationId: juniorDestinations.id,
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
    .where(
      and(
        isNull(juniorConversations.parentConversationId),
        isNull(juniorConversations.archivedAt),
        actorEmail
          ? and(
              eq(juniorIdentities.emailNormalized, actorEmail),
              eq(juniorIdentities.emailVerified, true),
            )
          : undefined,
      ),
    )
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
    ...(value.archivedAt ? { archivedAtMs: value.archivedAt.getTime() } : {}),
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
      locationId?: string;
      usage: ConversationRow["conversation"]["usage"];
    }
  | undefined
> {
  const db = getDb();
  const rows = await db
    .select({
      conversation: juniorConversations,
      destinationId: juniorDestinations.id,
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
        ...(row.destinationVisibility === "public" && row.destinationId
          ? { locationId: row.destinationId }
          : {}),
        usage: row.conversation.usage,
      }
    : undefined;
}

/**
 * Build a bounded dashboard feed, applying a normalized actor-email filter
 * before the limit when one is provided.
 */
export async function readConversationFeedFromSql(
  options: { actorEmail?: string; limit?: number } = {},
): Promise<ConversationFeed> {
  const nowMs = Date.now();
  const rows = await conversationRows(
    getDb(),
    options.limit ?? CONVERSATION_FEED_LIMIT,
    options.actorEmail,
  );
  return {
    conversations: rows.map((row) =>
      conversationSummaryFromStoredConversation({
        conversation: conversationFromRow(row),
        durationMs: row.conversation.durationMs,
        ...(row.destinationVisibility === "public" && row.destinationId
          ? { locationId: row.destinationId }
          : {}),
        usage: row.conversation.usage ?? undefined,
      }),
    ),
    generatedAt: new Date(nowMs).toISOString(),
    source: "conversation_index",
  };
}

/**
 * Load a bounded feed with an optional normalized actor-email presentation
 * filter. This filter is not an authorization boundary.
 */
export async function readConversationFeed(
  options: { actorEmail?: string } = {},
): Promise<ConversationFeed> {
  return conversationFeedSchema.parse(
    await readConversationFeedFromSql({ actorEmail: options.actorEmail }),
  );
}

/** Serve the conversation feed endpoint. */
export default {
  method: "get",
  path: "/",
  handler: async (c) => {
    const { actorEmail } = parseQuery(
      conversationFeedQuerySchema,
      c.req.query(),
    );
    return Response.json(await readConversationFeed({ actorEmail }));
  },
} satisfies ApiRoute;
