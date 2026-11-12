/**
 * Cache of each User and their user Identities. Every signed-in request
 * resolves its viewer, and person cards read the people that a message
 * links to, so these reads go to the state cache instead of the database.
 *
 * Every write to a cached column or to a user Identity must call
 * `clearCachedUser`. The other columns of a User, such as the timezone or
 * the customization, are not in the cache.
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import * as z from "zod";
import { getStateAdapter } from "@/chat/state/adapter";
import { createCache } from "@/chat/state/cache";
import type { JuniorDatabase } from "@/db/db";
import { juniorIdentities, juniorUsers } from "@/db/schema";

// A write clears the entry, so the TTL is only a safety net.
const USER_TTL_MS = 24 * 60 * 60 * 1000;
// A first sign-in creates the User, so remember a missing one only briefly.
const MISSING_TTL_MS = 60 * 1000;
// A write clears the cache before its transaction commits. Reads in this
// window go to the database and do not fill the cache, so a read of the
// rows from before the write cannot stay in the cache.
const SETTLE_MS = 10 * 1000;
const CACHE_NAMESPACE = "identities";

const cachedUserSchema = z.object({
  identities: z.array(
    z.object({
      avatarUrl: z.string().nullable(),
      displayName: z.string().nullable(),
      handle: z.string().nullable(),
      id: z.string(),
      provider: z.string(),
      providerSubjectId: z.string(),
      providerTenantId: z.string(),
      // The state adapter keeps JSON, so a date comes back as a string.
      updatedAt: z.coerce.date(),
    }),
  ),
  user: z.object({
    displayName: z.string().nullable(),
    id: z.string(),
    isAdmin: z.boolean(),
    primaryEmail: z.string(),
  }),
});

/** One User and their user Identities, in provider, tenant, subject order. */
type CachedUser = z.infer<typeof cachedUserSchema>;

const versionSchema = z.object({
  token: z.string(),
  writtenAtMs: z.number(),
});

function versionKey(userId: string): string {
  return `junior:cache:${CACHE_NAMESPACE}:version:${userId}`;
}

function cache() {
  return createCache(getStateAdapter(), CACHE_NAMESPACE);
}

// Each write sets a new version, so a read that started before the write
// saves its rows under a version that no later read uses.
async function readVersion(userId: string) {
  const state = getStateAdapter();
  const stored = versionSchema.safeParse(await state.get(versionKey(userId)));
  if (stored.success) return stored.data;
  const created = { token: randomUUID(), writtenAtMs: 0 };
  if (await state.setIfNotExists(versionKey(userId), created, 2 * USER_TTL_MS))
    return created;
  return versionSchema.parse(await state.get(versionKey(userId)));
}

async function loadUser(
  db: JuniorDatabase,
  userId: string,
): Promise<CachedUser | null> {
  // Flat columns: Drizzle sets a nested left-joined object to null when its
  // first column is null, such as an Identity without a photo.
  const rows = await db
    .select({
      avatarUrl: juniorIdentities.avatarUrl,
      displayName: juniorIdentities.displayName,
      handle: juniorIdentities.handle,
      identityId: juniorIdentities.id,
      provider: juniorIdentities.provider,
      providerSubjectId: juniorIdentities.providerSubjectId,
      providerTenantId: juniorIdentities.providerTenantId,
      updatedAt: juniorIdentities.updatedAt,
      userDisplayName: juniorUsers.displayName,
      userId: juniorUsers.id,
      userIsAdmin: juniorUsers.isAdmin,
      userPrimaryEmail: juniorUsers.primaryEmail,
    })
    .from(juniorUsers)
    .leftJoin(
      juniorIdentities,
      and(
        eq(juniorIdentities.userId, juniorUsers.id),
        eq(juniorIdentities.kind, "user"),
      ),
    )
    .where(eq(juniorUsers.id, userId))
    .orderBy(
      asc(juniorIdentities.provider),
      asc(juniorIdentities.providerTenantId),
      asc(juniorIdentities.providerSubjectId),
    );
  const first = rows[0];
  if (!first) return null;
  return {
    identities: rows.flatMap((row) =>
      row.identityId &&
      row.provider &&
      row.providerSubjectId &&
      row.providerTenantId !== null &&
      row.updatedAt
        ? [
            {
              avatarUrl: row.avatarUrl,
              displayName: row.displayName,
              handle: row.handle,
              id: row.identityId,
              provider: row.provider,
              providerSubjectId: row.providerSubjectId,
              providerTenantId: row.providerTenantId,
              updatedAt: row.updatedAt,
            },
          ]
        : [],
    ),
    user: {
      displayName: first.userDisplayName,
      id: first.userId,
      isAdmin: first.userIsAdmin,
      primaryEmail: first.userPrimaryEmail,
    },
  };
}

/** Read one User and their user Identities by User id. */
async function readCachedUser(
  db: JuniorDatabase,
  userId: string,
): Promise<CachedUser | undefined> {
  const version = await readVersion(userId);
  const settled = Date.now() - version.writtenAtMs >= SETTLE_MS;
  const cached = await cache().getOrLoad(
    `user:${userId}:${version.token}`,
    async () => {
      const value = await loadUser(db, userId);
      if (!settled) return { value };
      return { value, ttlMs: value ? USER_TTL_MS : MISSING_TTL_MS };
    },
  );
  return cached ? cachedUserSchema.parse(cached) : undefined;
}

/**
 * Read one User and their user Identities by normalized primary email. A
 * primary email never changes, so the email to User id entry stays valid.
 * A missing User is not cached: a first sign-in can create it at any time.
 */
export async function readCachedUserByEmail(
  db: JuniorDatabase,
  normalizedEmail: string,
): Promise<CachedUser | undefined> {
  const userId = await cache().getOrLoad(
    emailKey(normalizedEmail),
    async () => {
      const rows = await db
        .select({ id: juniorUsers.id })
        .from(juniorUsers)
        .where(eq(juniorUsers.primaryEmailNormalized, normalizedEmail))
        .limit(1);
      const id = rows[0]?.id ?? null;
      return id ? { value: id, ttlMs: USER_TTL_MS } : { value: null };
    },
  );
  return userId ? await readCachedUser(db, userId) : undefined;
}

function emailKey(normalizedEmail: string): string {
  return `email:${normalizedEmail}`;
}

/** Clear the cached User after a write to their row or user Identities. */
export async function clearCachedUser(userId: string): Promise<void> {
  await getStateAdapter().set(
    versionKey(userId),
    { token: randomUUID(), writtenAtMs: Date.now() },
    2 * USER_TTL_MS,
  );
}
