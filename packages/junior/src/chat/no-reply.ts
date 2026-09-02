export const NO_REPLY_MARKER = "[[NO_REPLY]]";

/**
 * True when one assistant message's text means intentional silence.
 *
 * Per-message only. Models often put reasoning first, then the marker:
 * - exact: `[[NO_REPLY]]`
 * - same message: `staying silent.\n[[NO_REPLY]]`
 * - same message, same line: `Done. [[NO_REPLY]]`
 *
 * Mid-sentence mentions do not match (`used [[NO_REPLY]] earlier`), so
 * normal answers can still talk about the marker. A silent message never
 * rewrites other assistant messages in the same turn.
 */
export function isNoReplyMarker(text: string): boolean {
  return text.trimEnd().endsWith(NO_REPLY_MARKER);
}

/** True when the marker appears anywhere in the text (telemetry only). */
export function containsNoReplyMarker(text: string): boolean {
  return text.includes(NO_REPLY_MARKER);
}
