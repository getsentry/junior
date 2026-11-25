/**
 * Spaces and their members (`design/spaces.md`). Any signed-in person can
 * read a public Space. Only members read a private Space, and only members
 * change a Space.
 */
import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  count,
  eq,
  exists,
  isNotNull,
  isNull,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { nextDetailVersion } from "@/chat/conversations/sql/detail-version";
import { getDb, getSqlExecutor } from "@/chat/db";
import { readUserAvatarUrls } from "@/chat/identities/avatar";
import {
  juniorConversations,
  juniorSpaceMembers,
  juniorSpaces,
  juniorUsers,
} from "@/db/schema";
import type { SpaceVisibility } from "@/db/schema/spaces";
import { setSpaceLocationsVisibility } from "./conversations";

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

/** One member of a Space. */
export interface SpaceMember {
  userId: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  joinedAt: Date;
}

/** Which Spaces a list returns. */
export interface SpaceListFilter {
  /** `member` returns only the viewer's Spaces. `all` returns every Space. */
  membership: "all" | "member";
  archived: boolean;
}

function memberCountSql() {
  return getDb()
    .select({ value: count() })
    .from(juniorSpaceMembers)
    .where(eq(juniorSpaceMembers.spaceId, juniorSpaces.id));
}

function viewerMembership(viewerUserId: string) {
  return getDb()
    .select({ one: juniorSpaceMembers.userId })
    .from(juniorSpaceMembers)
    .where(
      and(
        eq(juniorSpaceMembers.spaceId, juniorSpaces.id),
        eq(juniorSpaceMembers.userId, viewerUserId),
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
        viewerMembership(viewerUserId),
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

/** Create a Space. Its creator is its first member. */
export async function createSpace(args: {
  creatorUserId: string;
  name: string;
  description: string | null;
  visibility: SpaceVisibility;
}): Promise<Space> {
  const executor = getSqlExecutor();
  const id = randomUUID();
  const now = new Date();
  await executor.transaction(async () => {
    const db = executor.db();
    await db.insert(juniorSpaces).values({
      id,
      name: args.name,
      description: args.description,
      visibility: args.visibility,
      createdByUserId: args.creatorUserId,
      createdAt: now,
      updatedAt: now,
    });
    await db
      .insert(juniorSpaceMembers)
      .values({ spaceId: id, userId: args.creatorUserId, joinedAt: now });
  });
  const space = await readSpace(args.creatorUserId, id);
  if (!space) throw new Error("The Space was not saved");
  return space;
}

/**
 * Change the name, description, or visibility of a Space. A new visibility
 * also goes to the Location of every root in the Space. Returns false, and
 * changes nothing, when the Space cannot be private because a root in it
 * shares its Location, such as a Slack channel.
 */
export async function updateSpace(
  spaceId: string,
  changes: {
    name?: string | undefined;
    description?: string | null | undefined;
    visibility?: SpaceVisibility | undefined;
  },
): Promise<boolean> {
  const { name, visibility } = changes;
  const executor = getSqlExecutor();
  return await executor.transaction(async () => {
    const db = executor.db();
    // A move into the Space locks this row too, so no root with a shared
    // Location joins while the visibility changes.
    await db
      .select({ id: juniorSpaces.id })
      .from(juniorSpaces)
      .where(eq(juniorSpaces.id, spaceId))
      .for("update");
    if (
      visibility !== undefined &&
      !(await setSpaceLocationsVisibility(db, spaceId, visibility))
    ) {
      return false;
    }
    await db
      .update(juniorSpaces)
      .set({
        ...(name !== undefined ? { name } : undefined),
        ...(changes.description !== undefined
          ? { description: changes.description }
          : undefined),
        ...(visibility !== undefined ? { visibility } : undefined),
        updatedAt: new Date(),
      })
      .where(eq(juniorSpaces.id, spaceId));
    if (name === undefined) return true;
    // A Space and its Lead share one name.
    await db
      .update(juniorConversations)
      .set({ title: name, detailVersion: nextDetailVersion })
      .where(
        and(
          eq(juniorConversations.kind, "lead"),
          eq(juniorConversations.spaceId, spaceId),
        ),
      );
    return true;
  });
}

/** Add one person to a Space. Joining twice keeps the first join. */
export async function joinSpace(
  spaceId: string,
  userId: string,
): Promise<void> {
  await getDb()
    .insert(juniorSpaceMembers)
    .values({ spaceId, userId, joinedAt: new Date() })
    .onConflictDoNothing();
}

/**
 * Remove one person from a Space. Returns false, and changes nothing, when
 * they are the last member of a private Space: nobody could read or restore
 * a private Space with no members.
 */
export async function leaveSpace(
  spaceId: string,
  userId: string,
): Promise<boolean> {
  const executor = getSqlExecutor();
  return await executor.transaction(async () => {
    const db = executor.db();
    // Two members who leave at once, or a leave and a change to private,
    // take turns on this lock, so one of them sees the other's change.
    const [space] = await db
      .select({ visibility: juniorSpaces.visibility })
      .from(juniorSpaces)
      .where(eq(juniorSpaces.id, spaceId))
      .for("update");
    const member = and(
      eq(juniorSpaceMembers.spaceId, spaceId),
      eq(juniorSpaceMembers.userId, userId),
    );
    if (space?.visibility === "private") {
      const members = await db
        .select({ userId: juniorSpaceMembers.userId })
        .from(juniorSpaceMembers)
        .where(eq(juniorSpaceMembers.spaceId, spaceId))
        .limit(2);
      if (members.length === 1 && members[0]!.userId === userId) return false;
    }
    await db.delete(juniorSpaceMembers).where(member);
    return true;
  });
}

/** Return the members of a Space, earliest join first. */
export async function listSpaceMembers(
  spaceId: string,
): Promise<SpaceMember[]> {
  const db = getDb();
  const rows = await db
    .select({
      userId: juniorSpaceMembers.userId,
      email: juniorUsers.primaryEmail,
      displayName: juniorUsers.displayName,
      joinedAt: juniorSpaceMembers.joinedAt,
    })
    .from(juniorSpaceMembers)
    .innerJoin(juniorUsers, eq(juniorUsers.id, juniorSpaceMembers.userId))
    .where(eq(juniorSpaceMembers.spaceId, spaceId))
    .orderBy(asc(juniorSpaceMembers.joinedAt), asc(juniorSpaceMembers.userId));
  const avatars = await readUserAvatarUrls(
    db,
    rows.map((row) => row.userId),
  );
  return rows.map((row) => ({
    ...row,
    avatarUrl: avatars.get(row.userId) ?? null,
  }));
}
