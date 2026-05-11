import { Type } from "@sinclair/typebox";
import { SlackActionError } from "@/chat/slack/client";
import { getChannelInfo, listThreadReplies } from "@/chat/slack/channel";
import { tool } from "@/chat/tools/definition";
import { parseSlackMessageReference } from "@/chat/tools/slack/slack-message-url";
import type { SlackThreadReply } from "@/chat/slack/channel";
import type { ToolRuntimeContext } from "@/chat/tools/types";

const MAX_THREAD_READ_CHARS = 40_000;

/**
 * Pick the subset of messages that fit within the character budget,
 * returning the count of messages omitted due to truncation.
 */
function truncateMessages(
  messages: SlackThreadReply[],
  maxChars: number,
): { messages: SlackThreadReply[]; omitted: number } {
  let chars = 0;
  const kept: SlackThreadReply[] = [];

  for (const msg of messages) {
    const textLen = msg.text?.length ?? 0;
    if (kept.length > 0 && chars + textLen > maxChars) {
      break;
    }
    kept.push(msg);
    chars += textLen;
  }

  return { messages: kept, omitted: messages.length - kept.length };
}

/**
 * Check whether reading the target channel is allowed.
 *
 * Public channels are always readable. Private channels, DMs, and group DMs
 * are only allowed when the target channel matches the channel the user is
 * currently messaging from (proving they have access).
 */
async function checkChannelAccess(
  targetChannelId: string,
  currentChannelId: string | undefined,
): Promise<{ allowed: true } | { allowed: false; error: string }> {
  // Same channel as the conversation — user is clearly a member.
  if (currentChannelId && targetChannelId === currentChannelId) {
    return { allowed: true };
  }

  try {
    const info = await getChannelInfo(targetChannelId);

    if (!info.isPrivate) {
      return { allowed: true };
    }

    return {
      allowed: false,
      error:
        "Cannot read messages from a private channel, DM, or group DM that is not the current conversation. The bot cannot verify you have access to that channel.",
    };
  } catch (error) {
    if (error instanceof SlackActionError) {
      return {
        allowed: false,
        error:
          "Could not verify channel access. The channel may not exist or the bot may not have access to it.",
      };
    }
    throw error;
  }
}

/** Create a tool that reads a Slack thread from a shared message URL or explicit coordinates. */
export function createSlackThreadReadTool(context: ToolRuntimeContext) {
  return tool({
    description:
      "Read a Slack thread from a shared Slack message archive URL or explicit channel + timestamp. Use when the user shares a Slack message link (https://*.slack.com/archives/...) and you need the referenced message and its thread context. Returns the full thread if the bot has access to the channel.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: Type.Object({
      url: Type.Optional(
        Type.String({
          minLength: 1,
          description:
            "Slack message archive URL, e.g. https://workspace.slack.com/archives/C123/p1700000000123456",
        }),
      ),
      channel_id: Type.Optional(
        Type.String({
          minLength: 1,
          description:
            "Slack channel/conversation ID (e.g. C123). Use with `ts` as an alternative to `url`.",
        }),
      ),
      ts: Type.Optional(
        Type.String({
          minLength: 1,
          description:
            "Slack message timestamp (e.g. 1700000000.123456). May be the thread root or any message in the thread.",
        }),
      ),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 1000,
          description: "Maximum number of thread messages to fetch.",
        }),
      ),
      max_pages: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 10,
          description: "Maximum number of Slack API pages to traverse.",
        }),
      ),
    }),
    execute: async ({ url, channel_id, ts, limit, max_pages }) => {
      let channelId: string;
      let messageTs: string;
      let threadTs: string | undefined;

      if (url) {
        const parsed = parseSlackMessageReference(url);
        if (!parsed.ok) {
          return { ok: false, error: parsed.error };
        }
        channelId = parsed.reference.channelId;
        messageTs = parsed.reference.messageTs;
        threadTs = parsed.reference.threadTs;
      } else if (channel_id && ts) {
        channelId = channel_id;
        messageTs = ts;
      } else {
        return {
          ok: false,
          error:
            "Provide either a Slack message `url` or both `channel_id` and `ts`.",
        };
      }

      // Access control: public channels are fine, private channels only if
      // the user is messaging from that same channel.
      const access = await checkChannelAccess(channelId, context.channelId);
      if (!access.allowed) {
        return {
          ok: false,
          channel_id: channelId,
          target_message_ts: messageTs,
          error: access.error,
        };
      }

      const lookupTs = threadTs ?? messageTs;

      let replies: SlackThreadReply[];
      try {
        replies = await listThreadReplies({
          channelId,
          threadTs: lookupTs,
          limit: limit ?? 1000,
          maxPages: max_pages,
        });
      } catch (error) {
        if (error instanceof SlackActionError) {
          return {
            ok: false,
            channel_id: channelId,
            target_message_ts: messageTs,
            error:
              "Could not read this Slack thread. The bot may not be in the channel or may lack history scopes.",
            slack_error: error.apiError,
          };
        }
        throw error;
      }

      if (replies.length === 0) {
        return {
          ok: false,
          channel_id: channelId,
          target_message_ts: messageTs,
          error: "No messages found for this thread.",
        };
      }

      const root = replies[0];
      const resolvedThreadTs =
        threadTs ?? root?.thread_ts ?? root?.ts ?? lookupTs;

      const { messages, omitted } = truncateMessages(
        replies,
        MAX_THREAD_READ_CHARS,
      );

      return {
        ok: true,
        channel_id: channelId,
        target_message_ts: messageTs,
        thread_ts: resolvedThreadTs,
        count: messages.length,
        fetched_count: replies.length,
        truncated: omitted > 0,
        ...(omitted > 0 ? { omitted_message_count: omitted } : {}),
        messages,
      };
    },
  });
}
