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
  /** Root of the Conversation tree. Missing when the stored tree is invalid. */
  rootConversationId?: string;
  /** Provider tenant of the root Location, such as a Slack workspace. */
  tenant?: ProviderTenant;
  visibility: JuniorDestinationVisibility | null;
}

/** A provider tenant, such as one Slack workspace. */
export interface ProviderTenant {
  provider: string;
  providerTenantId: string;
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
      provider: rootDestination.provider,
      providerTenantId: rootDestination.providerTenantId,
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
          ...(validRootConversationId !== undefined
            ? { rootConversationId: validRootConversationId }
            : undefined),
          visibility,
          ...(validRootConversationId !== undefined &&
          row.provider !== null &&
          row.providerTenantId
            ? {
                tenant: {
                  provider: row.provider,
                  providerTenantId: row.providerTenantId,
                },
              }
            : undefined),
        },
      ];
    }),
  );
}

/** Read viewer access for a bounded set of Conversations. */
export type ConversationAccessReader = (
  conversationIds: readonly string[],
) => Promise<Map<string, ConversationAccess>>;

/**
 * Read access for one request. Each id is read at most once, so the parts of
 * one response that need the same Conversation share a query.
 */
export function createConversationAccessReader(
  db: JuniorDatabase,
  viewer?: User,
): ConversationAccessReader {
  const byId = new Map<string, Promise<ConversationAccess | undefined>>();
  return async (conversationIds) => {
    const missing = [...new Set(conversationIds)].filter((id) => !byId.has(id));
    if (missing.length > 0) {
      const read = readConversationAccessFromSql(db, missing, viewer);
      for (const id of missing) {
        byId.set(
          id,
          read.then((access) => access.get(id)),
        );
      }
    }
    const entries = await Promise.all(
      conversationIds.map(async (id) => [id, await byId.get(id)] as const),
    );
    return new Map(
      entries.flatMap(([id, access]) => (access ? [[id, access]] : [])),
    );
  };
}

/** The fields of a Conversation that decide access from another one. */
export type ConversationReach = Pick<
  ConversationAccess,
  "rootConversationId" | "tenant" | "visibility"
>;

/**
 * Apply `policies/conversation-access.md`: whether work in the `requester`
 * Conversation may read or find the data of the `target` Conversation. The
 * person of the Turn does not change the result. A private Conversation is
 * reachable only from its own tree.
 */
export function canAccessConversation(args: {
  requester: ConversationReach;
  target: ConversationReach;
}): boolean {
  const { requester, target } = args;
  if (
    requester.rootConversationId !== undefined &&
    requester.rootConversationId === target.rootConversationId
  ) {
    return true;
  }
  if (
    !requester.tenant ||
    !target.tenant ||
    requester.tenant.provider !== target.tenant.provider ||
    requester.tenant.providerTenantId !== target.tenant.providerTenantId
  ) {
    return false;
  }
  // Missing or unknown visibility is private.
  return target.visibility === "public";
}
