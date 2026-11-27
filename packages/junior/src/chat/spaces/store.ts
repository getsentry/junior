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
import {
  recordWebConversationActivity,
  webActorFromUser,
} from "@/chat/conversations/web-input";
import {
  juniorConversationParticipants,
  juniorConversations,
  juniorSpaces,
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
  /** The Lead, which Junior creates with the Space. */
  leadConversationId: string;
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

// Members are the Lead's subscribed Participants, as `viewerMembership`.
function memberCountSql() {
  return getDb()
    .select({ value: count() })
    .from(participants)
    .where(
      and(
        eq(participants.rootConversationId, spaceLead.conversationId),
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
        eq(participants.rootConversationId, spaceLead.conversationId),
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
      // A Space's name, visibility, and archive are its Lead's.
      name: sql<string>`coalesce(${spaceLead.title}, '')`,
      description: juniorSpaces.description,
      visibility: sql<ConversationPrivacy>`coalesce(${spaceLead.visibility}, 'private')`,
      createdAt: juniorSpaces.createdAt,
      updatedAt: juniorSpaces.updatedAt,
      archivedAt: spaceLead.archivedAt,
      memberCount: sql<number>`(${memberCountSql()})`.mapWith(Number),
      viewerIsMember: sql<boolean>`${exists(
        viewerMembership(viewerUserId, { subscribed: true }),
      )}`.mapWith(Boolean),
      leadConversationId: spaceLead.conversationId,
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
    name: args.name,
    description: args.description,
    visibility: args.visibility,
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
      ...(changes.name !== undefined ? { name: changes.name } : undefined),
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
 * Keep the archive time that 0.316.0 reads, so a rollback to it sees the
 * Space's archive. The Lead's archive time is the one this release reads.
 */
export async function writeLegacySpaceArchive(
  spaceId: string,
  archivedAt: Date | null,
): Promise<void> {
  await getDb()
    .update(juniorSpaces)
    .set({ archivedAt })
    .where(eq(juniorSpaces.id, spaceId));
}
