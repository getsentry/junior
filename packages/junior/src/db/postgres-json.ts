/**
 * Replace actual NUL characters that PostgreSQL cannot store in JSONB.
 * Literal `\\u0000` text is preserved because it contains no NUL character.
 */
export function sanitizePostgresJson<T>(value: T): T {
  if (typeof value === "string") {
    return value.replaceAll("\u0000", " ") as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizePostgresJson(item)) as T;
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      sanitizePostgresJson(item),
    ]),
  ) as T;
}
