import type { PluginContext } from "@sentry/junior-plugin-api";
import { and, eq, isNotNull, ne } from "drizzle-orm";
import type { SentryDb } from "../db/database.js";
import { juniorSentryInstallations } from "../db/schema.js";

const table = juniorSentryInstallations;
const INSTALLATIONS_CACHE_KEY = "installations";
// Install webhooks refresh the cache. The TTL only repairs a missed refresh.
const INSTALLATIONS_CACHE_MS = 5 * 60 * 1000;

/** One active installation of the public integration and its org. */
export interface SentryInstallation {
  installationUuid: string;
  /** Org slug. It is stored in lowercase. */
  orgSlug: string;
}

async function listSentryInstallations(
  db: SentryDb,
): Promise<SentryInstallation[]> {
  const rows = await db
    .select({
      installationUuid: table.installationUuid,
      orgSlug: table.orgSlug,
    })
    .from(table)
    .where(isNotNull(table.orgSlug));
  return rows.flatMap((row) =>
    row.orgSlug
      ? [{ installationUuid: row.installationUuid, orgSlug: row.orgSlug }]
      : [],
  );
}

/**
 * Read every active installation through the plugin cache, because egress
 * reads them for each Sentry API request. Pass `refresh` after a write.
 */
export async function activeSentryInstallations(
  ctx: Pick<PluginContext, "cache" | "db">,
  options?: { refresh?: boolean },
): Promise<SentryInstallation[]> {
  return await ctx.cache.getOrLoad(
    INSTALLATIONS_CACHE_KEY,
    async () => ({
      value: await listSentryInstallations(ctx.db as SentryDb),
      ttlMs: INSTALLATIONS_CACHE_MS,
    }),
    options,
  );
}

/**
 * Save one installation from an `installation.created` webhook, and return
 * true when it is new. A Sentry retry of the same webhook changes nothing,
 * and a removed installation is never added again. An older row for the
 * same org is stale, such as after a missed uninstall, so it is removed.
 */
export async function saveSentryInstallation(
  db: SentryDb,
  installation: SentryInstallation,
): Promise<boolean> {
  const orgSlug = installation.orgSlug.toLowerCase();
  return await db.transaction(async (tx) => {
    await tx
      .delete(table)
      .where(
        and(
          eq(table.orgSlug, orgSlug),
          ne(table.installationUuid, installation.installationUuid),
        ),
      );
    const inserted = await tx
      .insert(table)
      .values({
        installationUuid: installation.installationUuid,
        orgSlug,
        updatedAt: new Date(),
      })
      .onConflictDoNothing({ target: table.installationUuid })
      .returning({ installationUuid: table.installationUuid });
    return inserted.length > 0;
  });
}

/**
 * Mark an installation as removed after an `installation.deleted` webhook.
 * The row stays without an org, so a late install retry cannot add it again.
 */
export async function removeSentryInstallation(
  db: SentryDb,
  installationUuid: string,
): Promise<void> {
  const updatedAt = new Date();
  await db
    .insert(table)
    .values({ installationUuid, orgSlug: null, updatedAt })
    .onConflictDoUpdate({
      target: table.installationUuid,
      set: { orgSlug: null, updatedAt },
    });
}
