import { z } from "zod";
import type { SlackActionToken } from "@/chat/slack/action-token";
import {
  getSlackClient,
  SlackActionError,
  withSlackRetries,
} from "@/chat/slack/client";
import { juniorToolResultSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";

const DEFAULT_LIMIT = 10;

const optionalTimestampSchema = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? undefined : value,
  z.coerce
    .number()
    .int()
    .nonnegative()
    .describe("Optional Unix timestamp bound.")
    .optional(),
);

const searchMessageSchema = z.object({
  author_name: z.string().optional(),
  author_user_id: z.string().optional(),
  channel_id: z.string().min(1),
  channel_name: z.string().optional(),
  message_ts: z.string().min(1),
  content: z.string(),
  is_author_bot: z.boolean().optional(),
  permalink: z.string().url(),
});

const publicSearchOutputSchema = juniorToolResultSchema.extend({
  query: z.string(),
  count: z.number().int().nonnegative(),
  messages: z.array(searchMessageSchema),
  next_cursor: z.string().optional(),
});

type SearchMessage = z.infer<typeof searchMessageSchema>;

interface SlackSearchResponse {
  results?: {
    messages?: unknown[];
    next_cursor?: unknown;
  };
}

function normalizeMessage(value: unknown): SearchMessage | undefined {
  const parsed = searchMessageSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function explicitSearchError(error: SlackActionError): string | undefined {
  if (error.code === "missing_scope") {
    return "Public Slack search is unavailable because this installation is missing the `search:read.public` scope.";
  }
  if (error.code === "feature_unavailable") {
    return "Public Slack search is not available for this Slack workspace or app installation.";
  }
  if (error.apiError === "invalid_action_token") {
    return "Public Slack search could not use the current Slack interaction token. Ask again in a new message or mention.";
  }
  return undefined;
}

/** Create an interactive, public-channel-only Slack search tool. */
export function createSlackPublicSearchTool(actionToken: SlackActionToken) {
  return zodTool({
    description:
      "Search public Slack channel messages across the current workspace. Use when the user asks about company activity, announcements, public mentions, or context outside the active channel. Search only when requested or clearly needed, prefer focused keywords and time bounds, and cite returned permalinks. This never searches private channels or DMs.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: z.object({
      query: z
        .string()
        .trim()
        .min(1)
        .max(500)
        .describe(
          "A focused Slack search query, including Slack search filters when useful.",
        ),
      after: optionalTimestampSchema.describe(
        "Optional Unix timestamp lower bound.",
      ),
      before: optionalTimestampSchema.describe(
        "Optional Unix timestamp upper bound.",
      ),
      cursor: z
        .string()
        .min(1)
        .describe("Cursor for the next result page.")
        .optional(),
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(20)
        .describe("Maximum results to return; Slack allows at most 20.")
        .optional(),
      sort: z
        .enum(["score", "timestamp"])
        .describe("Rank by relevance or timestamp.")
        .optional(),
      sort_dir: z.enum(["asc", "desc"]).describe("Sort direction.").optional(),
    }),
    outputSchema: publicSearchOutputSchema,
    execute: async ({
      query,
      after,
      before,
      cursor,
      limit,
      sort,
      sort_dir,
    }) => {
      try {
        const normalizedAfter = optionalTimestampSchema.parse(after);
        const normalizedBefore = optionalTimestampSchema.parse(before);
        const response = (await withSlackRetries(
          () =>
            getSlackClient().apiCall("assistant.search.context", {
              action_token: actionToken,
              query,
              channel_types: ["public_channel"],
              content_types: ["messages"],
              include_bots: true,
              limit: limit ?? DEFAULT_LIMIT,
              ...(normalizedAfter !== undefined
                ? { after: normalizedAfter }
                : {}),
              ...(normalizedBefore !== undefined
                ? { before: normalizedBefore }
                : {}),
              ...(cursor ? { cursor } : {}),
              ...(sort ? { sort } : {}),
              ...(sort_dir ? { sort_dir } : {}),
            }),
          3,
          {
            action: "assistant.search.context",
            idempotent: true,
          },
        )) as SlackSearchResponse;
        const messages = (response.results?.messages ?? [])
          .map(normalizeMessage)
          .filter((message): message is SearchMessage => Boolean(message));
        const nextCursor = response.results?.next_cursor;

        return {
          ok: true,
          status: "success" as const,
          query,
          count: messages.length,
          messages,
          ...(typeof nextCursor === "string" && nextCursor
            ? { next_cursor: nextCursor }
            : {}),
        };
      } catch (error) {
        if (error instanceof SlackActionError) {
          const message = explicitSearchError(error);
          if (message) {
            return {
              ok: false,
              status: "error" as const,
              error: message,
              query,
              count: 0,
              messages: [],
            };
          }
        }
        throw error;
      }
    },
  });
}
