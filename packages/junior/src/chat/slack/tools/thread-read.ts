import { SlackActionError } from "@/chat/slack/client";
import { listThreadReplies } from "@/chat/slack/channel";
import {
  checkSlackChannelReadAccess,
  joinPublicChannelForRead,
} from "@/chat/slack/tool-support/channel-access";
import {
  resolveSlackChannelRef,
  slackChannelRefParam,
} from "@/chat/slack/tool-support/channel-target";
import { z } from "zod";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { parseSlackMessageReference } from "@/chat/slack/tool-support/slack-message-url";
import type { SlackToolContext } from "@/chat/slack/tool-support/context";
import {
  parseRequiredSlackTimestampParam,
  slackTimestampParam,
} from "@/chat/slack/timestamp-param";
import type { SlackChannelId } from "@/chat/slack/ids";
import type { SlackMessageTs } from "@/chat/slack/timestamp";
import type { SlackThreadReply } from "@/chat/slack/channel";
import { renderAttachmentText } from "@/chat/slack/message/attachments";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

const MAX_THREAD_READ_CHARS = 40_000;

/** Project a thread reply to safe output fields (strips url_private etc). */
function sanitizeMessage(msg: SlackThreadReply) {
  const attachmentText = renderAttachmentText(msg.attachments);

  return {
    ts: msg.ts,
    user: msg.user,
    text: msg.text,
    thread_ts: msg.thread_ts,
    subtype: msg.subtype,
    bot_id: msg.bot_id,
    type: msg.type,
    ...(attachmentText ? { attachment_text: attachmentText } : undefined),
    ...(msg.files?.length
      ? {
          files: msg.files.map((f) => ({
            id: f.id,
            name: f.name,
            mimetype: f.mimetype,
            size: f.size,
          })),
        }
      : undefined),
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
    const textLen =
      (msg.text?.length ?? 0) + (msg.attachment_text?.length ?? 0);
    if (kept.length > 0 && chars + textLen > maxChars) {
      break;
    }
    kept.push(msg);
    chars += textLen;
  }

  return { messages: kept, omitted: messages.length - kept.length };
}

/** Create a tool that reads a Slack thread from a shared message URL or explicit coordinates. */
export function createSlackThreadReadTool(context: SlackToolContext) {
  return zodTool({
    description:
      "Read a Slack thread from a shared archive URL or explicit channel + timestamp. Works for the current conversation and public channels.",
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: true,
    },
    inputSchema: z.object({
      url: z.string().min(1).describe("Slack message archive URL.").optional(),
      channel_id: slackChannelRefParam.optional(),
      ts: slackTimestampParam(
        "Slack message timestamp. May be the thread root or any message in the thread.",
      ).optional(),
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(1000)
        .describe("Maximum number of thread messages to fetch.")
        .optional(),
      max_pages: z.coerce
        .number()
        .int()
        .min(1)
        .max(10)
        .describe("Maximum number of Slack API pages to traverse.")
        .optional(),
    }),
    outputSchema: juniorToolOutputSchema,
    execute: async ({ url, channel_id, ts, limit, max_pages }) => {
      let channelId: SlackChannelId;
      let messageTs: SlackMessageTs;
      let threadTs: SlackMessageTs | undefined;

      if (url) {
        const parsed = parseSlackMessageReference(url);
        if (!parsed.ok) {
          throw new ToolInputError(parsed.error);
        }
        channelId = parsed.reference.channelId;
        messageTs = parsed.reference.messageTs;
        threadTs = parsed.reference.threadTs;
      } else if (channel_id && ts) {
        const parsedTs = parseRequiredSlackTimestampParam("ts", ts);
        if (!parsedTs.ok) {
          throw new ToolInputError(parsedTs.error);
        }
        const target = await resolveSlackChannelRef({
          field: "channel_id",
          value: channel_id,
          teamId: context.teamId,
        });
        channelId = target.channelId;
        messageTs = parsedTs.value;
      } else {
        throw new ToolInputError(
          "Provide either a Slack message `url` or both `channel_id` and `ts`.",
        );
      }

      const access = await checkSlackChannelReadAccess({
        currentChannelIds: [
          context.destinationChannelId,
          context.locationChannelId,
        ],
        targetChannelId: channelId,
        teamId: context.teamId,
      });
      if (!access.allowed) {
        throw new ToolInputError(access.error);
      }

      const lookupTs = threadTs ?? messageTs;
      const readReplies = async () =>
        listThreadReplies({
          channelId,
          threadTs: lookupTs,
          limit: limit ?? 1000,
          maxPages: max_pages,
        });

      let replies: SlackThreadReply[] | undefined;
      let joined = false;
      let channelName = access.channelName;
      let readError: unknown;
      try {
        replies = await readReplies();
      } catch (error) {
        readError = error;
        const canJoin =
          error instanceof SlackActionError &&
          error.code === "not_in_channel" &&
          access.isMember !== true;
        if (canJoin) {
          const joinResult = await joinPublicChannelForRead({
            channelName,
            targetChannelId: channelId,
          });
          if (!joinResult.ok) {
            throw new ToolInputError(joinResult.error);
          }
          joined = true;
          channelName = joinResult.channelName ?? channelName;
          try {
            replies = await readReplies();
            readError = undefined;
          } catch (retryError) {
            readError = retryError;
          }
        }
      }

      if (!replies) {
        const error = readError;
        if (error instanceof SlackActionError) {
          if (error.code === "not_in_channel") {
            throw new ToolInputError(
              "Could not read this Slack thread because the bot is not in the channel.",
              { cause: error },
            );
          }
          if (error.code === "missing_scope") {
            throw new ToolInputError(
              "Could not read this Slack thread because this installation is missing history scopes.",
              { cause: error },
            );
          }
          throw new ToolInputError("Could not read this Slack thread.", {
            cause: error,
          });
        }
        throw error;
      }

      if (replies.length === 0) {
        throw new ToolInputError("No messages found for this thread.");
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
        channel_id: channelId,
        ...(channelName ? { channel_name: channelName } : undefined),
        ...(joined ? { joined_channel: true } : undefined),
        target_message_ts: messageTs,
        thread_ts: resolvedThreadTs,
        count: messages.length,
        fetched_count: replies.length,
        truncated: omitted > 0,
        ...(omitted > 0 ? { omitted_message_count: omitted } : undefined),
        messages,
      };
    },
  });
}
