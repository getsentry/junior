import { SlackActionError } from "@/chat/slack/client";
import type { SlackMessageBlock } from "@/chat/slack/footer";
import {
  getSlackClient,
  normalizeSlackConversationId,
  withSlackRetries,
} from "@/chat/slack/client";
import { normalizeSlackEmojiName } from "@/chat/slack/emoji";
import { parseSlackUserId, type SlackChannelId } from "@/chat/slack/ids";
import {
  parseSlackMessageTs,
  type SlackMessageTs,
} from "@/chat/slack/timestamp";

const MAX_SLACK_MESSAGE_TEXT_CHARS = 40_000;

function requireSlackConversationId(
  channelId: string,
  action: string,
): SlackChannelId {
  const normalized = normalizeSlackConversationId(channelId);
  if (!normalized) {
    throw new Error(`${action} requires a valid channel ID`);
  }
  return normalized;
}

function requireSlackThreadTimestamp(threadTs: string, action: string): string {
  const normalized = threadTs.trim();
  if (!normalized) {
    throw new Error(`${action} requires a thread timestamp`);
  }
  return normalized;
}

function requireSlackMessageTimestamp(
  timestamp: string,
  action: string,
): SlackMessageTs {
  const normalized = parseSlackMessageTs(timestamp);
  if (!normalized) {
    throw new Error(`${action} requires a target message timestamp`);
  }
  return normalized;
}

function requireSlackMessageText(text: string, action: string): string {
  if (text.trim().length === 0) {
    throw new Error(`${action} requires non-empty text`);
  }
  if (text.length > MAX_SLACK_MESSAGE_TEXT_CHARS) {
    throw new Error(
      `${action} text exceeds Slack's 40000 character truncation limit`,
    );
  }
  return text;
}

async function getPermalinkBestEffort(args: {
  channelId: SlackChannelId;
  messageTs: SlackMessageTs;
}): Promise<string | undefined> {
  try {
    const response = await withSlackRetries(
      () =>
        getSlackClient().chat.getPermalink({
          channel: args.channelId,
          message_ts: args.messageTs,
        }),
      3,
      {
        action: "chat.getPermalink",
        idempotent: true,
        spanAttributes: {
          "app.slack.channel_id": args.channelId,
          "app.slack.message_ts": args.messageTs,
        },
      },
    );
    return response.permalink;
  } catch {
    return undefined;
  }
}

/** Post Slack `mrkdwn` text to a conversation or thread via the shared outbound boundary. */
export async function postSlackMessage(input: {
  blocks?: SlackMessageBlock[];
  channelId: string;
  text: string;
  threadTs?: string;
  includePermalink?: boolean;
}): Promise<{ ts: SlackMessageTs; permalink?: string }> {
  const channelId = requireSlackConversationId(
    input.channelId,
    "Slack message posting",
  );
  const text = requireSlackMessageText(input.text, "Slack message posting");
  const threadTs = input.threadTs
    ? requireSlackThreadTimestamp(
        input.threadTs,
        "Slack thread message posting",
      )
    : undefined;

  const response = await withSlackRetries(
    () =>
      getSlackClient().chat.postMessage({
        channel: channelId,
        text,
        ...(input.blocks?.length
          ? {
              blocks: input.blocks as unknown as Array<Record<string, unknown>>,
            }
          : {}),
        ...(threadTs ? { thread_ts: threadTs } : {}),
      }),
    3,
    {
      action: "chat.postMessage",
      spanAttributes: {
        "app.slack.channel_id": channelId,
        ...(threadTs ? { "app.slack.thread_ts": threadTs } : {}),
      },
    },
  );

  const messageTs = parseSlackMessageTs(response.ts);
  if (!messageTs) {
    throw new Error("Slack message posted without ts");
  }

  return {
    ts: messageTs,
    ...(input.includePermalink
      ? {
          permalink: await getPermalinkBestEffort({
            channelId,
            messageTs,
          }),
        }
      : {}),
  };
}

/** Delete a previously posted Slack message through the shared outbound boundary. */
export async function deleteSlackMessage(input: {
  channelId: string;
  timestamp: SlackMessageTs;
}): Promise<void> {
  const channelId = requireSlackConversationId(
    input.channelId,
    "Slack message deletion",
  );
  const timestamp = requireSlackMessageTimestamp(
    input.timestamp,
    "Slack message deletion",
  );

  await withSlackRetries(
    () =>
      getSlackClient().chat.delete({
        channel: channelId,
        ts: timestamp,
      }),
    3,
    {
      action: "chat.delete",
      idempotent: true,
      spanAttributes: {
        "app.slack.channel_id": channelId,
        "app.slack.message_ts": timestamp,
      },
    },
  );
}

/**
 * Post an ephemeral Slack message. Delivery is best-effort on Slack's side, but
 * request validation and Web API behavior are centralized here.
 */
export async function postSlackEphemeralMessage(input: {
  channelId: string;
  userId: string;
  text: string;
  threadTs?: string;
}): Promise<{ messageTs?: string }> {
  const channelId = requireSlackConversationId(
    input.channelId,
    "Slack ephemeral message posting",
  );
  const userId = parseSlackUserId(input.userId);
  if (!userId) {
    throw new Error("Slack ephemeral message posting requires a user ID");
  }
  const text = requireSlackMessageText(
    input.text,
    "Slack ephemeral message posting",
  );
  const threadTs = input.threadTs
    ? requireSlackThreadTimestamp(
        input.threadTs,
        "Slack ephemeral thread message posting",
      )
    : undefined;

  const response = await withSlackRetries(
    () =>
      getSlackClient().chat.postEphemeral({
        channel: channelId,
        user: userId,
        text,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      }),
    3,
    {
      action: "chat.postEphemeral",
      spanAttributes: {
        "app.slack.channel_id": channelId,
        "app.slack.user_id": userId,
        ...(threadTs ? { "app.slack.thread_ts": threadTs } : {}),
      },
    },
  );

  return {
    messageTs: response.message_ts,
  };
}

/** Upload files into a Slack thread via the shared outbound file boundary. */
export async function uploadFilesToThread(input: {
  channelId: string;
  threadTs: string;
  files: Array<{ data: Buffer; filename: string }>;
}): Promise<void> {
  const channelId = requireSlackConversationId(
    input.channelId,
    "Slack file upload",
  );
  const threadTs = requireSlackThreadTimestamp(
    input.threadTs,
    "Slack file upload",
  );
  if (input.files.length === 0) {
    throw new Error("Slack file upload requires at least one file");
  }
  const fileUploads = input.files.map((file) => {
    const filename = file.filename.trim();
    if (!filename) {
      throw new Error(
        "Slack file upload requires every file to have a filename",
      );
    }
    return {
      file: file.data,
      filename,
    };
  });

  await withSlackRetries(
    () =>
      getSlackClient().filesUploadV2({
        channel_id: channelId,
        thread_ts: threadTs,
        file_uploads: fileUploads,
      }),
    3,
    {
      action: "filesUploadV2",
      spanAttributes: {
        "app.slack.channel_id": channelId,
        "app.slack.thread_ts": threadTs,
      },
    },
  );
}

/** Add a reaction to a Slack message, treating `already_reacted` as idempotent success. */
export async function addReactionToMessage(input: {
  channelId: string;
  timestamp: SlackMessageTs;
  emoji: string;
}): Promise<{ ok: true }> {
  const channelId = requireSlackConversationId(
    input.channelId,
    "Slack reaction",
  );
  const timestamp = requireSlackMessageTimestamp(
    input.timestamp,
    "Slack reaction",
  );
  const emoji = normalizeSlackEmojiName(input.emoji);
  if (!emoji) {
    throw new Error("Slack reaction requires a valid emoji alias name");
  }

  try {
    await withSlackRetries(
      () =>
        getSlackClient().reactions.add({
          channel: channelId,
          timestamp,
          name: emoji,
        }),
      3,
      {
        action: "reactions.add",
        idempotent: true,
        spanAttributes: {
          "app.slack.channel_id": channelId,
          "app.slack.message_ts": timestamp,
          "app.slack.reaction": emoji,
        },
      },
    );
  } catch (error) {
    if (error instanceof SlackActionError && error.code === "already_reacted") {
      return { ok: true };
    }
    throw error;
  }

  return { ok: true };
}

/** Remove a reaction from a Slack message, treating `no_reaction` as idempotent success. */
export async function removeReactionFromMessage(input: {
  channelId: string;
  timestamp: SlackMessageTs;
  emoji: string;
}): Promise<{ ok: true }> {
  const channelId = requireSlackConversationId(
    input.channelId,
    "Slack reaction removal",
  );
  const timestamp = requireSlackMessageTimestamp(
    input.timestamp,
    "Slack reaction removal",
  );
  const emoji = normalizeSlackEmojiName(input.emoji);
  if (!emoji) {
    throw new Error("Slack reaction removal requires a valid emoji alias name");
  }

  try {
    await withSlackRetries(
      () =>
        getSlackClient().reactions.remove({
          channel: channelId,
          timestamp,
          name: emoji,
        }),
      3,
      {
        action: "reactions.remove",
        idempotent: true,
        spanAttributes: {
          "app.slack.channel_id": channelId,
          "app.slack.message_ts": timestamp,
          "app.slack.reaction": emoji,
        },
      },
    );
  } catch (error) {
    if (error instanceof SlackActionError && error.code === "no_reaction") {
      return { ok: true };
    }
    throw error;
  }

  return { ok: true };
}

export const slackOutboundPolicy = {
  maxMessageTextChars: MAX_SLACK_MESSAGE_TEXT_CHARS,
};
