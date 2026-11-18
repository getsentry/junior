// The Drizzle query builder wraps the driver error in `DrizzleQueryError` and
// keeps it as `cause`. Raw driver queries throw the driver error itself.
const MAX_CAUSE_DEPTH = 5;

/**
 * Return whether a PostgreSQL failure, or an error that it wraps as `cause`,
 * has the requested SQLSTATE.
 */
export function isPostgresErrorCode(error: unknown, code: string): boolean {
  let current = error;
  for (
    let depth = 0;
    depth < MAX_CAUSE_DEPTH && typeof current === "object" && current !== null;
    depth += 1
  ) {
    if ("code" in current && current.code === code) {
      return true;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}
