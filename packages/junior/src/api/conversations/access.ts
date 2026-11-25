import type { User } from "@sentry/junior-plugin-api";
import { and, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  canExposeConversationPayload,
  type ConversationPrivacy,
} from "@/chat/conversation-privacy";
import type { JuniorDatabase } from "@/db/db";
import {
  juniorConversations,
  juniorDestinations,
  juniorSpaceMembers,
  juniorSpaces,
} from "@/db/schema";
import { conversationIdsWithParticipantUser } from "./membership";

const rootConversation = alias(juniorConversations, "access_root_conversation");
const rootDestination = alias(juniorDestinations, "access_root_destination");
const rootSpace = alias(juniorSpaces, "access_root_space");

export interface ConversationAccess {
  canViewPrivateContent: boolean;
  /**
   * Destination of the root, such as one Slack channel. Missing when the
   * stored tree is invalid or the root has no Destination.
   */
  destinationId?: string;
  /**
   * Whether the viewer is a Participant of the root. In a private Space, a
   * Participant who left the Space is not one.
   */
  isParticipant: boolean;
  /**
   * The private Space of the root. Its Conversations share one audience,
   * the members, and only members read or act on them.
   */
  privateSpaceId?: string;
  /** Root of the Conversation tree. Missing when the stored tree is invalid. */
  rootConversationId?: string | undefined;
  /** Provider tenant of the root Location, such as a Slack workspace. */
  tenant?: ProviderTenant;
  /** Visibility of the root. Null is private. */
  visibility: ConversationPrivacy | null;
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
  const rows = await readConversationAccessRows(db, conversationIds);
  const membershipConversationIds = new Set<string>();
  for (const row of rows) {
    membershipConversationIds.add(row.conversationId);
    if (row.storedRootConversationId) {
      membershipConversationIds.add(row.storedRootConversationId);
    }
  }
  const [participantRootIds, memberSpaceIds] =
    viewer !== undefined
      ? await Promise.all([
          conversationIdsWithParticipantUser(
            db,
            [...membershipConversationIds],
            viewer.id,
          ),
          readPrivateSpaceMemberships(db, rows, viewer.id),
        ])
      : [new Set<string>(), new Set<string>()];
  return conversationAccessFromRows(rows, participantRootIds, memberSpaceIds);
}

/**
 * Return the private Spaces of the rows' roots that the viewer is a member
 * of. `conversationAccessFromRows` needs them for a viewer.
 */
export async function readPrivateSpaceMemberships(
  db: JuniorDatabase,
  rows: readonly ConversationAccessRow[],
  viewerUserId: string,
): Promise<Set<string>> {
  const spaceIds = [
    ...new Set(
      rows.flatMap((row) =>
        row.spaceVisibility === "private" && row.spaceId ? [row.spaceId] : [],
      ),
    ),
  ];
  if (spaceIds.length === 0) return new Set();
  const members = await db
    .select({ spaceId: juniorSpaceMembers.spaceId })
    .from(juniorSpaceMembers)
    .where(
      and(
        inArray(juniorSpaceMembers.spaceId, spaceIds),
        eq(juniorSpaceMembers.userId, viewerUserId),
      ),
    );
  return new Set(members.map((member) => member.spaceId));
}

/** The stored tree, visibility, and root Destination that access reads. */
type ConversationAccessRow = Awaited<
  ReturnType<typeof readConversationAccessRows>
>[number];

/**
 * Read the stored tree, visibility, and root Destination of each
 * conversation. A caller that reads the viewer's participant rows itself
 * passes these rows to `conversationAccessFromRows`.
 */
export async function readConversationAccessRows(
  db: JuniorDatabase,
  conversationIds: readonly string[],
) {
  if (conversationIds.length === 0) return [];
  return await db
    .select({
      conversationId: juniorConversations.conversationId,
      parentConversationId: juniorConversations.parentConversationId,
      storedRootConversationId: juniorConversations.rootConversationId,
      rootConversationId: rootConversation.conversationId,
      rootParentConversationId: rootConversation.parentConversationId,
      rootRootConversationId: rootConversation.rootConversationId,
      destinationId: rootDestination.id,
      visibility: juniorConversations.visibility,
      provider: rootDestination.provider,
      providerTenantId: rootDestination.providerTenantId,
      spaceId: rootSpace.id,
      spaceVisibility: rootSpace.visibility,
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
    .leftJoin(rootSpace, eq(rootSpace.id, rootConversation.spaceId))
    .where(inArray(juniorConversations.conversationId, [...conversationIds]));
}

/**
 * Resolve access from `readConversationAccessRows`. `participantRootIds`
 * holds the viewer's participant roots among the conversations and their
 * stored roots, and `memberSpaceIds` holds the viewer's private Spaces from
 * `readPrivateSpaceMemberships`. Both are empty without a viewer.
 */
export function conversationAccessFromRows(
  rows: readonly ConversationAccessRow[],
  participantRootIds: ReadonlySet<string>,
  memberSpaceIds: ReadonlySet<string>,
): Map<string, ConversationAccess> {
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
      const privateSpaceId =
        validRootConversationId !== undefined &&
        row.spaceVisibility === "private" &&
        row.spaceId
          ? row.spaceId
          : undefined;
      // A private Space is readable only by its members, like a private
      // Slack channel.
      const isSpaceMember =
        privateSpaceId === undefined || memberSpaceIds.has(privateSpaceId);
      // Participant rows belong to roots, so a row with a parent never
      // matches its own id. That keeps a forged cycle from granting access.
      const isParticipant =
        isSpaceMember &&
        ((row.parentConversationId === null &&
          participantRootIds.has(row.conversationId)) ||
          (validRootConversationId !== undefined &&
            participantRootIds.has(validRootConversationId)));
      const canViewPrivateContent =
        privateSpaceId !== undefined
          ? isSpaceMember
          : isParticipant ||
            (validRootConversationId !== undefined &&
              canExposeConversationPayload({
                visibility: visibility ?? undefined,
              }));
      return [
        row.conversationId,
        {
          canViewPrivateContent,
          ...(validRootConversationId !== undefined && row.destinationId
            ? { destinationId: row.destinationId }
            : undefined),
          isParticipant,
          ...(privateSpaceId ? { privateSpaceId } : undefined),
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

/**
 * Whether the viewer may add a Message to a Conversation. A signed-in person
 * joins a public Conversation by posting in it, the same as a public Slack
 * thread: their first Turn adds their Participant row. A member joins a
 * Conversation in their private Space the same way. Any other private one
 * takes Messages only from its Participants.
 */
export function canAddConversationMessages(
  access: ConversationAccess | undefined,
): boolean {
  if (access?.privateSpaceId) return access.canViewPrivateContent;
  return Boolean(access?.isParticipant || access?.visibility === "public");
}

/**
 * The Slack workspace of a Conversation that the viewer can read. A mention
 * in it must name a Slack user of that workspace.
 */
export function readableSlackTeamId(
  access: ConversationAccess | undefined,
): string | undefined {
  return access?.canViewPrivateContent && access.tenant?.provider === "slack"
    ? access.tenant.providerTenantId
    : undefined;
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
      // oxlint-disable-next-line junior/bounded-fan-out -- It waits on the reads above and starts no query.
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
  "destinationId" | "privateSpaceId" | "rootConversationId" | "visibility"
>;

/**
 * Apply `policies/conversation-access.md`: whether work in the `requester`
 * Conversation may read or find the data of the `target` Conversation. The
 * person of the Turn does not change the result. A public Conversation is
 * reachable from any Conversation, on any surface and in any provider tenant.
 * A private Conversation is reachable only from its own tree and from
 * Conversations with the same audience: the same private Space, or else the
 * same Destination.
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
  // The members of a private Space are its Conversations' one audience. A
  // Conversation outside the Space has another audience, even at the same
  // Destination, so it does not reach in, and data does not leave.
  if (target.privateSpaceId) {
    return requester.privateSpaceId === target.privateSpaceId;
  }
  // Conversations share a Destination only when they have the same
  // audience. No provider check belongs here.
  if (
    requester.privateSpaceId === undefined &&
    requester.destinationId !== undefined &&
    requester.destinationId === target.destinationId
  ) {
    return true;
  }
  // Missing or unknown visibility is private.
  return target.visibility === "public";
}

/**
 * Whether work in `requesterConversationId` may read `conversationId`, by
 * `canAccessConversation`. A missing target is not readable. A requester that
 * is not stored yet reaches only public targets.
 */
export async function canReadConversation(
  db: JuniorDatabase,
  requesterConversationId: string,
  conversationId: string,
): Promise<boolean> {
  const access = await readConversationAccessFromSql(db, [
    requesterConversationId,
    conversationId,
  ]);
  const target = access.get(conversationId);
  return (
    target !== undefined &&
    canAccessConversation({
      requester: access.get(requesterConversationId) ?? { visibility: null },
      target,
    })
  );
}
