/**
 * Spaces and their members (`design/spaces.md`). A Space's members are the
 * Participants of its Lead. Any signed-in person can read a public Space.
 * Only members read a private Space, and only members change a Space.
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
import type { ConversationPrivacy } from "@/chat/conversation-privacy";
import { isPublicConversation } from "@/chat/conversations/sql/privacy";
import { setConversationTitle } from "@/chat/conversations/sql/title";
import { getDb, getSqlExecutor } from "@/chat/db";
import { readUserAvatarUrls } from "@/chat/identities/avatar";
import {
  recordWebConversationActivity,
  webActorFromUser,
} from "@/chat/conversations/web-input";
import {
  juniorConversationParticipants,
  juniorConversations,
  juniorSpaces,
  juniorUsers,
} from "@/db/schema";

/** One Space, as one viewer sees it. */
export interface Space {
  id: string;
  name: string;
  description: string | null;
  visibility: ConversationPrivacy;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
  memberCount: number;
  viewerIsMember: boolean;
}

/** One member of a Space. */
export interface SpaceMember {
  userId: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
}

/** Which Spaces a list returns. */
export interface SpaceListFilter {
  /** `member` returns only the viewer's Spaces. `all` returns every Space. */
  membership: "all" | "member";
  archived: boolean;
}

const memberLead = alias(juniorConversations, "space_member_lead");
const spaceLead = alias(juniorConversations, "space_lead");
const participants = juniorConversationParticipants;

/**
 * The id of a Space's Lead, as a subquery. A Space's members are the
 * Participants of its Lead.
 */
function spaceLeadId(spaceId: string) {
  return getDb()
    .select({ id: memberLead.conversationId })
    .from(memberLead)
    .where(and(eq(memberLead.kind, "lead"), eq(memberLead.spaceId, spaceId)));
}

function memberCountSql() {
  return getDb()
    .select({ value: count() })
    .from(participants)
    .where(eq(participants.rootConversationId, spaceLead.conversationId));
}

function viewerMembership(viewerUserId: string) {
  return getDb()
    .select({ one: participants.userId })
    .from(participants)
    .where(
      and(
        eq(participants.rootConversationId, spaceLead.conversationId),
        eq(participants.userId, viewerUserId),
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
      // A Space's name, visibility, and archive are its Lead's.
      name: sql<string>`coalesce(${spaceLead.title}, '')`,
      description: juniorSpaces.description,
      visibility: sql<ConversationPrivacy>`coalesce(${spaceLead.visibility}, 'private')`,
      createdAt: juniorSpaces.createdAt,
      updatedAt: juniorSpaces.updatedAt,
      archivedAt: spaceLead.archivedAt,
      memberCount: sql<number>`(${memberCountSql()})`.mapWith(Number),
      viewerIsMember: sql<boolean>`${exists(
        viewerMembership(viewerUserId),
      )}`.mapWith(Boolean),
    })
    .from(juniorSpaces)
    .innerJoin(
      spaceLead,
      and(eq(spaceLead.spaceId, juniorSpaces.id), eq(spaceLead.kind, "lead")),
    )
    // A private Space is readable only by its members.
    .where(
      and(
        where,
        or(
          isPublicConversation(spaceLead),
          exists(viewerMembership(viewerUserId)),
        ),
      ),
    )
    .orderBy(asc(spaceLead.title), asc(juniorSpaces.id));
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
        ? isNotNull(spaceLead.archivedAt)
        : isNull(spaceLead.archivedAt),
      filter.membership === "member"
        ? exists(viewerMembership(viewerUserId))
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
 * Create a Space and its Lead. The Lead holds the Space's name and
 * visibility. The creator is the Lead's first Actor, so they are its first
 * Participant and the Space's first member.
 */
export async function createSpace(args: {
  creator: Pick<User, "displayName" | "email" | "id">;
  name: string;
  description: string | null;
  visibility: ConversationPrivacy;
}): Promise<Space> {
  const executor = getSqlExecutor();
  const id = randomUUID();
  const now = new Date();
  await executor.db().insert(juniorSpaces).values({
    id,
    description: args.description,
    createdByUserId: args.creator.id,
    createdAt: now,
    updatedAt: now,
  });
  try {
    await recordWebConversationActivity({
      actor: webActorFromUser(args.creator),
      conversationId: `local:web:${randomUUID()}`,
      nowMs: now.getTime(),
      rootKind: "lead",
      rootSpaceId: id,
      rootTitle: args.name,
      rootVisibility: args.visibility,
    });
  } catch (error) {
    // The Lead's writes do not share a transaction with the Space. A Space
    // with no Lead cannot be read, so it goes away with the failed request.
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
 * Change the name or description of a Space. Its name is its Lead's title,
 * so a rename renames the Lead as any rename does. Its visibility is set
 * when it is created and never changes.
 */
export async function updateSpace(
  spaceId: string,
  changes: {
    name?: string | undefined;
    description?: string | null | undefined;
  },
): Promise<void> {
  const executor = getSqlExecutor();
  await executor
    .db()
    .update(juniorSpaces)
    .set({
      ...(changes.description !== undefined
        ? { description: changes.description }
        : undefined),
      updatedAt: new Date(),
    })
    .where(eq(juniorSpaces.id, spaceId));
  if (changes.name === undefined) return;
  const [lead] = await executor
    .db()
    .select({ id: juniorConversations.conversationId })
    .from(juniorConversations)
    .where(
      and(
        eq(juniorConversations.kind, "lead"),
        eq(juniorConversations.spaceId, spaceId),
      ),
    )
    .limit(1);
  if (lead) await setConversationTitle(executor, lead.id, changes.name);
}

/**
 * Add one person to a Space: make them a Participant of its Lead. Joining
 * again puts the Space back in their active feed.
 */
export async function joinSpace(
  leadConversationId: string,
  userId: string,
): Promise<void> {
  await getDb()
    .insert(participants)
    .values({
      userId,
      rootConversationId: leadConversationId,
      lastMessageAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [participants.userId, participants.rootConversationId],
      set: { unsubscribedAt: null },
    });
}

/**
 * Remove one person from a Space. Returns "last_member", and changes
 * nothing, when they are the last member of a private Space: nobody could
 * read or restore a private Space with no members.
 */
export async function leaveSpace(
  spaceId: string,
  userId: string,
): Promise<"last_member" | undefined> {
  const executor = getSqlExecutor();
  return await executor.transaction(async () => {
    const db = executor.db();
    // Two members who leave at once take turns on this lock, so the second
    // sees that the first left.
    const [lead] = await db
      .select({
        conversationId: juniorConversations.conversationId,
        visibility: juniorConversations.visibility,
      })
      .from(juniorConversations)
      .where(
        and(
          eq(juniorConversations.kind, "lead"),
          eq(juniorConversations.spaceId, spaceId),
        ),
      )
      .for("update");
    if (!lead) return undefined;
    const members = eq(participants.rootConversationId, lead.conversationId);
    if (lead.visibility === "private") {
      const rows = await db
        .select({ userId: participants.userId })
        .from(participants)
        .where(members)
        .limit(2);
      if (rows.length === 1 && rows[0]!.userId === userId) {
        return "last_member";
      }
    }
    // Leaving ends membership, so the row goes, not only the feed entry.
    await db
      .delete(participants)
      .where(and(members, eq(participants.userId, userId)));
    return undefined;
  });
}

/** Return the members of a Space, by email. */
export async function listSpaceMembers(
  spaceId: string,
): Promise<SpaceMember[]> {
  const db = getDb();
  const rows = await db
    .select({
      userId: participants.userId,
      email: juniorUsers.primaryEmail,
      displayName: juniorUsers.displayName,
    })
    .from(participants)
    .innerJoin(juniorUsers, eq(juniorUsers.id, participants.userId))
    .where(inArray(participants.rootConversationId, spaceLeadId(spaceId)))
    .orderBy(asc(juniorUsers.primaryEmail), asc(participants.userId));
  const avatars = await readUserAvatarUrls(
    db,
    rows.map((row) => row.userId),
  );
  return rows.map((row) => ({
    ...row,
    avatarUrl: avatars.get(row.userId) ?? null,
  }));
}
