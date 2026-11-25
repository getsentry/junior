/**
 * Spaces and their members (`design/spaces.md`). Every Space is public, so
 * any signed-in person can read one. Only members change it.
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
  sql,
  type SQL,
} from "drizzle-orm";
import { getDb, getSqlExecutor } from "@/chat/db";
import { readUserAvatarUrls } from "@/chat/identities/avatar";
import { juniorSpaceMembers, juniorSpaces, juniorUsers } from "@/db/schema";

/** One Space, as one viewer sees it. */
export interface Space {
  id: string;
  name: string;
  description: string | null;
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
      createdAt: juniorSpaces.createdAt,
      updatedAt: juniorSpaces.updatedAt,
      archivedAt: juniorSpaces.archivedAt,
      memberCount: sql<number>`(${memberCountSql()})`.mapWith(Number),
      viewerIsMember: sql<boolean>`${exists(
        viewerMembership(viewerUserId),
      )}`.mapWith(Boolean),
    })
    .from(juniorSpaces)
    .where(where)
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

/** Change the name or description of a Space. */
export async function updateSpace(
  spaceId: string,
  changes: {
    name?: string | undefined;
    description?: string | null | undefined;
  },
): Promise<void> {
  await getDb()
    .update(juniorSpaces)
    .set({
      ...(changes.name !== undefined ? { name: changes.name } : undefined),
      ...(changes.description !== undefined
        ? { description: changes.description }
        : undefined),
      updatedAt: new Date(),
    })
    .where(eq(juniorSpaces.id, spaceId));
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

/** Remove one person from a Space. */
export async function leaveSpace(
  spaceId: string,
  userId: string,
): Promise<void> {
  await getDb()
    .delete(juniorSpaceMembers)
    .where(
      and(
        eq(juniorSpaceMembers.spaceId, spaceId),
        eq(juniorSpaceMembers.userId, userId),
      ),
    );
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
