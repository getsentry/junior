import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  identitySchema,
  userSchema,
  type Actor,
  type Identity,
  type PluginUsers,
  type User,
} from "@sentry/junior-plugin-api";
import { getDb } from "@/chat/db";
import { findActorIdentityId } from "@/chat/identities/actor";
import { readUserAvatarUrls } from "@/chat/identities/avatar";
import { normalizeIdentityEmail } from "@/chat/identities/identity";
import {
  clearCachedUser,
  readCachedUserByEmail,
} from "@/chat/identities/user-cache";
import { juniorIdentities, juniorUsers } from "@/db/schema";
import type { JuniorDatabase } from "@/db/db";

type IdentityRow = Pick<
  typeof juniorIdentities.$inferSelect,
  | "displayName"
  | "handle"
  | "id"
  | "provider"
  | "providerSubjectId"
  | "providerTenantId"
>;
type UserRow = Pick<
  typeof juniorUsers.$inferSelect,
  "displayName" | "id" | "isAdmin" | "primaryEmail"
>;

function identityFromRow(row: IdentityRow): Identity {
  return identitySchema.parse({
    id: row.id,
    provider: row.provider,
    providerSubjectId: row.providerSubjectId,
    ...(row.providerTenantId
      ? { providerTenantId: row.providerTenantId }
      : undefined),
    ...(row.displayName ? { displayName: row.displayName } : undefined),
    ...(row.handle ? { handle: row.handle } : undefined),
  });
}

async function readUserById(
  db: JuniorDatabase,
  userRow: UserRow,
): Promise<User> {
  const identityRows = await db
    .select()
    .from(juniorIdentities)
    .where(
      and(
        eq(juniorIdentities.userId, userRow.id),
        eq(juniorIdentities.kind, "user"),
      ),
    )
    .orderBy(
      asc(juniorIdentities.provider),
      asc(juniorIdentities.providerTenantId),
      asc(juniorIdentities.providerSubjectId),
    );
  return userFromRows(userRow, identityRows);
}

function userFromRows(userRow: UserRow, identityRows: IdentityRow[]): User {
  return userSchema.parse({
    email: userRow.primaryEmail,
    id: userRow.id,
    identities: identityRows.map(identityFromRow),
    ...(userRow.displayName ? { displayName: userRow.displayName } : undefined),
    ...(userRow.isAdmin ? { isAdmin: true } : undefined),
  });
}

// Every signed-in request reads its viewer, so this read uses the cache.
async function readUserByNormalizedEmail(
  db: JuniorDatabase,
  normalizedEmail: string,
): Promise<User | undefined> {
  const cached = await readCachedUserByEmail(db, normalizedEmail);
  return cached ? userFromRows(cached.user, cached.identities) : undefined;
}

/** Resolve or create the canonical user for one verified viewer email. */
export async function resolveViewerUserFromSql(
  db: JuniorDatabase,
  email: string,
): Promise<User | undefined> {
  const normalizedEmail = normalizeIdentityEmail(email);
  if (!normalizedEmail) return undefined;
  // Every authenticated request resolves its viewer. Read first, so a known
  // user costs a cache read instead of an insert attempt and two reads.
  const existing = await readUserByNormalizedEmail(db, normalizedEmail);
  if (existing) return existing;
  const now = new Date();
  const rows = await db
    .insert(juniorUsers)
    .values({
      id: randomUUID(),
      primaryEmail: email.trim(),
      primaryEmailNormalized: normalizedEmail,
      displayName: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: juniorUsers.primaryEmailNormalized })
    .returning();
  const userRow =
    rows[0] ??
    (
      await db
        .select()
        .from(juniorUsers)
        .where(eq(juniorUsers.primaryEmailNormalized, normalizedEmail))
        .limit(1)
    )[0];
  return userRow ? await readUserById(db, userRow) : undefined;
}

/** Resolve or create the canonical user for one authenticated viewer. */
export async function resolveViewerUser(
  email: string,
): Promise<User | undefined> {
  return await resolveViewerUserFromSql(getDb(), email);
}

/** Read one existing canonical user by verified email without creating a row. */
export async function findUserByEmailFromSql(
  db: JuniorDatabase,
  email: string,
): Promise<User | undefined> {
  const normalizedEmail = normalizeIdentityEmail(email);
  if (!normalizedEmail) return undefined;
  return await readUserByNormalizedEmail(db, normalizedEmail);
}

/** Read one existing canonical user by verified email without creating a row. */
export async function findUserByEmail(
  email: string,
): Promise<User | undefined> {
  return await findUserByEmailFromSql(getDb(), email);
}

/** Update one canonical user's display name in SQL. */
export async function updateViewerDisplayNameFromSql(
  db: JuniorDatabase,
  userId: string,
  displayName: string,
): Promise<User | undefined> {
  const rows = await db
    .update(juniorUsers)
    .set({ displayName, updatedAt: new Date() })
    .where(eq(juniorUsers.id, userId))
    .returning();
  await clearCachedUser(userId);
  const userRow = rows[0];
  return userRow ? await readUserById(db, userRow) : undefined;
}

/** Read the photo path of one canonical user: Slack, then Google. */
export async function readViewerAvatarUrl(
  userId: string,
): Promise<string | undefined> {
  return (await readUserAvatarUrls(getDb(), [userId])).get(userId);
}

/** Update one canonical user's display name. */
export async function updateViewerDisplayName(
  userId: string,
  displayName: string,
): Promise<User | undefined> {
  return await updateViewerDisplayNameFromSql(getDb(), userId, displayName);
}

/**
 * Grant or revoke the Junior-wide admin role for one email.
 *
 * Granting creates the canonical user when needed, so an operator can grant
 * admin before that person first signs in. Revoking never creates a user.
 */
export async function setUserAdminFromSql(
  db: JuniorDatabase,
  email: string,
  isAdmin: boolean,
): Promise<User | undefined> {
  const user = isAdmin
    ? await resolveViewerUserFromSql(db, email)
    : await findUserByEmailFromSql(db, email);
  if (!user) return undefined;
  const rows = await db
    .update(juniorUsers)
    .set({ isAdmin, updatedAt: new Date() })
    .where(eq(juniorUsers.id, user.id))
    .returning();
  await clearCachedUser(user.id);
  const userRow = rows[0];
  return userRow ? await readUserById(db, userRow) : undefined;
}

/** List every Junior admin by primary email. */
export async function listAdminUsersFromSql(
  db: JuniorDatabase,
): Promise<User[]> {
  const rows = await db
    .select()
    .from(juniorUsers)
    .where(eq(juniorUsers.isAdmin, true))
    .orderBy(asc(juniorUsers.primaryEmailNormalized));
  if (rows.length === 0) return [];
  // One identity read for every admin, in the order of `readUserById`.
  const identityRows = await db
    .select()
    .from(juniorIdentities)
    .where(
      and(
        inArray(
          juniorIdentities.userId,
          rows.map((row) => row.id),
        ),
        eq(juniorIdentities.kind, "user"),
      ),
    )
    .orderBy(
      asc(juniorIdentities.provider),
      asc(juniorIdentities.providerTenantId),
      asc(juniorIdentities.providerSubjectId),
    );
  return rows.map((row) =>
    userFromRows(
      row,
      identityRows.filter((identity) => identity.userId === row.id),
    ),
  );
}

/** Resolve the stored identity and linked user for one runtime actor. */
export async function readActorIdentityFromSql(
  db: JuniorDatabase,
  actor: Actor,
): Promise<{ identity: Identity; user?: User } | undefined> {
  const identityId = await findActorIdentityId(db, actor);
  // The read by id returns only user Identities, so system work has no viewer.
  return identityId ? await readIdentityByIdFromSql(db, identityId) : undefined;
}

/** Resolve the stored identity and linked user for one runtime actor. */
export async function readActorIdentity(
  actor: Actor,
): Promise<{ identity: Identity; user?: User } | undefined> {
  return await readActorIdentityFromSql(getDb(), actor);
}

/** Read one stored identity and its linked user by identity id. */
export async function readIdentityByIdFromSql(
  db: JuniorDatabase,
  identityId: string,
): Promise<{ identity: Identity; user?: User } | undefined> {
  const rows = await db
    .select({
      identity: juniorIdentities,
      user: juniorUsers,
    })
    .from(juniorIdentities)
    .leftJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
    .where(
      and(
        eq(juniorIdentities.id, identityId),
        eq(juniorIdentities.kind, "user"),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return undefined;
  return {
    identity: identityFromRow(row.identity),
    ...(row.user ? { user: await readUserById(db, row.user) } : undefined),
  };
}

/** Read one stored identity and its linked user by identity id. */
export async function readIdentityById(
  identityId: string,
): Promise<{ identity: Identity; user?: User } | undefined> {
  return await readIdentityByIdFromSql(getDb(), identityId);
}

/**
 * Find the user Identities that people linked for accounts of one provider,
 * by handle, such as GitHub logins. Only account-linking flows put a
 * provider Identity on a User, so the match is verified. A handle that two
 * Identities claim is left out.
 */
export async function findLinkedIdentityIds(
  provider: string,
  handles: readonly string[],
): Promise<Map<string, string>> {
  const lower = [...new Set(handles.map((handle) => handle.toLowerCase()))];
  if (lower.length === 0) return new Map();
  const rows = await getDb()
    .select({ handle: juniorIdentities.handle, id: juniorIdentities.id })
    .from(juniorIdentities)
    .where(
      and(
        eq(juniorIdentities.kind, "user"),
        eq(juniorIdentities.provider, provider),
        isNotNull(juniorIdentities.userId),
        inArray(sql`lower(${juniorIdentities.handle})`, lower),
      ),
    );
  const found = new Map<string, string | undefined>();
  for (const row of rows) {
    const handle = row.handle?.toLowerCase();
    if (!handle) continue;
    found.set(handle, found.has(handle) ? undefined : row.id);
  }
  return new Map(
    [...found].flatMap(([handle, id]) => (id ? [[handle, id] as const] : [])),
  );
}

/** The people that one plugin reads outside a Turn. */
export function createPluginUsers(plugin: string): PluginUsers {
  return {
    readIdentity: readIdentityById,
    // A plugin's provider Identities carry its name, such as `github`.
    findLinkedIdentityIds: async (handles) =>
      await findLinkedIdentityIds(plugin, handles),
  };
}
