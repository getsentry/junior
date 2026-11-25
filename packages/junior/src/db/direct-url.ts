const NEON_POOLER_SUFFIX = "-pooler";

/**
 * Pick the database URL for work that needs its own Postgres session, such as
 * the `junior upgrade` migration lock or a `LISTEN`.
 *
 * A transaction-mode pooler, such as Neon's `-pooler` endpoint, shares one
 * server session between clients. It keeps a session advisory lock after the
 * client leaves, and it does not support `LISTEN`. For Neon, use the
 * `DATABASE_URL` host without the `-pooler` suffix. The direct endpoint takes
 * the same user, password, database, and parameters, so it always reaches the
 * database that `DATABASE_URL` names.
 */
export function readDirectDatabaseUrl(databaseUrl: string): string {
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
