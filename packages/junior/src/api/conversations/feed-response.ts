import type {
  ConversationFeed,
  ConversationFeedItem,
} from "../schema/conversation-feed";
import type { SerializedResponse } from "../http";

function countThreads(rows: readonly ConversationFeedItem[]): number {
  let count = 0;
  for (const row of rows) {
    if (row.threads) count += row.threads.length + countThreads(row.threads);
  }
  return count;
}

/**
 * Serialize a parsed feed to JSON, and report how many chars the large row
 * fields take. Top-level rows only: `threads` holds the nested Threads with
 * all their fields. `waitingRows` counts the rows from outside the page.
 */
export function serializeConversationFeed(
  feed: ConversationFeed,
  waitingRows: number,
): SerializedResponse {
  // Row fields that can fill a response. Each is serialized on its own and
  // spliced into its row, so the response is serialized once and each
  // field's size is known.
  const measured = [
    "activityPreview",
    "annotations",
    "participants",
    "threads",
  ] as const satisfies readonly (keyof ConversationFeedItem)[];
  const chars = {
    activityPreview: 0,
    annotations: 0,
    participants: 0,
    threads: 0,
  };
  const rows = feed.conversations.map((row) => {
    const {
      activityPreview: _activityPreview,
      annotations: _annotations,
      participants: _participants,
      threads: _threads,
      ...rest
    } = row;
    let json = JSON.stringify(rest).slice(0, -1);
    for (const key of measured) {
      if (row[key] === undefined) continue;
      const value = JSON.stringify(row[key]);
      chars[key] += value.length;
      json += `,"${key}":${value}`;
    }
    return `${json}}`;
  });
  const { conversations: _conversations, ...meta } = feed;
  // `meta` always has `source` and `generatedAt`, so it is never `{}`.
  const body = `{"conversations":[${rows.join(",")}],${JSON.stringify(meta).slice(1)}`;
  return {
    attributes: {
      "app.api.response.field_chars.activity_preview": chars.activityPreview,
      "app.api.response.field_chars.annotations": chars.annotations,
      "app.api.response.field_chars.participants": chars.participants,
      "app.api.response.field_chars.threads": chars.threads,
      "app.conversation_feed.rows": feed.conversations.length,
      "app.conversation_feed.threads": countThreads(feed.conversations),
      "app.conversation_feed.waiting_rows": waitingRows,
    },
    body,
  };
}
