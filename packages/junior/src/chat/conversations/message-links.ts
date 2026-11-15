/**
 * Raw web link matches in message text. Slack wraps links as <url|label>,
 * and Markdown as (url), so a match stops at those delimiters. Readers trim
 * and parse a match before they show it.
 *
 * Migration `0111_conversation_links` runs this pattern in Postgres to fill
 * links for older messages, so it uses only syntax that JavaScript and
 * Postgres read the same way. The whitespace set is the one that JavaScript
 * `\s` matches, spelled out, because Postgres `\s` depends on the locale.
 */
const MESSAGE_URL_PATTERN = String.raw`https?://[^\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff<>|"'\u0060]+`;

const messageUrlPattern = new RegExp(MESSAGE_URL_PATTERN, "g");

/** One raw link match of a stored message event. `position` starts at 1. */
type MessageLinkRow = {
  conversationId: string;
  position: number;
  seq: number;
  url: string;
};

/**
 * The link rows of one stored event payload. Only messages count, and a
 * channel message that did not mention Junior stays out, as in the
 * transcript.
 */
export function messageLinkRows(event: {
  conversationId: string;
  payload: Record<string, unknown>;
  seq: number;
  type: string;
}): MessageLinkRow[] {
  const { meta, text } = event.payload;
  if (event.type !== "message" || typeof text !== "string") return [];
  const mention =
    meta !== null &&
    typeof meta === "object" &&
    !Array.isArray(meta) &&
    "explicitMention" in meta
      ? meta.explicitMention
      : undefined;
  if (mention === false || mention === "false") return [];
  return Array.from(text.matchAll(messageUrlPattern), (match, index) => ({
    conversationId: event.conversationId,
    position: index + 1,
    seq: event.seq,
    url: match[0],
  }));
}
