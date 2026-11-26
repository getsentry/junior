/**
 * Spaces (`design/spaces.md`). A Space's members are the Participants of
 * its Lead, which join and leave it as any root. Any signed-in person can
 * read a public Space. Only members read a private Space, and only members
 * change a Space.
 */
import { randomUUID } from "node:crypto";
import type { User } from "@sentry/junior-plugin-api";
import {
  and,
  asc,
  count,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  not,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { nextDetailVersion } from "@/chat/conversations/sql/detail-version";
import { getDb, getSqlExecutor } from "@/chat/db";
import {
  recordWebConversationActivity,
  webActorFromUser,
} from "@/chat/conversations/web-input";
import {
  juniorConversationParticipants,
  juniorConversations,
  juniorSpaces,
} from "@/db/schema";
import type { SpaceVisibility } from "@/db/schema/spaces";

/** One Space, as one viewer sees it. */
export interface Space {
  id: string;
  name: string;
  description: string | null;
  visibility: SpaceVisibility;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
  memberCount: number;
  viewerIsMember: boolean;
}

/** Which Spaces a list returns. */
export interface SpaceListFilter {
  /** `member` returns only the viewer's Spaces. `all` returns every Space. */
  membership: "all" | "member";
  archived: boolean;
}

const memberLead = alias(juniorConversations, "space_member_lead");
const participants = juniorConversationParticipants;

/**
 * The id of a Space's Lead, as a subquery. A Space's members are the
 * Participants of its Lead.
 */
function spaceLeadId(spaceId: string | typeof juniorSpaces.id) {
  return getDb()
    .select({ id: memberLead.conversationId })
    .from(memberLead)
    .where(and(eq(memberLead.kind, "lead"), eq(memberLead.spaceId, spaceId)));
}

// Members are the Lead's subscribed Participants, as `viewerMembership`.
function memberCountSql() {
  return getDb()
    .select({ value: count() })
    .from(participants)
    .where(
      and(
        inArray(participants.rootConversationId, spaceLeadId(juniorSpaces.id)),
        isNull(participants.unsubscribedAt),
      ),
    );
}

/**
 * The viewer's Participant row on the Space's Lead. With `subscribed`, only
 * while the Lead is in their feed: a member who leaves a public Space keeps
 * the row, like any public root, but is no longer a member.
 */
function viewerMembership(
  viewerUserId: string,
  options?: { subscribed: true },
) {
  return getDb()
    .select({ one: participants.userId })
    .from(participants)
    .where(
      and(
        inArray(participants.rootConversationId, spaceLeadId(juniorSpaces.id)),
        eq(participants.userId, viewerUserId),
        options?.subscribed ? isNull(participants.unsubscribedAt) : undefined,
      ),
    );
}

async function selectSpaces(
  viewerUserId: string,
  where: SQL | undefined,
): Promise<Space[]> {
  const rows = await getDb()
    .select({
      id: juniorSpaces.id,
      name: juniorSpaces.name,
      description: juniorSpaces.description,
      visibility: juniorSpaces.visibility,
      createdAt: juniorSpaces.createdAt,
      updatedAt: juniorSpaces.updatedAt,
      archivedAt: juniorSpaces.archivedAt,
      memberCount: sql<number>`(${memberCountSql()})`.mapWith(Number),
      viewerIsMember: sql<boolean>`${exists(
        viewerMembership(viewerUserId, { subscribed: true }),
      )}`.mapWith(Boolean),
    })
    .from(juniorSpaces)
    // A private Space is readable only by its members.
    .where(
      and(
        where,
        or(
          eq(juniorSpaces.visibility, "public"),
          exists(viewerMembership(viewerUserId)),
        ),
      ),
    )
    .orderBy(asc(juniorSpaces.name), asc(juniorSpaces.id));
  return rows;
}

/** Return the Spaces that match the filter, by name. */
export async function listSpaces(
  viewerUserId: string,
  filter: SpaceListFilter,
): Promise<Space[]> {
  return await selectSpaces(
    viewerUserId,
    and(
      filter.archived
        ? isNotNull(juniorSpaces.archivedAt)
        : isNull(juniorSpaces.archivedAt),
      filter.membership === "member"
        ? exists(viewerMembership(viewerUserId, { subscribed: true }))
        : undefined,
    ),
  );
}

/** Return one Space, or nothing when it does not exist. */
export async function readSpace(
  viewerUserId: string,
  spaceId: string,
): Promise<Space | undefined> {
  const [space] = await selectSpaces(
    viewerUserId,
    eq(juniorSpaces.id, spaceId),
  );
  return space;
}

/**
 * Make the Lead of a Space. The member who makes it is its first Actor, so
 * they are its first Participant and a member of the Space. It has the
 * Space's visibility and its own Destination.
 */
export async function createSpaceLead(args: {
  member: Pick<User, "displayName" | "email" | "id">;
  space: Pick<Space, "id" | "name" | "visibility">;
}): Promise<void> {
  await recordWebConversationActivity({
    actor: webActorFromUser(args.member),
    conversationId: `local:web:${randomUUID()}`,
    nowMs: Date.now(),
    rootKind: "lead",
    rootSpaceId: args.space.id,
    rootTitle: args.space.name,
    rootVisibility: args.space.visibility,
  });
}

/**
 * Create a Space and its Lead. The creator is the Lead's first Actor, so
 * they are the Space's first member.
 */
export async function createSpace(args: {
  creator: Pick<User, "displayName" | "email" | "id">;
  name: string;
  description: string | null;
  visibility: SpaceVisibility;
}): Promise<Space> {
  const executor = getSqlExecutor();
  const id = randomUUID();
  const now = new Date();
  await executor.db().insert(juniorSpaces).values({
    id,
    name: args.name,
    description: args.description,
    visibility: args.visibility,
    createdByUserId: args.creator.id,
    createdAt: now,
    updatedAt: now,
  });
  try {
    await createSpaceLead({
      member: args.creator,
      space: { id, name: args.name, visibility: args.visibility },
    });
  } catch (error) {
    // The Lead's writes do not share a transaction with the Space. A Space
    // with no Lead has no members, so it goes away with the failed request.
    await executor
      .db()
      .delete(juniorSpaces)
      .where(and(eq(juniorSpaces.id, id), not(exists(spaceLeadId(id)))));
    throw error;
  }
  const space = await readSpace(args.creator.id, id);
  if (!space) throw new Error("The Space was not saved");
  return space;
}

/**
 * Change the name or description of a Space. Its visibility is set when it
 * is created and never changes.
 */
export async function updateSpace(
  spaceId: string,
  changes: {
    name?: string | undefined;
    description?: string | null | undefined;
  },
): Promise<void> {
  const { name } = changes;
  await getDb().transaction(async (tx) => {
    await tx
      .update(juniorSpaces)
      .set({
        ...(name !== undefined ? { name } : undefined),
        ...(changes.description !== undefined
          ? { description: changes.description }
          : undefined),
        updatedAt: new Date(),
      })
      .where(eq(juniorSpaces.id, spaceId));
    if (name === undefined) return;
    // A Space and its Lead share one name.
    await tx
      .update(juniorConversations)
      .set({ title: name, detailVersion: nextDetailVersion })
      .where(
        and(
          eq(juniorConversations.kind, "lead"),
          eq(juniorConversations.spaceId, spaceId),
        ),
      );
  });
}
