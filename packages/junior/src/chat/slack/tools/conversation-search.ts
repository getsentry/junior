import { z } from "zod";
import type {
  ConversationSearchFilters,
  ConversationSearchScope,
  ConversationSearchStore,
} from "@/chat/conversations/search";
import { getConversationSearchStore } from "@/chat/db";
import { parseSlackThreadId } from "@/chat/slack/context";
import {
  parseRequiredSlackChannelIdParam,
  parseRequiredSlackUserIdParam,
  slackChannelIdParam,
  slackUserIdParam,
} from "@/chat/slack/id-param";
import { getSlackMessagePermalink } from "@/chat/slack/outbound";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

const DEFAULT_LIMIT = 5;

const conversationSearchOutputSchema = juniorToolOutputSchema.extend({
  author_user_id: z.string().min(1).optional(),
  channel_id: z.string().min(1).optional(),
  count: z.number().int().nonnegative(),
  query: z.string().optional(),
  threads: z.array(
    z
      .object({
        author_user_id: z.string().min(1).optional(),
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

interface ConversationSearchToolDeps {
  getPermalink?: typeof getSlackMessagePermalink;
  store?: ConversationSearchStore;
}

function resolveSearchFilters(input: {
  author_user_id?: string | null;
  channel_id?: string | null;
  query?: string | null;
}): ConversationSearchFilters {
  const query = input.query?.trim() || undefined;
  let authorUserId: string | undefined;
  let channelId: string | undefined;

  if (input.author_user_id != null) {
    const parsed = parseRequiredSlackUserIdParam(
      "author_user_id",
      input.author_user_id,
    );
    if (!parsed.ok) {
      throw new ToolInputError(parsed.error);
    }
    authorUserId = parsed.value;
  }

  if (input.channel_id != null) {
    const parsed = parseRequiredSlackChannelIdParam(
      "channel_id",
      input.channel_id,
    );
    if (!parsed.ok) {
      throw new ToolInputError(parsed.error);
    }
    channelId = parsed.value;
  }

  if (!query && !authorUserId && !channelId) {
    throw new ToolInputError(
      "Provide at least one of `query`, `author_user_id`, or `channel_id`.",
    );
  }

  return {
    ...(authorUserId ? { authorUserId } : {}),
    ...(channelId ? { channelId } : {}),
    ...(query ? { query } : {}),
  };
}

/** Create a tool that searches retained public Junior threads across an authorized Slack workspace. */
export function createSlackConversationSearchTool(
  scope: ConversationSearchScope,
  currentConversationId: string,
  deps: ConversationSearchToolDeps = {},
) {
  return zodTool({
    description:
      "Search prior public Junior conversation threads across the current Slack workspace. Use when the user refers to an earlier public discussion, decision, or answer that is not in the current thread. Searches retained visible user and assistant messages only. Public destination visibility is always required. Narrow with author_user_id and/or channel_id; do not assume the active channel unless the user asks for it.",
    exposure: "deferred",
    source: {
      id: "conversation-history",
      description:
        "Search retained public Junior conversation threads in the current Slack workspace.",
    },
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: true,
    },
    inputSchema: z
      .object({
        author_user_id: slackUserIdParam(
          "Optional Slack user ID of the visible message author to filter by. Matches message authors, not thread starters. Use a Slack user ID like U123; do not guess.",
        )
          .nullable()
          .optional(),
        channel_id: slackChannelIdParam(
          "Optional Slack channel ID to filter by. Use the ID from a channel mention; do not guess. Does not default to the active channel.",
        )
          .nullable()
          .optional(),
        query: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .nullable()
          .describe(
            "Optional words or a short phrase to find in prior conversations. Required when author_user_id and channel_id are both omitted.",
          )
          .optional(),
        limit: z
          .number()
          .int()
          .min(1)
          .max(10)
          .describe("Maximum number of prior conversation threads to return.")
          .nullable()
          .optional(),
      })
      .strict(),
    outputSchema: conversationSearchOutputSchema,
    execute: async (input) => {
      const filters = resolveSearchFilters(input);
      const store = deps.store ?? getConversationSearchStore();
      const matches = await store.search({
        currentConversationId,
        filters,
        limit: input.limit ?? DEFAULT_LIMIT,
        scope,
      });
      const getPermalink = deps.getPermalink ?? getSlackMessagePermalink;
      const threads = await Promise.all(
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
          const permalink = await getPermalink({
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
            ...(match.authorUserId
              ? { author_user_id: match.authorUserId }
              : {}),
            ...(match.channelName ? { channel_name: match.channelName } : {}),
            ...(permalink ? { permalink } : {}),
          };
        }),
      );

      return {
        ...(filters.query ? { query: filters.query } : {}),
        ...(filters.authorUserId
          ? { author_user_id: filters.authorUserId }
          : {}),
        ...(filters.channelId ? { channel_id: filters.channelId } : {}),
        count: threads.length,
        threads,
      };
    },
  });
}
