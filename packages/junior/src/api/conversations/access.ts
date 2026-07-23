import { and, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { canExposeConversationPayload } from "@/chat/conversation-privacy";
import type { JuniorDatabase } from "@/db/db";
import {
  juniorConversations,
  juniorDestinations,
  juniorIdentities,
} from "@/db/schema";
import type { JuniorDestinationVisibility } from "@/db/schema/destinations";

const rootConversation = alias(juniorConversations, "access_root_conversation");
const rootDestination = alias(juniorDestinations, "access_root_destination");
const rootIdentity = alias(juniorIdentities, "access_root_identity");

export interface ConversationAccess {
  canViewPrivateContent: boolean;
  isParticipant: boolean;
  visibility: JuniorDestinationVisibility | null;
}

/** Resolve viewer access for a bounded set of persisted conversations. */
export async function readConversationAccessFromSql(
  db: JuniorDatabase,
  conversationIds: readonly string[],
  verifiedViewerEmail?: string,
): Promise<Map<string, ConversationAccess>> {
  if (conversationIds.length === 0) return new Map();
  const normalizedViewerEmail = verifiedViewerEmail?.trim().toLowerCase();

  const hasValidRoot = and(
    isNull(rootConversation.parentConversationId),
    eq(rootConversation.rootConversationId, rootConversation.conversationId),
    or(
      isNotNull(juniorConversations.parentConversationId),
      eq(
        juniorConversations.rootConversationId,
        juniorConversations.conversationId,
      ),
    ),
  );
  const rows = await db
    .select({
      conversationId: juniorConversations.conversationId,
      rootConversationId: sql<string | null>`case
        when ${hasValidRoot} then ${rootConversation.conversationId}
        else null
      end`,
      visibility: sql<JuniorDestinationVisibility | null>`case
        when ${hasValidRoot} then ${rootDestination.visibility}
        else null
      end`,
      isParticipant: sql<boolean>`coalesce(
        ${hasValidRoot}
          and ${rootIdentity.emailVerified} = true
          and ${rootIdentity.emailNormalized} = ${normalizedViewerEmail || null},
        false
      )`,
    })
    .from(juniorConversations)
    .leftJoin(
      rootConversation,
      eq(
        rootConversation.conversationId,
        juniorConversations.rootConversationId,
      ),
    )
    .leftJoin(
      rootDestination,
      eq(rootDestination.id, rootConversation.destinationId),
    )
    .leftJoin(
      rootIdentity,
      eq(rootIdentity.id, rootConversation.actorIdentityId),
    )
    .where(inArray(juniorConversations.conversationId, [...conversationIds]));

  return new Map(
    rows.map((row) => {
      const canViewPrivateContent =
        row.isParticipant ||
        (row.rootConversationId !== null &&
          canExposeConversationPayload({
            conversationId: row.rootConversationId,
            ...(row.visibility === "public" || row.visibility === "private"
              ? { visibility: row.visibility }
              : {}),
          }));
      return [
        row.conversationId,
        {
          canViewPrivateContent,
          isParticipant: row.isParticipant,
          visibility: row.visibility,
        },
      ];
    }),
  );
}
