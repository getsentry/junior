import { z } from "zod";
import type {
  ConversationMessageSearchFilters,
  ConversationMessageSearchScope,
} from "@/chat/conversations/message-search";
import { CONVERSATIONS_TOOL_SOURCE } from "@/chat/conversations/tool-source";
import { getConversationMessageSearchStore } from "@/chat/db";
import { parseSlackThreadId } from "@/chat/slack/context";
import {
  parseSlackTeamId,
  type SlackTeamId,
} from "@/chat/slack/ids";
import {
  resolveSlackChannelRef,
  slackChannelRefParam,
} from "@/chat/slack/tool-support/channel-target";
import { getSlackMessagePermalink } from "@/chat/slack/outbound";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

const conversationMessageSearchOutputSchema = juniorToolOutputSchema.extend({
  after: z.string().datetime().optional(),
  annotation: z.string().min(1).optional(),
  before: z.string().datetime().optional(),
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

function parseTimestamp(
  field: "after" | "before",
  value: string | null | undefined,
): number | undefined {
  if (value == null || value.trim() === "") {
    return undefined;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ToolInputError(`${field} must be a valid ISO-8601 timestamp`);
  }
  return parsed;
}

async function resolveSearchFilters(input: {
  after?: string | null;
  annotation?: string | null;
  before?: string | null;
  channel_id?: string | null;
  query?: string | null;
  teamId: SlackTeamId;
}): Promise<ConversationMessageSearchFilters> {
  const query = input.query?.trim() || undefined;
  const annotation = input.annotation?.trim() || undefined;
  const afterMs = parseTimestamp("after", input.after);
  const beforeMs = parseTimestamp("before", input.before);
  let channelId: string | undefined;

  if (input.channel_id != null && input.channel_id.trim() !== "") {
    const target = await resolveSlackChannelRef({
      field: "channel_id",
      value: input.channel_id,
      teamId: input.teamId,
    });
    channelId = target.channelId;
  }

  if (
    afterMs !== undefined &&
    beforeMs !== undefined &&
    afterMs >= beforeMs
  ) {
    throw new ToolInputError("`after` must be earlier than `before`");
  }
  if (!query && !channelId && !annotation) {
    throw new ToolInputError(
      "Provide at least one of `query`, `channel_id`, or `annotation`.",
    );
  }

  return {
    ...(afterMs !== undefined ? { afterMs } : {}),
    ...(annotation ? { annotation } : {}),
    ...(beforeMs !== undefined ? { beforeMs } : {}),
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
      "Search retained user and assistant messages from public conversations in this Slack workspace. Filter by message text, channel, time range, or linked annotation such as a resource key. Excludes the current conversation. Not live Slack workspace search.",
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
        after: z
          .string()
          .datetime()
          .nullable()
          .describe("Include conversations active at or after this timestamp.")
          .optional(),
        annotation: z
          .string()
          .trim()
          .min(1)
          .max(256)
          .nullable()
          .describe(
            "Linked resource key. Matches that key, or nested children that continue with #.",
          )
          .optional(),
        before: z
          .string()
          .datetime()
          .nullable()
          .describe("Include conversations active before this timestamp.")
          .optional(),
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
          .max(MAX_LIMIT)
          .describe(
            `Maximum conversations. Default ${DEFAULT_LIMIT}; max ${MAX_LIMIT}.`,
          )
          .nullable()
          .optional(),
      })
      .strict(),
    outputSchema: conversationMessageSearchOutputSchema,
    execute: async (input) => {
      const teamId = parseSlackTeamId(scope.providerTenantId);
      if (!teamId) {
        throw new ToolInputError(
          "Cannot search retained messages without a valid Slack workspace id.",
        );
      }
      const filters = await resolveSearchFilters({ ...input, teamId });
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
        ...(filters.afterMs !== undefined
          ? { after: new Date(filters.afterMs).toISOString() }
          : {}),
        ...(filters.annotation ? { annotation: filters.annotation } : {}),
        ...(filters.beforeMs !== undefined
          ? { before: new Date(filters.beforeMs).toISOString() }
          : {}),
        ...(filters.query ? { query: filters.query } : {}),
        ...(filters.channelId ? { channel_id: filters.channelId } : {}),
        count: matchesOutput.length,
        matches: matchesOutput,
      };
    },
  });
}
