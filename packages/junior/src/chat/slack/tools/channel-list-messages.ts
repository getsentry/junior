import { Type } from "@sinclair/typebox";
import {
  normalizeSlackConversationId,
  SlackActionError,
} from "@/chat/slack/client";
import { listChannelMessages } from "@/chat/slack/channel";
import { parseSlackThreadId } from "@/chat/slack/context";
import type { SlackMessageTs } from "@/chat/slack/timestamp";
import {
  optionalSlackTimestampParam,
  parseSlackTimestampParam,
} from "@/chat/slack/timestamp-param";
import { tool } from "@/chat/tools/definition";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import type { SlackToolContext } from "@/chat/slack/tools/context";

/**
 * Accept numeric Slack ts bounds and recover matching Junior
 * `slack:<channel>:<ts>` references before Slack API calls.
 */
function normalizeRangeTimestamp(
  field: "oldest" | "latest",
  value: string | undefined,
  targetChannelId: string,
):
  | { ok: true; value: SlackMessageTs | undefined }
  | { ok: false; error: string } {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }

  const trimmed = value.trim();
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
    const referenceChannelId = normalizeSlackConversationId(threadId.channelId);
    const normalizedTargetChannelId =
      normalizeSlackConversationId(targetChannelId);
    if (referenceChannelId === normalizedTargetChannelId) {
      return threadTimestamp;
    }
  }

  return timestamp;
}

/** Create the active-channel history tool with preflight timestamp normalization. */
export function createSlackChannelListMessagesTool(context: SlackToolContext) {
  return tool({
    description:
      "List channel messages from Slack history in the active channel context. Use when the user asks for recent or historical channel context outside this thread. Do not use for live monitoring or when current thread context already answers the question.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: Type.Object({
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 1000,
          description: "Maximum number of messages to return across pages.",
        }),
      ),
      cursor: Type.Optional(
        Type.String({
          minLength: 1,
          description: "Optional cursor to continue from a prior call.",
        }),
      ),
      oldest: optionalSlackTimestampParam(
        "Optional oldest message timestamp (Slack ts) for range filtering.",
      ),
      latest: optionalSlackTimestampParam(
        "Optional latest message timestamp (Slack ts) for range filtering.",
      ),
      inclusive: Type.Optional(
        Type.Boolean({
          description: "Whether oldest/latest bounds should be inclusive.",
        }),
      ),
      max_pages: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 10,
          description:
            "Maximum number of API pages to traverse in a single call.",
        }),
      ),
    }),
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
        return { ok: false, error: normalizedOldest.error };
      }
      const normalizedLatest = normalizeRangeTimestamp(
        "latest",
        latest,
        targetChannelId,
      );
      if (!normalizedLatest.ok) {
        return { ok: false, error: normalizedLatest.error };
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
            error:
              "The supplied Slack history cursor is no longer valid. Retry the lookup without `cursor` to start from the newest page again.",
          };
        }
        throw error;
      }

      const summary = {
        ok: true,
        channel_id: targetChannelId,
        count: result.messages.length,
        next_cursor: result.nextCursor,
        messages: result.messages,
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(summary) }],
        details: {
          ok: true,
          channel_id: targetChannelId,
          count: result.messages.length,
          ...(result.nextCursor ? { next_cursor: result.nextCursor } : {}),
        },
      };
    },
  });
}
