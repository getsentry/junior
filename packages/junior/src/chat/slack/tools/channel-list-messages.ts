import { SlackActionError } from "@/chat/slack/client";
import { listChannelMessages } from "@/chat/slack/channel";
import { parseSlackThreadId } from "@/chat/slack/context";
import type { SlackChannelId } from "@/chat/slack/ids";
import type { SlackMessageTs } from "@/chat/slack/timestamp";
import {
  parseSlackTimestampParam,
  slackTimestampParam,
} from "@/chat/slack/timestamp-param";
import {
  checkSlackChannelReadAccess,
  joinPublicChannelForRead,
} from "@/chat/slack/tool-support/channel-access";
import {
  resolveOptionalSlackChannelRef,
  slackChannelRefParam,
} from "@/chat/slack/tool-support/channel-target";
import { z } from "zod";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import type { SlackToolContext } from "@/chat/slack/tool-support/context";

const booleanInput = (description: string) =>
  z
    .preprocess(
      (value) => (value === "true" ? true : value === "false" ? false : value),
      z.boolean(),
    )
    .describe(description);

/**
 * Accept numeric Slack ts bounds and recover matching
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
export function createSlackChannelListMessagesTool(context: SlackToolContext) {
  return zodTool({
    description:
      "List messages from Slack channel history. Defaults to the active channel. Pass `channel_id` to read another public channel.",
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: true,
    },
    inputSchema: z.object({
      channel_id: slackChannelRefParam.nullable().optional(),
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(1000)
        .describe("Maximum number of messages to return across pages.")
        .nullable()
        .optional(),
      cursor: z
        .string()
        .min(1)
        .describe(
          "Cursor from `next_cursor` in a prior result. Use null or omit it for the first page; never invent a cursor.",
        )
        .nullable()
        .optional(),
      oldest: slackTimestampParam(
        "Oldest message timestamp (Slack ts) for range filtering.",
      )
        .nullable()
        .optional(),
      latest: slackTimestampParam(
        "Latest message timestamp (Slack ts) for range filtering.",
      )
        .nullable()
        .optional(),
      inclusive: booleanInput(
        "Whether oldest/latest bounds should be inclusive.",
      )
        .nullable()
        .optional(),
      max_pages: z.coerce
        .number()
        .int()
        .min(1)
        .max(10)
        .describe("Maximum number of API pages to traverse in a single call.")
        .nullable()
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
      const target = await resolveOptionalSlackChannelRef({
        field: "channel_id",
        value: channel_id ?? undefined,
        defaultChannelId: context.destinationChannelId,
        teamId: context.teamId,
      });
      const targetChannelId = target.channelId;

      const access = await checkSlackChannelReadAccess({
        currentChannelIds: [
          context.destinationChannelId,
          context.locationChannelId,
        ],
        targetChannelId,
        teamId: context.teamId,
      });
      if (!access.allowed) {
        throw new ToolInputError(access.error);
      }

      const normalizedOldest = normalizeRangeTimestamp(
        "oldest",
        oldest ?? undefined,
        targetChannelId,
      );
      if (!normalizedOldest.ok) {
        throw new ToolInputError(normalizedOldest.error);
      }
      const normalizedLatest = normalizeRangeTimestamp(
        "latest",
        latest ?? undefined,
        targetChannelId,
      );
      if (!normalizedLatest.ok) {
        throw new ToolInputError(normalizedLatest.error);
      }

      const readHistory = async () =>
        listChannelMessages({
          channelId: targetChannelId,
          limit: limit ?? 100,
          cursor: cursor ?? undefined,
          oldest: normalizedOldest.value,
          latest: normalizedLatest.value,
          inclusive: inclusive ?? undefined,
          maxPages: max_pages ?? undefined,
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
        ...(channelName ? { channel_name: channelName } : undefined),
        ...(joined ? { joined_channel: true } : undefined),
        count: result.messages.length,
        messages: result.messages,
        ...(result.nextCursor ? { next_cursor: result.nextCursor } : undefined),
      };
    },
  });
}
