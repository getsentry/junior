export const NO_REPLY_MARKER = "[[NO_REPLY]]";

/**
 * Trailing marker for a Quiet message: an Event Turn reply that Junior stores
 * but does not deliver to the Location.
 */
export const QUIET_MARKER = "[[QUIET]]";

/**
 * True when one assistant message ends with the silence marker, or is only
 * the quiet marker. Mid-sentence mentions do not match. Detection is per
 * message only.
 */
export function isNoReplyMarker(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.endsWith(NO_REPLY_MARKER) || trimmed === QUIET_MARKER;
}

/**
 * Return the text before a trailing quiet marker, or undefined when the text
 * does not end with one. Mid-sentence mentions do not match.
 */
export function stripQuietMarker(text: string): string | undefined {
  const trimmed = text.trimEnd();
  if (!trimmed.endsWith(QUIET_MARKER)) return undefined;
  return trimmed.slice(0, -QUIET_MARKER.length).trimEnd();
}
