import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import {
  identitySchema,
  userSchema,
  type Actor,
  type Identity,
  type User,
} from "@sentry/junior-plugin-api";
import { getDb } from "@/chat/db";
import { normalizeIdentityEmail } from "@/chat/identities/identity";
import { juniorIdentities, juniorUsers } from "@/db/schema";
import type { JuniorDatabase } from "@/db/db";

type IdentityRow = typeof juniorIdentities.$inferSelect;
type UserRow = typeof juniorUsers.$inferSelect;

function identityFromRow(row: IdentityRow): Identity {
  return identitySchema.parse({
    id: row.id,
    provider: row.provider,
    providerSubjectId: row.providerSubjectId,
    ...(row.providerTenantId ? { providerTenantId: row.providerTenantId } : {}),
    ...(row.displayName ? { displayName: row.displayName } : {}),
    ...(row.handle ? { handle: row.handle } : {}),
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
  return userSchema.parse({
    email: userRow.primaryEmail,
    id: userRow.id,
    identities: identityRows.map(identityFromRow),
    ...(userRow.displayName ? { displayName: userRow.displayName } : {}),
  });
}

/** Resolve or create the canonical user for one verified viewer email. */
export async function resolveViewerUserFromSql(
  db: JuniorDatabase,
  email: string,
): Promise<User | undefined> {
  const normalizedEmail = normalizeIdentityEmail(email);
  if (!normalizedEmail) return undefined;
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
  const userRow = rows[0];
  return userRow ? await readUserById(db, userRow) : undefined;
}

/** Update one canonical user's display name. */
export async function updateViewerDisplayName(
  userId: string,
  displayName: string,
): Promise<User | undefined> {
  return await updateViewerDisplayNameFromSql(getDb(), userId, displayName);
}

/** Resolve the stored identity and linked user for one runtime actor. */
export async function readActorIdentityFromSql(
  db: JuniorDatabase,
  actor: Actor,
): Promise<{ identity: Identity; user?: User } | undefined> {
  if (actor.platform === "system") return undefined;
  const providerTenantId = actor.platform === "slack" ? actor.teamId : "";
  const rows = await db
    .select({
      identity: juniorIdentities,
      user: juniorUsers,
    })
    .from(juniorIdentities)
    .leftJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
    .where(
      and(
        eq(juniorIdentities.kind, "user"),
        eq(juniorIdentities.provider, actor.platform),
        eq(juniorIdentities.providerTenantId, providerTenantId),
        eq(juniorIdentities.providerSubjectId, actor.userId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return undefined;
  return {
    identity: identityFromRow(row.identity),
    ...(row.user ? { user: await readUserById(db, row.user) } : {}),
  };
}

/** Resolve the stored identity and linked user for one runtime actor. */
export async function readActorIdentity(
  actor: Actor,
): Promise<{ identity: Identity; user?: User } | undefined> {
  return await readActorIdentityFromSql(getDb(), actor);
}
