import { SlackActionError } from "@/chat/slack/client";
import { listChannelMessages } from "@/chat/slack/channel";
import { parseSlackThreadId } from "@/chat/slack/context";
import type { SlackChannelId } from "@/chat/slack/ids";
import type { SlackMessageTs } from "@/chat/slack/timestamp";
import {
  optionalSlackTimestampParam,
  parseSlackTimestampParam,
} from "@/chat/slack/timestamp-param";
import {
  checkSlackChannelReadAccess,
  type DestinationVisibilityReader,
  type SlackConversationInfoReader,
} from "@/chat/slack/tools/channel-access";
import {
  parseRequiredSlackChannelIdParam,
  slackChannelIdParam,
} from "@/chat/slack/id-param";
import { z } from "zod";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import type { SlackToolContext } from "@/chat/slack/tools/context";

const booleanInput = (description: string) =>
  z
    .preprocess(
      (value) => (value === "true" ? true : value === "false" ? false : value),
      z.boolean(),
    )
    .describe(description);

/**
 * Accept numeric Slack ts bounds and recover matching Junior
 * `slack:<channel>:<ts>` references before Slack API calls.
 */
function normalizeRangeTimestamp(
  field: "oldest" | "latest",
  value: number | string | undefined,
  targetChannelId: SlackChannelId,
):
  | { ok: true; value: SlackMessageTs | undefined }
  | { ok: false; error: string } {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }

  const trimmed = String(value).trim();
  if (!trimmed) {
    return parseSlackTimestampParam(field, value);
  }

  const timestamp = parseSlackTimestampParam(field, trimmed);
  if (timestamp.ok && timestamp.value) {
    return timestamp;
  }

  const threadId = parseSlackThreadId(trimmed);
  const threadTimestamp = threadId
    ? parseSlackTimestampParam(field, threadId.threadTs)
    : undefined;
  if (threadId && threadTimestamp?.ok && threadTimestamp.value) {
    if (threadId.channelId === targetChannelId) {
      return threadTimestamp;
    }
  }

  return timestamp;
}

/** Create the channel history tool with optional cross-channel targets. */
export function createSlackChannelListMessagesTool(
  context: SlackToolContext,
  deps: {
    conversationInfo?: SlackConversationInfoReader;
    visibilityStore?: DestinationVisibilityReader;
  } = {},
) {
  return zodTool({
    description:
      "List channel messages from Slack history. Defaults to the active channel context. Pass `channel_id` to read another public channel the bot can access, or the current conversation. Use when the user asks for recent or historical channel context outside this thread. Do not use for live monitoring or when current thread context already answers the question.",
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: true,
    },
    inputSchema: z.object({
      channel_id: slackChannelIdParam(
        "Optional Slack channel ID to read. Defaults to the active channel context. Only the current conversation or public channels the bot can access are allowed.",
      ).optional(),
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(1000)
        .describe("Maximum number of messages to return across pages.")
        .optional(),
      cursor: z
        .string()
        .min(1)
        .describe("Optional cursor to continue from a prior call.")
        .optional(),
      oldest: optionalSlackTimestampParam(
        "Optional oldest message timestamp (Slack ts) for range filtering.",
      ),
      latest: optionalSlackTimestampParam(
        "Optional latest message timestamp (Slack ts) for range filtering.",
      ),
      inclusive: booleanInput(
        "Whether oldest/latest bounds should be inclusive.",
      ).optional(),
      max_pages: z.coerce
        .number()
        .int()
        .min(1)
        .max(10)
        .describe("Maximum number of API pages to traverse in a single call.")
        .optional(),
    }),
    outputSchema: juniorToolOutputSchema,
    execute: async ({
      channel_id,
      limit,
      cursor,
      oldest,
      latest,
      inclusive,
      max_pages,
    }) => {
      let targetChannelId = context.destinationChannelId;
      if (channel_id !== undefined) {
        const parsedChannelId = parseRequiredSlackChannelIdParam(
          "channel_id",
          channel_id,
        );
        if (!parsedChannelId.ok) {
          throw new ToolInputError(parsedChannelId.error);
        }
        targetChannelId = parsedChannelId.value;
      }
      if (!targetChannelId) {
        throw new ToolInputError("No active Slack destination is available.");
      }

      const access = await checkSlackChannelReadAccess({
        currentChannelIds: [
          context.destinationChannelId,
          context.sourceChannelId,
        ],
        conversationInfo: deps.conversationInfo,
        store: deps.visibilityStore,
        targetChannelId,
        teamId: context.teamId,
      });
      if (!access.allowed) {
        throw new ToolInputError(access.error);
      }

      const normalizedOldest = normalizeRangeTimestamp(
        "oldest",
        oldest,
        targetChannelId,
      );
      if (!normalizedOldest.ok) {
        throw new ToolInputError(normalizedOldest.error);
      }
      const normalizedLatest = normalizeRangeTimestamp(
        "latest",
        latest,
        targetChannelId,
      );
      if (!normalizedLatest.ok) {
        throw new ToolInputError(normalizedLatest.error);
      }

      let result;
      try {
        result = await listChannelMessages({
          channelId: targetChannelId,
          limit: limit ?? 100,
          cursor,
          oldest: normalizedOldest.value,
          latest: normalizedLatest.value,
          inclusive,
          maxPages: max_pages,
        });
      } catch (error) {
        if (
          error instanceof SlackActionError &&
          error.apiError === "invalid_cursor"
        ) {
          throw new ToolInputError(
            "The supplied Slack history cursor is no longer valid. Retry the lookup without `cursor` to start from the newest page again.",
            { cause: error },
          );
        }
        if (error instanceof SlackActionError) {
          if (error.code === "not_in_channel") {
            throw new ToolInputError(
              "Could not read this Slack channel history. The bot is not in the channel.",
              { cause: error },
            );
          }
          if (error.code === "missing_scope") {
            throw new ToolInputError(
              "Could not read this Slack channel history because this installation is missing history scopes.",
              { cause: error },
            );
          }
          throw new ToolInputError(
            "Could not read this Slack channel history. The bot may not be in the channel or may lack history scopes.",
            { cause: error },
          );
        }
        throw error;
      }

      return {
        channel_id: targetChannelId,
        ...(access.channelName ? { channel_name: access.channelName } : {}),
        count: result.messages.length,
        messages: result.messages,
        ...(result.nextCursor ? { next_cursor: result.nextCursor } : {}),
      };
    },
  });
}
