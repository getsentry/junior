/** The longest activity preview text, so feed rows stay small. */
export const ACTIVITY_PREVIEW_MAX_LENGTH = 400;

// A Slack token that the cut left open at the end, such as `<@U1`, `<htt`, or
// `<https://x|the`. A `<` in prose, such as `a < b`, does not match.
const CUT_TOKEN_RE = /<(?:[@#!][^<>]*|[a-z]+:[^\s<>|]*(?:\|[^<>]*)?|[a-z]*)$/i;

/**
 * Cut preview text to the schema limit. The cut ends with "…" at a word
 * break, and never leaves half a surrogate pair or an unclosed Slack token
 * such as `<@U1` or `<https://…`, so mentions and links still parse.
 */
export function activityPreviewText(text: string): string {
  if (text.length <= ACTIVITY_PREVIEW_MAX_LENGTH) return text;
  let cut = text.slice(0, ACTIVITY_PREVIEW_MAX_LENGTH - 1);
  // End at a word break, so a bare URL or a word is not left half.
  const space = cut.search(/\s\S*$/);
  if (space > 0 && /\S/.test(text[cut.length]!)) cut = cut.slice(0, space);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut.replace(CUT_TOKEN_RE, "").trimEnd()}…`;
}
