import { z } from "zod";
import type {
  ConversationMessageSearchFilters,
  ConversationMessageSearchScope,
} from "@/chat/conversations/message-search";
import { CONVERSATIONS_TOOL_SOURCE } from "@/chat/conversations/tool-source";
import { getConversationMessageSearchStore } from "@/chat/db";
import { parseSlackThreadId } from "@/chat/slack/context";
import {
  resolveSlackChannelRef,
  slackChannelRefParam,
} from "@/chat/slack/tool-support/channel-target";
import { getSlackMessagePermalink } from "@/chat/slack/outbound";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

const DEFAULT_LIMIT = 5;

const conversationMessageSearchOutputSchema = juniorToolOutputSchema.extend({
  channel_id: z.string().min(1).optional(),
  count: z.number().int().nonnegative(),
  query: z.string().optional(),
  matches: z.array(
    z
      .object({
        channel_id: z.string().min(1),
        channel_name: z.string().min(1).optional(),
        conversation_id: z.string().min(1),
        excerpt: z.string(),
        message_id: z.string().min(1),
        message_role: z.enum(["assistant", "user"]),
        message_timestamp: z.string().datetime(),
        permalink: z.string().url().optional(),
        thread_ts: z.string().min(1),
      })
      .strict(),
  ),
});

async function resolveSearchFilters(input: {
  channel_id?: string | null;
  query?: string | null;
}): Promise<ConversationMessageSearchFilters> {
  const query = input.query?.trim() || undefined;
  let channelId: string | undefined;

  if (input.channel_id != null && input.channel_id.trim() !== "") {
    const target = await resolveSlackChannelRef({
      field: "channel_id",
      value: input.channel_id,
    });
    channelId = target.channelId;
  }

  if (!query && !channelId) {
    throw new ToolInputError(
      "Provide at least one of `query` or `channel_id`.",
    );
  }

  return {
    ...(channelId ? { channelId } : {}),
    ...(query ? { query } : {}),
  };
}

/** Create a tool that searches retained public messages in an authorized Slack workspace. */
export function createSlackConversationMessageSearchTool(
  scope: ConversationMessageSearchScope,
  currentConversationId: string,
) {
  return zodTool({
    description:
      "Search retained user and assistant messages from public conversations in this Slack workspace. Excludes the current conversation. Not live Slack workspace search.",
    exposure: "deferred",
    source: CONVERSATIONS_TOOL_SOURCE,
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: true,
    },
    inputSchema: z
      .object({
        channel_id: slackChannelRefParam.nullable().optional(),
        query: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .nullable()
          .describe("Words or phrase to match in message text.")
          .optional(),
        limit: z
          .number()
          .int()
          .min(1)
          .max(10)
          .describe(`Maximum matches. Default ${DEFAULT_LIMIT}; max 10.`)
          .nullable()
          .optional(),
      })
      .strict(),
    outputSchema: conversationMessageSearchOutputSchema,
    execute: async (input) => {
      const filters = await resolveSearchFilters(input);
      const store = getConversationMessageSearchStore();
      const matches = await store.search({
        currentConversationId,
        filters,
        limit: input.limit ?? DEFAULT_LIMIT,
        scope,
      });
      const matchesOutput = await Promise.all(
        matches.map(async (match) => {
          const reference = parseSlackThreadId(match.conversationId);
          if (
            !reference ||
            reference.channelId !== match.providerDestinationId
          ) {
            throw new Error(
              "Stored Slack conversation search returned an invalid destination",
            );
          }
          const permalink = await getSlackMessagePermalink({
            channelId: reference.channelId,
            messageTs: reference.threadTs,
          });
          return {
            conversation_id: match.conversationId,
            thread_ts: reference.threadTs,
            message_id: match.messageId,
            message_role: match.role,
            message_timestamp: new Date(match.messageCreatedAtMs).toISOString(),
            excerpt: match.excerpt,
            channel_id: match.providerDestinationId,
            ...(match.channelName ? { channel_name: match.channelName } : {}),
            ...(permalink ? { permalink } : {}),
          };
        }),
      );

      return {
        ...(filters.query ? { query: filters.query } : {}),
        ...(filters.channelId ? { channel_id: filters.channelId } : {}),
        count: matchesOutput.length,
        matches: matchesOutput,
      };
    },
  });
}
