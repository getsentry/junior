import type { User } from "@sentry/junior-plugin-api";
import { eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { canExposeConversationPayload } from "@/chat/conversation-privacy";
import type { JuniorDatabase } from "@/db/db";
import {
  juniorConversations,
  juniorDestinations,
  juniorIdentities,
} from "@/db/schema";
import type { JuniorDestinationVisibility } from "@/db/schema/destinations";
import { conversationIdsWithParticipantUser } from "./membership";

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
  viewer?: User,
): Promise<Map<string, ConversationAccess>> {
  if (conversationIds.length === 0) return new Map();
  const normalizedViewerEmail = viewer?.email.trim().toLowerCase() || undefined;

  const rows = await db
    .select({
      conversationId: juniorConversations.conversationId,
      parentConversationId: juniorConversations.parentConversationId,
      storedRootConversationId: juniorConversations.rootConversationId,
      rootConversationId: rootConversation.conversationId,
      rootParentConversationId: rootConversation.parentConversationId,
      rootRootConversationId: rootConversation.rootConversationId,
      visibility: rootDestination.visibility,
      rootEmailNormalized: rootIdentity.emailNormalized,
      rootEmailVerified: rootIdentity.emailVerified,
      rootUserId: rootIdentity.userId,
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

  const membershipConversationIds = new Set<string>();
  for (const row of rows) {
    membershipConversationIds.add(row.conversationId);
    if (row.storedRootConversationId) {
      membershipConversationIds.add(row.storedRootConversationId);
    }
  }
  const participantRootIds =
    viewer !== undefined
      ? await conversationIdsWithParticipantUser(
          db,
          [...membershipConversationIds],
          viewer.id,
        )
      : new Set<string>();

  return new Map(
    rows.map((row) => {
      const hasValidRoot =
        row.rootConversationId !== null &&
        row.rootConversationId === row.storedRootConversationId &&
        row.rootRootConversationId === row.rootConversationId &&
        row.rootParentConversationId === null &&
        (row.parentConversationId !== null ||
          row.storedRootConversationId === row.conversationId);
      const validRootConversationId = hasValidRoot
        ? (row.rootConversationId ?? undefined)
        : undefined;
      const visibility =
        validRootConversationId === undefined ? null : row.visibility;
      const isRootActor =
        validRootConversationId !== undefined &&
        viewer !== undefined &&
        (row.rootUserId === viewer.id ||
          (normalizedViewerEmail !== undefined &&
            row.rootEmailVerified === true &&
            row.rootEmailNormalized === normalizedViewerEmail));
      const isMaterializedParticipant =
        participantRootIds.has(row.conversationId) ||
        (validRootConversationId !== undefined &&
          participantRootIds.has(validRootConversationId));
      const isParticipant = isRootActor || isMaterializedParticipant;
      const canViewPrivateContent =
        isParticipant ||
        (validRootConversationId !== undefined &&
          canExposeConversationPayload({
            visibility: visibility ?? undefined,
          }));
      return [
        row.conversationId,
        {
          canViewPrivateContent,
          isParticipant,
          visibility,
        },
      ];
    }),
  );
}
