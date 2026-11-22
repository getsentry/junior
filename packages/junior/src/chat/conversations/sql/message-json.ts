import { sql, type SQL } from "drizzle-orm";

// Agent history is stored with JSON.stringify, so its text is valid JSON.
// jsonb rejects only some `\uXXXX` escapes, such as a NUL character or a
// lone surrogate from text cut inside an emoji. This regex finds each
// `\uXXXX` escape that is not itself escaped: it follows an even number of
// backslashes.
const UNICODE_ESCAPE = String.raw`\u`;
const UNICODE_ESCAPE_PATTERN = String.raw`(?<!\\)((?:\\\\)*)\\u[0-9a-fA-F]{4}`;
const UNICODE_ESCAPE_REPLACEMENT = String.raw`\1`;

/**
 * Cast the stored JSON string of an agent history message to jsonb. One
 * message that jsonb rejects would fail its whole query, so the cast drops
 * every Unicode escape. JSON.stringify writes them only for control
 * characters and lone surrogates.
 */
export function storedMessageJson(messageText: SQL): SQL {
  return sql`CASE
    WHEN strpos(${messageText}, ${UNICODE_ESCAPE}) = 0 THEN (${messageText})::jsonb
    ELSE regexp_replace(${messageText}, ${UNICODE_ESCAPE_PATTERN}, ${UNICODE_ESCAPE_REPLACEMENT}, 'g')::jsonb
  END`;
}
