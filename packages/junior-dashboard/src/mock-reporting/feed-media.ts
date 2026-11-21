import type {
  ConversationDetailReport,
  ConversationFeedItem,
} from "@sentry/junior/api/schema";

type ConversationFeedMedia = NonNullable<ConversationFeedItem["media"]>[number];

/** The API's `CONVERSATION_FEED_MEDIA_LIMIT`, which its barrel doesn't export. */
const CONVERSATION_FEED_MEDIA_LIMIT = 3;

/**
 * Match the API feed: a Conversation's newest stored files. Files sent
 * together share a time, so they keep the order they were sent in. Mock
 * files reuse ids, so the filename tells them apart.
 */
export function mockFeedMedia(
  conversation: ConversationDetailReport,
): ConversationFeedMedia[] | undefined {
  const media: ConversationFeedMedia[] = [];
  const seen = new Set<string>();
  for (const { data } of [...conversation.events].reverse()) {
    if (data.type !== "message" && data.type !== "attachments_delivered") {
      continue;
    }
    for (const { contentType, filename, id } of data.attachments ?? []) {
      const key = `${id}\n${filename}`;
      if (seen.has(key)) continue;
      seen.add(key);
      media.push({ contentType, filename, id });
    }
  }
  return media.length > 0
    ? media.slice(0, CONVERSATION_FEED_MEDIA_LIMIT)
    : undefined;
}
