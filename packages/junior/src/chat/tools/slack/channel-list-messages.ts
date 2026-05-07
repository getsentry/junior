import { Type } from "@sinclair/typebox";
import { SlackActionError } from "@/chat/slack/client";
import { listChannelMessages } from "@/chat/slack/channel";
import { tool } from "@/chat/tools/definition";
import type { ToolRuntimeContext } from "@/chat/tools/types";

export function createSlackChannelListMessagesTool(
  context: ToolRuntimeContext,
) {
  return tool({
    description:
      "List channel messages from Slack history in the active channel context. Use when the user asks for recent or historical channel context outside this thread. Do not use for live monitoring or when current thread context already answers the question.",
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
      oldest: Type.Optional(
        Type.String({
          minLength: 1,
          description:
            "Optional oldest message timestamp (Slack ts) for range filtering.",
        }),
      ),
      latest: Type.Optional(
        Type.String({
          minLength: 1,
          description:
            "Optional latest message timestamp (Slack ts) for range filtering.",
        }),
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
      const targetChannelId = context.channelId;
      if (!targetChannelId) {
        return {
          ok: false,
          error: "No active channel context is available for history lookup",
        };
      }

      let result;
      try {
        result = await listChannelMessages({
          channelId: targetChannelId,
          limit: limit ?? 100,
          cursor,
          oldest,
          latest,
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

      return {
        ok: true,
        channel_id: targetChannelId,
        count: result.messages.length,
        next_cursor: result.nextCursor,
        messages: result.messages,
      };
    },
  });
}
