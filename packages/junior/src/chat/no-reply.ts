export const NO_REPLY_MARKER = "[[NO_REPLY]]";

/**
 * True when this assistant text means intentional silence.
 *
 * Models often put reasoning first, then the marker:
 * - exact: `[[NO_REPLY]]`
 * - same message: `staying silent.\n[[NO_REPLY]]`
 * - same message, same line: `Done. [[NO_REPLY]]`
 *
 * Mid-sentence mentions do not match (`used [[NO_REPLY]] earlier`), so
 * normal answers can still talk about the marker.
 *
 * Call this on one assistant message, or on the last message in the terminal
 * assistant block. An earlier silent message must not silence a later normal
 * reply after tools.
 */
export function isNoReplyMarker(text: string): boolean {
  return text.trimEnd().endsWith(NO_REPLY_MARKER);
}

/** True when the marker appears anywhere in the text (telemetry only). */
export function containsNoReplyMarker(text: string): boolean {
  return text.includes(NO_REPLY_MARKER);
}
