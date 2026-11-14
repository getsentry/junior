import type {
  ConversationsHistoryResponse,
  ConversationsRepliesResponse,
} from "@slack/web-api";
import * as z from "zod";
import { getSlackClient, withSlackRetries } from "@/chat/slack/client";
import type { SlackChannelId } from "@/chat/slack/ids";
import type { SlackMessageTs } from "@/chat/slack/timestamp";

type SlackChannelMessage = NonNullable<
  ConversationsHistoryResponse["messages"]
>[number];
// The replies response omits subtype, although history includes it.
const replySubtypeSchema = z.object({
  subtype: z.string().optional(),
}) satisfies z.ZodType<Pick<SlackChannelMessage, "subtype">>;
export type SlackThreadReply = NonNullable<
  ConversationsRepliesResponse["messages"]
>[number] &
  z.output<typeof replySubtypeSchema>;
export type SlackFileRef = NonNullable<SlackThreadReply["files"]>[number];

/** List channel history using Slack-native, pre-validated timestamp bounds. */
export async function listChannelMessages(input: {
  channelId: SlackChannelId;
  limit: number;
  cursor?: string | undefined;
  oldest?: SlackMessageTs | undefined;
  latest?: SlackMessageTs | undefined;
  inclusive?: boolean | undefined;
  maxPages?: number | undefined;
}): Promise<{
  messages: SlackChannelMessage[];
  nextCursor?: string | undefined;
}> {
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

    const batch = response.messages ?? [];
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
  maxPages?: number | undefined;
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

    const batch = response.messages ?? [];
    replies.push(
      ...batch.map((reply) => ({
        ...reply,
        ...replySubtypeSchema.parse(reply),
      })),
    );
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
  topic?: string;
  /** Slack shows the channel purpose as its description. */
  description?: string;
  isChannel: boolean;
  isPrivate: boolean;
  isIm: boolean;
  isMpim: boolean;
  isMember?: boolean;
}

/** Return whether anyone in the workspace can read the conversation. */
export function isPublicSlackChannel(info: SlackConversationInfo): boolean {
  return info.isChannel && !info.isPrivate && !info.isIm && !info.isMpim;
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
    throw new Error(
      `Slack conversations.info returned no channel for ${channelId}`,
    );
  }

  return {
    id: channelId,
    ...(typeof channel.name === "string" && channel.name
      ? { name: channel.name }
      : undefined),
    ...(channel.topic?.value ? { topic: channel.topic.value } : undefined),
    ...(channel.purpose?.value
      ? { description: channel.purpose.value }
      : undefined),
    isChannel: channel.is_channel === true,
    isPrivate: channel.is_private === true,
    isIm: channel.is_im === true,
    isMpim: channel.is_mpim === true,
    ...(typeof channel.is_member === "boolean"
      ? { isMember: channel.is_member }
      : undefined),
  };
}

/** Join a public channel so the bot can read history and threads there. */
export async function joinPublicChannel(
  channelId: SlackChannelId,
): Promise<void> {
  const client = getSlackClient();
  await withSlackRetries(
    () =>
      client.conversations.join({
        channel: channelId,
      }),
    3,
    { action: "conversations.join", idempotent: true },
  );
}

// A private channel with more members than this does not show the viewer as
// a member, so a card for it fails closed.
const MAX_MEMBER_PAGES = 5;

/** Return whether a Slack user is a member of a channel, DM, or group DM. */
export async function isConversationMember(
  channelId: SlackChannelId,
  userId: string,
): Promise<boolean> {
  const client = getSlackClient();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_MEMBER_PAGES; page += 1) {
    const response = await withSlackRetries(
      () =>
        client.conversations.members({
          channel: channelId,
          cursor,
          limit: 1000,
        }),
      3,
      { action: "conversations.members", idempotent: true },
    );
    if (response.members?.includes(userId)) return true;
    cursor = response.response_metadata?.next_cursor || undefined;
    if (!cursor) return false;
  }
  return false;
}

/** Read one message by its timestamp. A thread reply needs its thread. */
export async function getChannelMessage(input: {
  channelId: SlackChannelId;
  messageTs: SlackMessageTs;
  threadTs?: SlackMessageTs | undefined;
}): Promise<SlackThreadReply | undefined> {
  const client = getSlackClient();
  const response = await withSlackRetries(
    () =>
      client.conversations.replies({
        channel: input.channelId,
        ts: input.threadTs ?? input.messageTs,
        oldest: input.messageTs,
        latest: input.messageTs,
        inclusive: true,
        limit: 2,
      }),
    3,
    { action: "conversations.replies", idempotent: true },
  );
  return response.messages?.find((message) => message.ts === input.messageTs);
}
