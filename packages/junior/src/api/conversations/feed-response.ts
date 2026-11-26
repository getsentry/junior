import type {
  ConversationFeed,
  ConversationFeedItem,
} from "../schema/conversation-feed";
import { metrics } from "@/chat/sentry";
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
 * The same sizes go to span attributes and to metrics.
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
    "participants",
    "sidebarAnnotations",
    "threads",
  ] as const satisfies readonly (keyof ConversationFeedItem)[];
  const chars = {
    activityPreview: 0,
    participants: 0,
    sidebarAnnotations: 0,
    threads: 0,
  };
  const rows = feed.conversations.map((row) => {
    const {
      activityPreview: _activityPreview,
      participants: _participants,
      sidebarAnnotations: _sidebarAnnotations,
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
  const threads = countThreads(feed.conversations);
  // Spans are sampled. These metrics show the size of every feed response,
  // so the fields that fill large responses show in aggregate.
  metrics.distribution("conversation_feed.response.chars", body.length);
  for (const [field, value] of [
    ["activity_preview", chars.activityPreview],
    ["participants", chars.participants],
    ["sidebar_annotations", chars.sidebarAnnotations],
    ["threads", chars.threads],
  ] as const) {
    metrics.distribution("conversation_feed.response.field_chars", value, {
      attributes: { "app.api.response.field": field },
    });
  }
  metrics.distribution("conversation_feed.rows", feed.conversations.length);
  metrics.distribution("conversation_feed.threads", threads);
  metrics.distribution("conversation_feed.waiting_rows", waitingRows);
  return {
    attributes: {
      "app.api.response.field_chars.activity_preview": chars.activityPreview,
      "app.api.response.field_chars.participants": chars.participants,
      "app.api.response.field_chars.sidebar_annotations":
        chars.sidebarAnnotations,
      "app.api.response.field_chars.threads": chars.threads,
      "app.conversation_feed.rows": feed.conversations.length,
      "app.conversation_feed.threads": threads,
      "app.conversation_feed.waiting_rows": waitingRows,
    },
    body,
  };
}
