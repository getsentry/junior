import { Type } from "@sinclair/typebox";
import {
  SlackActionError,
  normalizeSlackConversationId,
} from "@/chat/slack/client";
import { listThreadReplies } from "@/chat/slack/channel";
import { tool } from "@/chat/tools/definition";
import {
  SLACK_TS_PATTERN,
  parseSlackMessageReference,
} from "@/chat/tools/slack/slack-message-url";
import type { SlackThreadReply } from "@/chat/slack/channel";
import type { ToolRuntimeContext } from "@/chat/tools/types";

const MAX_THREAD_READ_CHARS = 40_000;

/** Project a thread reply to safe output fields (strips url_private etc). */
function sanitizeMessage(msg: SlackThreadReply) {
  return {
    ts: msg.ts,
    user: msg.user,
    text: msg.text,
    thread_ts: msg.thread_ts,
    subtype: msg.subtype,
    bot_id: msg.bot_id,
    type: msg.type,
    ...(msg.files?.length
      ? {
          files: msg.files.map((f) => ({
            id: f.id,
            name: f.name,
            mimetype: f.mimetype,
            size: f.size,
          })),
        }
      : {}),
  };
}

type SanitizedMessage = ReturnType<typeof sanitizeMessage>;

/**
 * Pick the subset of messages that fit within the character budget,
 * returning the count of messages omitted due to truncation.
 */
function truncateMessages(
  messages: SanitizedMessage[],
  maxChars: number,
): { messages: SanitizedMessage[]; omitted: number } {
  let chars = 0;
  const kept: SanitizedMessage[] = [];

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
 * Check whether reading the target channel is allowed using only local
 * channel ID conventions — no Slack API call needed.
 *
 * Public channels (C-prefix) are always readable. Private channels (G-prefix)
 * and DMs (D-prefix) are only allowed when the target matches the channel the
 * user is currently messaging from.
 */
function checkChannelAccess(
  targetChannelId: string,
  currentChannelId: string | undefined,
): { allowed: true } | { allowed: false; error: string } {
  const target = normalizeSlackConversationId(targetChannelId);
  const current = normalizeSlackConversationId(currentChannelId);

  if (!target) {
    return { allowed: false, error: "Invalid Slack channel ID." };
  }

  // Public channels — any workspace member can see.
  if (target.startsWith("C")) {
    return { allowed: true };
  }

  // Private channels / DMs — only if user is messaging from that channel.
  if (target === current) {
    return { allowed: true };
  }

  return {
    allowed: false,
    error:
      "Cannot read private channels or DMs unless the link is from the current conversation.",
  };
}

/** Create a tool that reads a Slack thread from a shared message URL or explicit coordinates. */
export function createSlackThreadReadTool(context: ToolRuntimeContext) {
  return tool({
    description:
      "Read a Slack thread from a shared Slack message archive URL or explicit channel + timestamp. Use when the user shares a Slack message link (https://*.slack.com/archives/...) and you need the referenced message and its thread context. Public channel links can be read if the bot has access; private channels and DMs are only readable when they are the current conversation.",
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
        if (!SLACK_TS_PATTERN.test(ts)) {
          return { ok: false, error: "Invalid Slack message timestamp." };
        }
        channelId = channel_id;
        messageTs = ts;
      } else {
        return {
          ok: false,
          error:
            "Provide either a Slack message `url` or both `channel_id` and `ts`.",
        };
      }

      const access = checkChannelAccess(channelId, context.channelId);
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

      const sanitized = replies.map(sanitizeMessage);
      const { messages, omitted } = truncateMessages(
        sanitized,
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
