import { getSlackClient, withSlackRetries } from "@/chat/slack-actions/client";

export interface SlackChannelMessage {
  ts?: string;
  user?: string;
  text?: string;
  thread_ts?: string;
  subtype?: string;
  bot_id?: string;
  type?: string;
}

export interface SlackChannelMemberProfile {
  user_id: string;
}

export async function postMessageToChannel(input: {
  channelId: string;
  text: string;
}): Promise<{ ts: string; permalink?: string }> {
  const client = getSlackClient();
  const response = await withSlackRetries(() =>
    client.chat.postMessage({
      channel: input.channelId,
      text: input.text,
      mrkdwn: true
    })
  );

  if (!response.ts) {
    throw new Error("Slack channel message posted without ts");
  }

  let permalink: string | undefined;
  try {
    const permalinkResponse = await withSlackRetries(() =>
      client.chat.getPermalink({
        channel: input.channelId,
        message_ts: response.ts as string
      })
    );
    permalink = permalinkResponse.permalink;
  } catch {
    // Message creation succeeded; permalink lookup is best-effort.
  }

  return {
    ts: response.ts,
    permalink
  };
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
  const targetLimit = Math.max(1, Math.min(input.limit, 1000));
  const maxPages = Math.max(1, Math.min(input.maxPages ?? 5, 10));
  const messages: SlackChannelMessage[] = [];
  let cursor = input.cursor;
  let pages = 0;

  while (messages.length < targetLimit && pages < maxPages) {
    pages += 1;
    const pageLimit = Math.max(1, Math.min(200, targetLimit - messages.length));
    const response = await withSlackRetries(() =>
      client.conversations.history({
        channel: input.channelId,
        limit: pageLimit,
        cursor,
        oldest: input.oldest,
        latest: input.latest,
        inclusive: input.inclusive
      })
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
    nextCursor: cursor
  };
}

export async function listChannelMembers(input: {
  channelId: string;
  limit: number;
  cursor?: string;
}): Promise<{ members: SlackChannelMemberProfile[]; nextCursor?: string }> {
  const client = getSlackClient();
  const targetLimit = Math.max(1, Math.min(input.limit, 200));
  const response = await withSlackRetries(() =>
    client.conversations.members({
      channel: input.channelId,
      limit: targetLimit,
      cursor: input.cursor
    })
  );

  const members = (response.members ?? []).slice(0, targetLimit);
  return {
    members: members.map((userId) => ({ user_id: userId })),
    nextCursor: response.response_metadata?.next_cursor || undefined
  };
}
