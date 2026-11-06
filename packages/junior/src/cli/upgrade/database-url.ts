import type { SqlDriver } from "@/chat/config";

const NEON_POOLER_SUFFIX = "-pooler";

/**
 * Pick the database URL for `junior upgrade` migrations.
 *
 * The migration lock is a session advisory lock. A transaction-mode pooler,
 * such as Neon's `-pooler` endpoint, keeps that lock on its server session
 * after the client leaves. The next upgrade on another session then waits,
 * and one on the same session takes the lock again. For Neon, use
 * the direct endpoint: `DATABASE_URL_UNPOOLED` when the Vercel integration
 * sets it, else the `DATABASE_URL` host without the `-pooler` suffix.
 */
export function readMigrationDatabaseUrl(args: {
  databaseUrl: string;
  driver: SqlDriver;
  env: NodeJS.ProcessEnv;
}): string {
  // With the postgres driver, such as a local database, an unpooled URL
  // pulled from a Vercel project would point at another database.
  if (args.driver !== "neon") {
    return args.databaseUrl;
  }
  const unpooledUrl = args.env.DATABASE_URL_UNPOOLED?.trim();
  if (unpooledUrl) {
    return unpooledUrl;
  }
  const url = new URL(args.databaseUrl);
  const [endpoint, ...domain] = url.hostname.split(".");
  if (
    !endpoint?.endsWith(NEON_POOLER_SUFFIX) ||
    !url.hostname.endsWith(".neon.tech")
  ) {
    return args.databaseUrl;
  }
  url.hostname = [
    endpoint.slice(0, -NEON_POOLER_SUFFIX.length),
    ...domain,
  ].join(".");
  return url.toString();
}
