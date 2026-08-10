import { getSlackClient, withSlackRetries } from "@/chat/slack/client";
import type { SlackChannelId } from "@/chat/slack/ids";
import type { SlackMessageTs } from "@/chat/slack/timestamp";

export interface SlackChannelMessage {
  ts?: string;
  user?: string;
  text?: string;
  thread_ts?: string;
  subtype?: string;
  bot_id?: string;
  type?: string;
  attachments?: unknown[];
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
  attachments?: unknown[];
}

/** List channel history using Slack-native, pre-validated timestamp bounds. */
export async function listChannelMessages(input: {
  channelId: SlackChannelId;
  limit: number;
  cursor?: string;
  oldest?: SlackMessageTs;
  latest?: SlackMessageTs;
  inclusive?: boolean;
  maxPages?: number;
}): Promise<{ messages: SlackChannelMessage[]; nextCursor?: string }> {
  const client = getSlackClient();
  const channelId = input.channelId;
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

/** Read replies from a Slack thread identified by a validated native thread timestamp. */
export async function listThreadReplies(input: {
  channelId: SlackChannelId;
  threadTs: SlackMessageTs;
  limit?: number;
  maxPages?: number;
  targetMessageTs?: string[];
}): Promise<SlackThreadReply[]> {
  const client = getSlackClient();
  const channelId = input.channelId;
  const targetLimit = Math.max(1, Math.min(input.limit ?? 1000, 1000));
  const maxPages = Math.max(1, Math.min(input.maxPages ?? 10, 10));
  const pendingTargets = new Set(
    (input.targetMessageTs ?? []).filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    ),
  );
  const hasTargetMessages = pendingTargets.size > 0;
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
    if (!cursor || (hasTargetMessages && pendingTargets.size === 0)) {
      break;
    }
  }

  return replies.slice(0, targetLimit);
}

export interface SlackConversationInfo {
  id: SlackChannelId;
  name?: string;
  isChannel: boolean;
  isPrivate: boolean;
  isIm: boolean;
  isMpim: boolean;
  isMember?: boolean;
}

/** Load conversation metadata used for cross-channel read access checks. */
export async function getConversationInfo(
  channelId: SlackChannelId,
): Promise<SlackConversationInfo> {
  const client = getSlackClient();
  const response = await withSlackRetries(
    () =>
      client.conversations.info({
        channel: channelId,
      }),
    3,
    { action: "conversations.info", idempotent: true },
  );

  const channel = response.channel;
  if (!channel || typeof channel !== "object") {
    throw new Error(`Slack conversations.info returned no channel for ${channelId}`);
  }

  const record = channel as {
    id?: string;
    name?: string;
    is_channel?: boolean;
    is_private?: boolean;
    is_im?: boolean;
    is_mpim?: boolean;
    is_member?: boolean;
  };

  return {
    id: channelId,
    ...(typeof record.name === "string" && record.name
      ? { name: record.name }
      : {}),
    isChannel: record.is_channel === true,
    isPrivate: record.is_private === true,
    isIm: record.is_im === true,
    isMpim: record.is_mpim === true,
    ...(typeof record.is_member === "boolean"
      ? { isMember: record.is_member }
      : {}),
  };
}
