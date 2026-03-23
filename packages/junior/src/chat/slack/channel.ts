import {
  getSlackClient,
  normalizeSlackConversationId,
  withSlackRetries,
} from "@/chat/slack/client";
import { normalizeSlackEmojiName } from "@/chat/slack/emoji";

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

export async function postMessageToChannel(input: {
  channelId: string;
  text: string;
}): Promise<{ ts: string; permalink?: string }> {
  const client = getSlackClient();
  const channelId = normalizeSlackConversationId(input.channelId);
  if (!channelId) {
    throw new Error(
      "Slack channel message posting requires a valid channel ID",
    );
  }
  const response = await withSlackRetries(
    () =>
      client.chat.postMessage({
        channel: channelId,
        text: input.text,
        mrkdwn: true,
      }),
    3,
    { action: "chat.postMessage" },
  );

  if (!response.ts) {
    throw new Error("Slack channel message posted without ts");
  }

  let permalink: string | undefined;
  try {
    const permalinkResponse = await withSlackRetries(
      () =>
        client.chat.getPermalink({
          channel: channelId,
          message_ts: response.ts as string,
        }),
      3,
      { action: "chat.getPermalink" },
    );
    permalink = permalinkResponse.permalink;
  } catch {
    // Message creation succeeded; permalink lookup is best-effort.
  }

  return {
    ts: response.ts,
    permalink,
  };
}

export async function addReactionToMessage(input: {
  channelId: string;
  timestamp: string;
  emoji: string;
}): Promise<{ ok: true }> {
  const client = getSlackClient();
  const channelId = normalizeSlackConversationId(input.channelId);
  if (!channelId) {
    throw new Error("Slack reaction requires a valid channel ID");
  }
  const timestamp = input.timestamp.trim();
  if (!timestamp) {
    throw new Error("Slack reaction requires a target message timestamp");
  }
  const emoji = normalizeSlackEmojiName(input.emoji);
  if (!emoji) {
    throw new Error("Slack reaction requires a valid emoji alias name");
  }

  await withSlackRetries(
    () =>
      client.reactions.add({
        channel: channelId,
        timestamp,
        name: emoji,
      }),
    3,
    { action: "reactions.add" },
  );
  return { ok: true };
}

export async function removeReactionFromMessage(input: {
  channelId: string;
  timestamp: string;
  emoji: string;
}): Promise<{ ok: true }> {
  const client = getSlackClient();
  const channelId = normalizeSlackConversationId(input.channelId);
  if (!channelId) {
    throw new Error("Slack reaction requires a valid channel ID");
  }
  const timestamp = input.timestamp.trim();
  if (!timestamp) {
    throw new Error("Slack reaction requires a target message timestamp");
  }
  const emoji = normalizeSlackEmojiName(input.emoji);
  if (!emoji) {
    throw new Error("Slack reaction requires a valid emoji alias name");
  }

  await withSlackRetries(
    () =>
      client.reactions.remove({
        channel: channelId,
        timestamp,
        name: emoji,
      }),
    3,
    { action: "reactions.remove" },
  );
  return { ok: true };
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
