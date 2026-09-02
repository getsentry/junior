export const NO_REPLY_MARKER = "[[NO_REPLY]]";

const TRAILING_NO_REPLY_MARKER_PATTERN = new RegExp(
  `(?:\\s*${escapeRegExp(NO_REPLY_MARKER)})+\\s*$`,
);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Detect the reserved marker for intentionally completing without thread text. */
export function isNoReplyMarker(text: string): boolean {
  return text.trim() === NO_REPLY_MARKER;
}

/**
 * Detect intentional silence when the model ends with the marker, including
 * prose that ends in the marker (common model misfire on silent tasks).
 */
export function endsWithNoReplyMarker(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (isNoReplyMarker(trimmed)) return true;
  return TRAILING_NO_REPLY_MARKER_PATTERN.test(trimmed);
}

/** Detect marker leaks before publication strips or rejects them. */
export function containsNoReplyMarker(text: string): boolean {
  return text.includes(NO_REPLY_MARKER);
}

/**
 * Remove trailing intentional-silence markers and any remaining marker leaks
 * from destination-visible text.
 */
export function stripNoReplyMarkers(text: string): string {
  return text
    .replace(TRAILING_NO_REPLY_MARKER_PATTERN, "")
    .replace(
      new RegExp(`\\s*${escapeRegExp(NO_REPLY_MARKER)}\\s*`, "g"),
      " ",
    )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
