export const NO_REPLY_MARKER = "[[NO_REPLY]]";

/** Detect the reserved marker for intentionally completing without thread text. */
export function isNoReplyMarker(text: string): boolean {
  return text.trim() === NO_REPLY_MARKER;
}

/**
 * Detect intentional silence when the final assistant unit is only the marker.
 * Reasoning almost always comes before it as earlier text or an earlier line.
 */
export function isTrailingNoReplyUnit(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (isNoReplyMarker(trimmed)) return true;
  const lastLine = trimmed.split(/\r?\n/).at(-1)?.trim() ?? "";
  return isNoReplyMarker(lastLine);
}

/** Detect marker leaks before publication strips or rejects them. */
export function containsNoReplyMarker(text: string): boolean {
  return text.includes(NO_REPLY_MARKER);
}
