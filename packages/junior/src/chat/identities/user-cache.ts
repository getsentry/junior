/**
 * Cache of each User and their user Identities, and of the linked handles
 * that person lookups find. Every signed-in request resolves its viewer,
 * webhooks read the person who asked for a pull request, and tools turn a
 * named person into a provider handle, so these reads go to the state cache
 * instead of the database and Slack.
 *
 * Every write to a cached column or to a user Identity must call
 * `clearCachedUser`, and every write that changes a linked handle must call
 * `clearCachedLinkedHandles`. The other columns of a User, such as the
 * timezone or the customization, are not in the cache.
 */
import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import {
  CACHE_LOAD_TIMEOUT_MS,
  type PluginLinkedHandleLookup,
  untilAborted,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import { getStateAdapter } from "@/chat/state/adapter";
import { cacheKeyPrefix, createCache } from "@/chat/state/cache";
import type { JuniorDatabase } from "@/db/db";
import { juniorIdentities, juniorUsers } from "@/db/schema";

// A write clears the entry, so the TTL is only a safety net.
const USER_TTL_MS = 24 * 60 * 60 * 1000;
// A first sign-in creates the User, so remember a missing one only briefly.
const MISSING_TTL_MS = 60 * 1000;
// A link change clears linked handles, so the TTL bounds only Slack
// directory changes, such as a new person with the same name. When Slack
// fails after the TTL, the last handle serves for one more day.
const LINKED_HANDLE_TTL_MS = 60 * 60 * 1000;
// A write clears the cache before its transaction commits. Reads in this
// window go to the database and do not fill the cache, so a read of the
// rows from before the write cannot stay in the cache.
const SETTLE_MS = 10 * 1000;
/** The cache namespace of every key in this cache. */
export const USER_CACHE_NAMESPACE = "identities";

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
  return `${cacheKeyPrefix(USER_CACHE_NAMESPACE)}version:${userId}`;
}

// A lookup for one provider matches the Identities of every provider, so
// one version covers every linked handle.
const LINKED_HANDLE_VERSION_KEY = `${cacheKeyPrefix(USER_CACHE_NAMESPACE)}linked-handle-version`;

function cache() {
  return createCache(getStateAdapter(), USER_CACHE_NAMESPACE);
}

// Each write sets a new version, so a read that started before the write
// saves its rows under a version that no later read uses.
async function readVersion(key: string) {
  const state = getStateAdapter();
  const stored = versionSchema.safeParse(await state.get(key));
  if (stored.success) return stored.data;
  const created = { token: randomUUID(), writtenAtMs: 0 };
  if (await state.setIfNotExists(key, created, 2 * USER_TTL_MS)) return created;
  return versionSchema.parse(await state.get(key));
}

async function writeVersion(key: string): Promise<void> {
  await getStateAdapter().set(
    key,
    { token: randomUUID(), writtenAtMs: Date.now() },
    2 * USER_TTL_MS,
  );
}

function isSettled(version: z.infer<typeof versionSchema>): boolean {
  return Date.now() - version.writtenAtMs >= SETTLE_MS;
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
  const version = await readVersion(versionKey(userId));
  const settled = isSettled(version);
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

/**
 * Read the User of one user Identity, with their user Identities, by
 * Identity id. A linked Identity never moves to another User, so the
 * Identity id to User id entry stays valid. An Identity without a User is
 * remembered only briefly, and a link clears it with
 * `clearCachedIdentityUser`. The caller checks that the User still has the
 * Identity, as an unlink deletes it.
 */
export async function readCachedUserByIdentityId(
  db: JuniorDatabase,
  identityId: string,
): Promise<CachedUser | undefined> {
  const userId = await cache().getOrLoad(`identity:${identityId}`, async () => {
    const rows = await db
      .select({ userId: juniorIdentities.userId })
      .from(juniorIdentities)
      .where(
        and(
          eq(juniorIdentities.id, identityId),
          eq(juniorIdentities.kind, "user"),
        ),
      )
      .limit(1);
    const id = rows[0]?.userId ?? null;
    return { value: id, ttlMs: id ? USER_TTL_MS : MISSING_TTL_MS };
  });
  return userId ? await readCachedUser(db, userId) : undefined;
}

/** Clear the cached User of one Identity after a write gives it a User. */
export async function clearCachedIdentityUser(
  identityId: string,
): Promise<void> {
  await cache().delete(`identity:${identityId}`);
}

/**
 * Read the linked `provider` handle that one person lookup found, or run
 * `load`. Only a found handle is cached, and it serves stale when a later
 * load fails, such as during a Slack outage. Any other answer can change
 * when a person joins or links an account, so it is loaded each time.
 */
export async function readCachedLinkedHandle(
  lookup: {
    provider: string;
    providers: string[];
    query: string;
    teamId: string;
  },
  load: () => Promise<PluginLinkedHandleLookup>,
): Promise<PluginLinkedHandleLookup> {
  const version = await readVersion(LINKED_HANDLE_VERSION_KEY);
  const settled = isSettled(version);
  // The query can be long, so the key holds its hash.
  const lookupHash = createHash("sha256")
    .update(
      JSON.stringify([
        lookup.teamId,
        [...lookup.providers].sort(),
        lookup.query,
      ]),
    )
    .digest("hex");
  return await cache().getOrLoad<PluginLinkedHandleLookup>(
    `linked-handle:${lookup.provider}:${version.token}:${lookupHash}`,
    async () => {
      // The lookup searches Slack, stored accounts, and plugins at once, so
      // the load stops waiting for it instead of ending each search.
      const value = await untilAborted(
        load(),
        AbortSignal.timeout(CACHE_LOAD_TIMEOUT_MS),
      );
      return value.status === "found" && settled
        ? { value, ttlMs: LINKED_HANDLE_TTL_MS, staleIfError: true }
        : { value };
    },
  );
}

/** Clear the cached User after a write to their row or user Identities. */
export async function clearCachedUser(userId: string): Promise<void> {
  await writeVersion(versionKey(userId));
}

/**
 * Clear every cached linked handle after a write that links, changes, or
 * unlinks an Identity of any provider.
 */
export async function clearCachedLinkedHandles(): Promise<void> {
  await writeVersion(LINKED_HANDLE_VERSION_KEY);
}
