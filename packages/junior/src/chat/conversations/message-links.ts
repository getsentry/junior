import { createHash } from "node:crypto";

/**
 * Web link matches in message text. Slack wraps links as <url|label>, and
 * Markdown as (url), so a match stops at those delimiters. Trailing
 * punctuation is dropped. Readers parse a link before they show it.
 *
 * Migration `0112_attachment_url_fill` runs these patterns in Postgres to
 * fill links for older messages, so they use only syntax that JavaScript and
 * Postgres read the same way. The whitespace set is the one that JavaScript
 * `\s` matches, spelled out, because Postgres `\s` depends on the locale.
 */
const MESSAGE_URL_PATTERN = String.raw`https?://[^\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff<>|"'\u0060]+`;
const TRAILING_PUNCTUATION_PATTERN = String.raw`[.,;:!?)\]}*_~]+$`;

const messageUrlPattern = new RegExp(MESSAGE_URL_PATTERN, "g");
const trailingPunctuation = new RegExp(TRAILING_PUNCTUATION_PATTERN);

/**
 * Id of a Conversation's `url` Attachment. A repeat of the link in the
 * Conversation gets the same id. A link never holds a space, so the space
 * keeps the two parts apart. Migration `0112_attachment_url_fill` computes
 * the same id in SQL.
 */
export function urlAttachmentId(conversationId: string, url: string): string {
  return createHash("sha256").update(`${conversationId} ${url}`).digest("hex");
}

/** One link of a stored message. `position` starts at 1. */
type MessageLink = {
  conversationId: string;
  createdAt: Date;
  position: number;
  seq: number;
  url: string;
};

type LinkSourceRow = {
  conversationId: string;
  createdAt: Date;
  payload: Record<string, unknown>;
  seq: number;
  type: string;
};

/**
 * The links of one stored event payload, first match of each link only. Only
 * messages count, and a channel message that did not mention Junior stays
 * out, as in the transcript.
 */
function messageLinks(event: LinkSourceRow): MessageLink[] {
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
  const links = new Map<string, MessageLink>();
  for (const [index, match] of [
    ...text.matchAll(messageUrlPattern),
  ].entries()) {
    const url = match[0].replace(trailingPunctuation, "");
    if (links.has(url)) continue;
    links.set(url, {
      conversationId: event.conversationId,
      createdAt: event.createdAt,
      position: index + 1,
      seq: event.seq,
      url,
    });
  }
  return [...links.values()];
}

/**
 * The links that a batch of new event rows writes. Links keep the seq of the
 * first save of their message, like the transcript, and an edit replaces
 * them. `storedMessageSeqs` maps the Message ids that the batch edits to
 * their stored seqs; `replacedSeqs` names the stored seqs whose links go.
 */
export function batchMessageLinks(
  rows: readonly LinkSourceRow[],
  storedMessageSeqs: ReadonlyMap<string, number>,
): { links: MessageLink[]; replacedSeqs: number[] } {
  const seqById = new Map(storedMessageSeqs);
  const linksBySeq = new Map<number, MessageLink[]>();
  const replacedSeqs = new Set<number>();
  for (const row of rows) {
    const { messageId } = row.payload;
    if (row.type === "message") {
      if (typeof messageId === "string" && !seqById.has(messageId)) {
        seqById.set(messageId, row.seq);
      }
      linksBySeq.set(row.seq, messageLinks(row));
      continue;
    }
    if (row.type !== "message_updated" || typeof messageId !== "string") {
      continue;
    }
    const seq = seqById.get(messageId);
    if (seq === undefined) continue;
    if (storedMessageSeqs.get(messageId) === seq) replacedSeqs.add(seq);
    linksBySeq.set(seq, messageLinks({ ...row, seq, type: "message" }));
  }
  return {
    links: [...linksBySeq.values()].flat(),
    replacedSeqs: [...replacedSeqs],
  };
}
