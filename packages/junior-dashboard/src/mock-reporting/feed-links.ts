import {
  CONVERSATION_FEED_LINK_LIMIT,
  type ConversationDetailReport,
} from "@sentry/junior/api/schema";

const URL_PATTERN = /https?:\/\/[^\s<>|"'`]+/g;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}*_~]+$/;

function cleanUrl(match: string): string | undefined {
  const trimmed = match.replace(TRAILING_PUNCTUATION, "");
  return URL.canParse(trimmed) ? new URL(trimmed).href : undefined;
}

/**
 * Match the API feed: up to three distinct web links from a Conversation's
 * messages, newest first, leaving out its own Annotations and links back to
 * itself.
 */
export function mockFeedLinks(
  conversation: ConversationDetailReport,
): string[] | undefined {
  const shown = new Set(
    (conversation.annotations ?? []).flatMap(({ url }) => {
      const href = url ? cleanUrl(url) : undefined;
      return href ? [href] : [];
    }),
  );
  const self = `/conversations/${encodeURIComponent(conversation.conversationId)}`;
  const links: string[] = [];
  for (const { data } of [...conversation.events].reverse()) {
    if (data.type !== "message") continue;
    for (const [match] of (data.text ?? "").matchAll(URL_PATTERN)) {
      const href = cleanUrl(match);
      if (
        !href ||
        links.includes(href) ||
        shown.has(href) ||
        new URL(href).pathname === self
      ) {
        continue;
      }
      links.push(href);
      if (links.length === CONVERSATION_FEED_LINK_LIMIT) return links;
    }
  }
  return links.length > 0 ? links : undefined;
}
