const NEON_POOLER_SUFFIX = "-pooler";

/**
 * Pick the database URL for `junior upgrade` migrations.
 *
 * The migration lock is a session advisory lock. A transaction-mode pooler,
 * such as Neon's `-pooler` endpoint, keeps that lock on its server session
 * after the client leaves. The next upgrade on another session then waits,
 * and one on the same session takes the lock again. For Neon, use the
 * `DATABASE_URL` host without the `-pooler` suffix. The direct endpoint takes
 * the same user, password, database, and parameters, so upgrade always
 * migrates the database that `DATABASE_URL` names.
 */
export function readMigrationDatabaseUrl(databaseUrl: string): string {
  // libpq URIs with an empty host, such as `postgresql://user@/db?host=/tmp`,
  // are not WHATWG URLs. They can't name a Neon endpoint.
  if (!URL.canParse(databaseUrl)) {
    return databaseUrl;
  }
  const url = new URL(databaseUrl);
  const [endpoint, ...domain] = url.hostname.split(".");
  if (
    !endpoint?.endsWith(NEON_POOLER_SUFFIX) ||
    !url.hostname.endsWith(".neon.tech")
  ) {
    return databaseUrl;
  }
  url.hostname = [
    endpoint.slice(0, -NEON_POOLER_SUFFIX.length),
    ...domain,
  ].join(".");
  return url.toString();
}
