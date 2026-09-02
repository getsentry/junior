export const NO_REPLY_MARKER = "[[NO_REPLY]]";

/**
 * True when one assistant message ends with the silence marker.
 * Mid-sentence mentions do not match. Detection is per message only.
 */
export function isNoReplyMarker(text: string): boolean {
  return text.trimEnd().endsWith(NO_REPLY_MARKER);
}
