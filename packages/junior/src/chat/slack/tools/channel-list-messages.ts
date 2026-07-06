import { SlackActionError } from "@/chat/slack/client";
import { listChannelMessages } from "@/chat/slack/channel";
import { parseSlackThreadId } from "@/chat/slack/context";
import type { SlackChannelId } from "@/chat/slack/ids";
import type { SlackMessageTs } from "@/chat/slack/timestamp";
import {
  optionalSlackTimestampParam,
  parseSlackTimestampParam,
} from "@/chat/slack/timestamp-param";
import { z } from "zod";
import { juniorToolResultSchema } from "@/chat/tool-support/structured-result";
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

/** Create the active-channel history tool with preflight timestamp normalization. */
export function createSlackChannelListMessagesTool(context: SlackToolContext) {
  return zodTool({
    description:
      "List channel messages from Slack history in the active channel context. Use when the user asks for recent or historical channel context outside this thread. Do not use for live monitoring or when current thread context already answers the question.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: z.object({
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
    outputSchema: juniorToolResultSchema,
    execute: async ({
      limit,
      cursor,
      oldest,
      latest,
      inclusive,
      max_pages,
    }) => {
      const targetChannelId = context.destinationChannelId;
      if (!targetChannelId) {
        throw new ToolInputError("No active Slack destination is available.");
      }

      const normalizedOldest = normalizeRangeTimestamp(
        "oldest",
        oldest,
        targetChannelId,
      );
      if (!normalizedOldest.ok) {
        return {
          ok: false,
          status: "error" as const,
          error: normalizedOldest.error,
        };
      }
      const normalizedLatest = normalizeRangeTimestamp(
        "latest",
        latest,
        targetChannelId,
      );
      if (!normalizedLatest.ok) {
        return {
          ok: false,
          status: "error" as const,
          error: normalizedLatest.error,
        };
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
          return {
            ok: false,
            status: "error" as const,
            error:
              "The supplied Slack history cursor is no longer valid. Retry the lookup without `cursor` to start from the newest page again.",
          };
        }
        throw error;
      }

      const summary = {
        ok: true,
        status: "success" as const,
        channel_id: targetChannelId,
        count: result.messages.length,
        messages: result.messages,
        ...(result.nextCursor ? { next_cursor: result.nextCursor } : {}),
      };

      return summary;
    },
  });
}
