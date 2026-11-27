import type { User } from "@sentry/junior-plugin-api";
import { eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  canExposeConversationPayload,
  type ConversationPrivacy,
} from "@/chat/conversation-privacy";
import type { JuniorDatabase } from "@/db/db";
import { juniorConversations, juniorDestinations } from "@/db/schema";
import { conversationIdsWithParticipantUser } from "./membership";

const rootConversation = alias(juniorConversations, "access_root_conversation");
const rootDestination = alias(juniorDestinations, "access_root_destination");

export interface ConversationAccess {
  canViewPrivateContent: boolean;
  /**
   * Destination of the root, such as one Slack channel. Missing when the
   * stored tree is invalid or the root has no Destination.
   */
  destinationId?: string;
  /** Whether the viewer is a Participant of the root. */
  isParticipant: boolean;
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
  const participantRootIds =
    viewer !== undefined
      ? await conversationIdsWithParticipantUser(
          db,
          [...membershipConversationIds],
          viewer.id,
        )
      : new Set<string>();
  return conversationAccessFromRows(rows, participantRootIds);
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
    .where(inArray(juniorConversations.conversationId, [...conversationIds]));
}

/**
 * Resolve access from `readConversationAccessRows`. `participantRootIds`
 * holds the viewer's participant roots among the conversations and their
 * stored roots. It is empty without a viewer.
 */
export function conversationAccessFromRows(
  rows: readonly ConversationAccessRow[],
  participantRootIds: ReadonlySet<string>,
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
      // Participant rows belong to roots, so a row with a parent never
      // matches its own id. That keeps a forged cycle from granting access.
      // A Space's members are the Participants of its Lead, the root of
      // every Conversation in it, so this covers Spaces too.
      const isParticipant =
        (row.parentConversationId === null &&
          participantRootIds.has(row.conversationId)) ||
        (validRootConversationId !== undefined &&
          participantRootIds.has(validRootConversationId));
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
          ...(validRootConversationId !== undefined && row.destinationId
            ? { destinationId: row.destinationId }
            : undefined),
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

/**
 * Whether the viewer may add a Message to a Conversation. Only its
 * Participants act on a Conversation. A person who can read a public root
 * Joins it first.
 */
export function canAddConversationMessages(
  access: ConversationAccess | undefined,
): boolean {
  return Boolean(access?.isParticipant);
}

/**
 * Whether the viewer may add a person to a Conversation's Participants. Only
 * a Participant may. In a public one it grants no access. In a private one
 * it shares the Conversation, except that a Slack-backed private
 * Conversation follows its Slack channel, so it takes no Invites.
 */
export function canInviteToConversation(
  access: ConversationAccess | undefined,
): boolean {
  if (!access?.rootConversationId || !access.isParticipant) return false;
  return access.visibility === "public" || !isSlackBacked(access);
}

/**
 * Whether Leave ends the viewer's access: it removes their own Participant
 * row. Only a private Conversation with an explicit Participant list has
 * one. Elsewhere Leave only takes it out of their feed, because the
 * Conversation is public, or a Slack channel decides who reads it.
 */
export function leaveEndsAccess(
  access: ConversationAccess | undefined,
): boolean {
  return Boolean(
    access?.rootConversationId &&
    access.visibility !== "public" &&
    access.isParticipant &&
    !isSlackBacked(access),
  );
}

function isSlackBacked(access: ConversationAccess): boolean {
  return access.tenant?.provider === "slack";
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
  "destinationId" | "rootConversationId" | "visibility"
>;

/**
 * Apply `policies/conversation-access.md`: whether work in the `requester`
 * Conversation may read or find the data of the `target` Conversation. The
 * person of the Turn does not change the result. A public Conversation is
 * reachable from any Conversation, on any surface and in any provider tenant.
 * A private Conversation is reachable only from its own tree and from
 * Conversations with the same audience: the same Destination. A Space's Lead
 * is the root of all of its work, so the tree covers the whole Space.
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
  // Conversations share a Destination only when they have the same
  // audience. No provider check belongs here.
  if (
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
