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
  joinPublicChannelForRead,
  type DestinationVisibilityReader,
  type SlackChannelJoinWriter,
  type SlackConversationInfoReader,
} from "@/chat/slack/tools/channel-access";
import {
  optionalSlackChannelIdParam,
  optionalSlackChannelNameParam,
  resolveSlackChannelTarget,
  type SlackChannelNameResolver,
} from "@/chat/slack/tools/channel-target";
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
    joinChannel?: SlackChannelJoinWriter;
    nameResolver?: SlackChannelNameResolver;
    visibilityStore?: DestinationVisibilityReader;
  } = {},
) {
  return zodTool({
    description:
      "List messages from Slack channel history. Defaults to the active channel. Pass `channel_id` or `channel_name` (`#foo`) to read another public channel. For public channels the bot is not in yet, Junior joins on demand and retries. Use for recent or historical channel context outside this thread. This is raw Slack channel history, not Junior-retained chat search and not workspace-wide search.",
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: true,
    },
    inputSchema: z.object({
      channel_id: optionalSlackChannelIdParam(
        "Optional Slack channel ID to read. Defaults to the active channel context.",
      ),
      channel_name: optionalSlackChannelNameParam(
        "Optional public channel name with or without a leading #. Use when the user names the channel.",
      ),
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
      channel_name,
      limit,
      cursor,
      oldest,
      latest,
      inclusive,
      max_pages,
    }) => {
      const target = await resolveSlackChannelTarget({
        channelId: channel_id,
        channelName: channel_name,
        defaultChannelId: context.destinationChannelId,
        nameResolver: deps.nameResolver,
      });
      const targetChannelId = target.channelId;

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

      const readHistory = async () =>
        listChannelMessages({
          channelId: targetChannelId,
          limit: limit ?? 100,
          cursor,
          oldest: normalizedOldest.value,
          latest: normalizedLatest.value,
          inclusive,
          maxPages: max_pages,
        });

      let result: Awaited<ReturnType<typeof listChannelMessages>> | undefined;
      let joined = false;
      let channelName = access.channelName ?? target.channelName;
      let readError: unknown;
      try {
        result = await readHistory();
      } catch (error) {
        readError = error;
        const canJoin =
          error instanceof SlackActionError &&
          error.code === "not_in_channel" &&
          access.isMember !== true;
        if (canJoin) {
          const joinResult = await joinPublicChannelForRead({
            channelName,
            joinChannel: deps.joinChannel,
            targetChannelId,
          });
          if (!joinResult.ok) {
            throw new ToolInputError(joinResult.error);
          }
          joined = true;
          channelName = joinResult.channelName ?? channelName;
          try {
            result = await readHistory();
            readError = undefined;
          } catch (retryError) {
            readError = retryError;
          }
        }
      }

      if (!result) {
        const error = readError;
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
              "Could not read this Slack channel history because the bot is not in the channel.",
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
            "Could not read this Slack channel history.",
            { cause: error },
          );
        }
        throw error;
      }

      return {
        channel_id: targetChannelId,
        ...(channelName ? { channel_name: channelName } : {}),
        ...(joined ? { joined_channel: true } : {}),
        count: result.messages.length,
        messages: result.messages,
        ...(result.nextCursor ? { next_cursor: result.nextCursor } : {}),
      };
    },
  });
}
