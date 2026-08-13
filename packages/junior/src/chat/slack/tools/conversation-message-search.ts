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

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

const conversationMessageSearchOutputSchema = juniorToolOutputSchema.extend({
  active_after: z.string().datetime().optional(),
  active_before: z.string().datetime().optional(),
  annotation_key_prefix: z.string().min(1).optional(),
  annotation_plugin: z.string().min(1).optional(),
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

function parseActivityTimestamp(
  field: "active_after" | "active_before",
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
  active_after?: string | null;
  active_before?: string | null;
  annotation_key_prefix?: string | null;
  annotation_plugin?: string | null;
  channel_id?: string | null;
  query?: string | null;
}): Promise<ConversationMessageSearchFilters> {
  const query = input.query?.trim() || undefined;
  const annotationKeyPrefix = input.annotation_key_prefix?.trim() || undefined;
  const annotationPlugin = input.annotation_plugin?.trim() || undefined;
  const activeAfterMs = parseActivityTimestamp(
    "active_after",
    input.active_after,
  );
  const activeBeforeMs = parseActivityTimestamp(
    "active_before",
    input.active_before,
  );
  let channelId: string | undefined;

  if (input.channel_id != null && input.channel_id.trim() !== "") {
    const target = await resolveSlackChannelRef({
      field: "channel_id",
      value: input.channel_id,
    });
    channelId = target.channelId;
  }

  if (
    activeAfterMs !== undefined &&
    activeBeforeMs !== undefined &&
    activeAfterMs >= activeBeforeMs
  ) {
    throw new ToolInputError("active_after must be before active_before");
  }
  if (!query && !channelId && !annotationKeyPrefix) {
    throw new ToolInputError(
      "Provide at least one of `query`, `channel_id`, or `annotation_key_prefix`.",
    );
  }
  if (annotationPlugin && !annotationKeyPrefix) {
    throw new ToolInputError(
      "annotation_plugin requires annotation_key_prefix",
    );
  }

  return {
    ...(activeAfterMs !== undefined ? { activeAfterMs } : {}),
    ...(activeBeforeMs !== undefined ? { activeBeforeMs } : {}),
    ...(annotationKeyPrefix ? { annotationKeyPrefix } : {}),
    ...(annotationPlugin ? { annotationPlugin } : {}),
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
      "Search retained user and assistant messages from public conversations in this Slack workspace. Filter by message text, channel, activity time, or plugin-owned conversation annotation. Excludes the current conversation. Not live Slack workspace search.",
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
        active_after: z
          .string()
          .datetime()
          .nullable()
          .describe("Include conversations active at or after this timestamp.")
          .optional(),
        active_before: z
          .string()
          .datetime()
          .nullable()
          .describe("Include conversations active before this timestamp.")
          .optional(),
        annotation_key_prefix: z
          .string()
          .trim()
          .min(1)
          .max(256)
          .nullable()
          .describe("Plugin-owned annotation key prefix.")
          .optional(),
        annotation_plugin: z
          .string()
          .trim()
          .min(1)
          .max(64)
          .nullable()
          .describe("Plugin that owns the annotation.")
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
        ...(filters.activeAfterMs !== undefined
          ? { active_after: new Date(filters.activeAfterMs).toISOString() }
          : {}),
        ...(filters.activeBeforeMs !== undefined
          ? { active_before: new Date(filters.activeBeforeMs).toISOString() }
          : {}),
        ...(filters.annotationKeyPrefix
          ? { annotation_key_prefix: filters.annotationKeyPrefix }
          : {}),
        ...(filters.annotationPlugin
          ? { annotation_plugin: filters.annotationPlugin }
          : {}),
        ...(filters.query ? { query: filters.query } : {}),
        ...(filters.channelId ? { channel_id: filters.channelId } : {}),
        count: matchesOutput.length,
        matches: matchesOutput,
      };
    },
  });
}
