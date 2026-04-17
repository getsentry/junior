import {
  getSlackClient,
  normalizeSlackConversationId,
  withSlackRetries,
} from "@/chat/slack/client";

export interface SlackChannelMessage {
  ts?: string;
  user?: string;
  text?: string;
  thread_ts?: string;
  subtype?: string;
  bot_id?: string;
  type?: string;
}

export interface SlackFileRef {
  id?: string;
  mimetype?: string;
  name?: string;
  size?: number;
  url_private?: string;
  url_private_download?: string;
}

export interface SlackThreadReply {
  ts?: string;
  user?: string;
  text?: string;
  thread_ts?: string;
  subtype?: string;
  bot_id?: string;
  type?: string;
  files?: SlackFileRef[];
}

export async function listChannelMessages(input: {
  channelId: string;
  limit: number;
  cursor?: string;
  oldest?: string;
  latest?: string;
  inclusive?: boolean;
  maxPages?: number;
}): Promise<{ messages: SlackChannelMessage[]; nextCursor?: string }> {
  const client = getSlackClient();
  const channelId = normalizeSlackConversationId(input.channelId);
  if (!channelId) {
    throw new Error("Slack channel history lookup requires a valid channel ID");
  }
  const targetLimit = Math.max(1, Math.min(input.limit, 1000));
  const maxPages = Math.max(1, Math.min(input.maxPages ?? 5, 10));
  const messages: SlackChannelMessage[] = [];
  let cursor = input.cursor;
  let pages = 0;

  while (messages.length < targetLimit && pages < maxPages) {
    pages += 1;
    const pageLimit = Math.max(1, Math.min(200, targetLimit - messages.length));
    const response = await withSlackRetries(
      () =>
        client.conversations.history({
          channel: channelId,
          limit: pageLimit,
          cursor,
          oldest: input.oldest,
          latest: input.latest,
          inclusive: input.inclusive,
        }),
      3,
      { action: "conversations.history" },
    );

    const batch = (response.messages ?? []) as SlackChannelMessage[];
    messages.push(...batch);
    cursor = response.response_metadata?.next_cursor || undefined;

    if (!cursor) {
      break;
    }
  }

  return {
    messages: messages.slice(0, targetLimit),
    nextCursor: cursor,
  };
}

export async function listThreadReplies(input: {
  channelId: string;
  threadTs: string;
  limit?: number;
  maxPages?: number;
  targetMessageTs?: string[];
}): Promise<SlackThreadReply[]> {
  const client = getSlackClient();
  const channelId = normalizeSlackConversationId(input.channelId);
  if (!channelId) {
    throw new Error("Slack thread reply lookup requires a valid channel ID");
  }
  const targetLimit = Math.max(1, Math.min(input.limit ?? 1000, 1000));
  const maxPages = Math.max(1, Math.min(input.maxPages ?? 10, 10));
  const pendingTargets = new Set(
    (input.targetMessageTs ?? []).filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    ),
  );
  const replies: SlackThreadReply[] = [];
  let cursor: string | undefined;
  let pages = 0;

  while (replies.length < targetLimit && pages < maxPages) {
    pages += 1;
    const pageLimit = Math.max(1, Math.min(200, targetLimit - replies.length));
    const response = await withSlackRetries(
      () =>
        client.conversations.replies({
          channel: channelId,
          ts: input.threadTs,
          limit: pageLimit,
          cursor,
        }),
      3,
      { action: "conversations.replies" },
    );

    const batch = (response.messages ?? []) as SlackThreadReply[];
    replies.push(...batch);
    for (const reply of batch) {
      if (typeof reply.ts === "string" && pendingTargets.size > 0) {
        pendingTargets.delete(reply.ts);
      }
    }
    cursor = response.response_metadata?.next_cursor || undefined;
    if (!cursor || pendingTargets.size === 0) {
      break;
    }
  }

  return replies.slice(0, targetLimit);
}
