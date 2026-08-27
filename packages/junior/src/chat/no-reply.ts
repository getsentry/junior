export const NO_REPLY_MARKER = "[[NO_REPLY]]";

/** Detect the reserved marker for intentionally completing without thread text. */
export function isNoReplyMarker(text: string): boolean {
  return text.trim() === NO_REPLY_MARKER;
}

/** Detect marker leaks before publication strips or rejects them. */
export function containsNoReplyMarker(text: string): boolean {
  return text.includes(NO_REPLY_MARKER);
}

/**
 * Remove no-reply protocol markers from assistant text.
 *
 * Exact marker-only replies stay empty. Mixed replies keep the remaining text so
 * prose that discusses the marker still delivers.
 */
export function stripNoReplyMarkers(text: string): string {
  return text.split(NO_REPLY_MARKER).join("").trim();
}
