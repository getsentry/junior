import { z } from "zod";
import type { SlackActionToken } from "@/chat/slack/action-token";
import {
  getSlackClient,
  SlackActionError,
  withSlackRetries,
} from "@/chat/slack/client";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

const DEFAULT_LIMIT = 10;
const DEFAULT_CONTENT_TYPES = ["messages"] as const;
const CONTENT_TYPES = ["messages", "files", "channels", "users"] as const;

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

const searchFileSchema = z.object({
  file_id: z.string().min(1).optional(),
  title: z.string().optional(),
  name: z.string().optional(),
  filetype: z.string().optional(),
  user_id: z.string().optional(),
  user_name: z.string().optional(),
  channel_id: z.string().optional(),
  channel_name: z.string().optional(),
  permalink: z.string().url().optional(),
  content: z.string().optional(),
});

const searchChannelSchema = z.object({
  channel_id: z.string().min(1).optional(),
  channel_name: z.string().optional(),
  is_private: z.boolean().optional(),
  is_member: z.boolean().optional(),
  topic: z.string().optional(),
  purpose: z.string().optional(),
  permalink: z.string().url().optional(),
});

const searchUserSchema = z.object({
  user_id: z.string().min(1).optional(),
  user_name: z.string().optional(),
  real_name: z.string().optional(),
  display_name: z.string().optional(),
  title: z.string().optional(),
  permalink: z.string().url().optional(),
});

const publicSearchOutputSchema = juniorToolOutputSchema.extend({
  query: z.string(),
  content_types: z.array(z.enum(CONTENT_TYPES)),
  count: z.number().int().nonnegative(),
  messages: z.array(searchMessageSchema),
  files: z.array(searchFileSchema),
  channels: z.array(searchChannelSchema),
  users: z.array(searchUserSchema),
  next_cursor: z.string().optional(),
});

type SearchMessage = z.infer<typeof searchMessageSchema>;
type SearchFile = z.infer<typeof searchFileSchema>;
type SearchChannel = z.infer<typeof searchChannelSchema>;
type SearchUser = z.infer<typeof searchUserSchema>;

interface SlackSearchResponse {
  results?: {
    messages?: unknown[];
    files?: unknown[];
    channels?: unknown[];
    users?: unknown[];
    next_cursor?: unknown;
  };
}

function normalizeMessage(value: unknown): SearchMessage | undefined {
  const parsed = searchMessageSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function optionalUrl(value: unknown): string | undefined {
  const text = optionalString(value);
  if (!text) {
    return undefined;
  }
  try {
    // Validate URL shape without throwing out of search result mapping.
    new URL(text);
    return text;
  } catch {
    return undefined;
  }
}

function normalizeFile(value: unknown): SearchFile | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const file: SearchFile = {
    ...(optionalString(record.file_id ?? record.id)
      ? { file_id: optionalString(record.file_id ?? record.id) }
      : {}),
    ...(optionalString(record.title) ? { title: optionalString(record.title) } : {}),
    ...(optionalString(record.name) ? { name: optionalString(record.name) } : {}),
    ...(optionalString(record.filetype ?? record.file_type)
      ? { filetype: optionalString(record.filetype ?? record.file_type) }
      : {}),
    ...(optionalString(record.user_id ?? record.user)
      ? { user_id: optionalString(record.user_id ?? record.user) }
      : {}),
    ...(optionalString(record.user_name ?? record.username)
      ? { user_name: optionalString(record.user_name ?? record.username) }
      : {}),
    ...(optionalString(record.channel_id)
      ? { channel_id: optionalString(record.channel_id) }
      : {}),
    ...(optionalString(record.channel_name)
      ? { channel_name: optionalString(record.channel_name) }
      : {}),
    ...(optionalUrl(record.permalink)
      ? { permalink: optionalUrl(record.permalink) }
      : {}),
    ...(optionalString(record.content ?? record.preview)
      ? { content: optionalString(record.content ?? record.preview) }
      : {}),
  };

  return Object.keys(file).length > 0 ? file : undefined;
}

function normalizeChannel(value: unknown): SearchChannel | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const channel: SearchChannel = {
    ...(optionalString(record.channel_id ?? record.id)
      ? { channel_id: optionalString(record.channel_id ?? record.id) }
      : {}),
    ...(optionalString(record.channel_name ?? record.name)
      ? { channel_name: optionalString(record.channel_name ?? record.name) }
      : {}),
    ...(optionalBoolean(record.is_private) !== undefined
      ? { is_private: optionalBoolean(record.is_private) }
      : {}),
    ...(optionalBoolean(record.is_member) !== undefined
      ? { is_member: optionalBoolean(record.is_member) }
      : {}),
    ...(optionalString(record.topic) ? { topic: optionalString(record.topic) } : {}),
    ...(optionalString(record.purpose)
      ? { purpose: optionalString(record.purpose) }
      : {}),
    ...(optionalUrl(record.permalink)
      ? { permalink: optionalUrl(record.permalink) }
      : {}),
  };

  return Object.keys(channel).length > 0 ? channel : undefined;
}

function normalizeUser(value: unknown): SearchUser | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const user: SearchUser = {
    ...(optionalString(record.user_id ?? record.id)
      ? { user_id: optionalString(record.user_id ?? record.id) }
      : {}),
    ...(optionalString(record.user_name ?? record.name ?? record.username)
      ? {
          user_name: optionalString(
            record.user_name ?? record.name ?? record.username,
          ),
        }
      : {}),
    ...(optionalString(record.real_name)
      ? { real_name: optionalString(record.real_name) }
      : {}),
    ...(optionalString(record.display_name)
      ? { display_name: optionalString(record.display_name) }
      : {}),
    ...(optionalString(record.title) ? { title: optionalString(record.title) } : {}),
    ...(optionalUrl(record.permalink)
      ? { permalink: optionalUrl(record.permalink) }
      : {}),
  };

  return Object.keys(user).length > 0 ? user : undefined;
}

function explicitSearchError(error: SlackActionError): string | undefined {
  if (error.code === "missing_scope") {
    const needed = error.needed?.trim();
    if (needed) {
      return `Public Slack search is unavailable because this installation is missing the \`${needed}\` scope.`;
    }
    return "Public Slack search is unavailable because this installation is missing a required search scope (`search:read.public`, and `search:read.files` / `search:read.users` when those content types are requested).";
  }
  if (error.code === "feature_unavailable") {
    return "Public Slack search is not available for this Slack workspace or app installation.";
  }
  if (error.apiError === "invalid_action_token") {
    return "Public Slack search could not use the current Slack interaction token. Ask again in a new message or mention.";
  }
  return undefined;
}

function normalizeContentTypes(
  contentTypes: Array<(typeof CONTENT_TYPES)[number]> | undefined,
): Array<(typeof CONTENT_TYPES)[number]> {
  const selected = contentTypes?.length
    ? contentTypes
    : [...DEFAULT_CONTENT_TYPES];
  return [...new Set(selected)];
}

/** Create an interactive, public-channel Slack search tool. */
export function createSlackPublicSearchTool(actionToken: SlackActionToken) {
  return zodTool({
    description:
      "Search public Slack content across the current workspace. Defaults to messages. Optionally include files, channels, or users when those content types are needed. Use when the user asks about company activity, announcements, public mentions, shared files, people, or context outside the active channel. Search only when requested or clearly needed, prefer focused keywords and time bounds, and cite returned permalinks. This never searches private channels or DMs.",
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: true,
    },
    inputSchema: z.object({
      query: z
        .string()
        .trim()
        .min(1)
        .max(500)
        .describe(
          "A focused Slack search query, including Slack search filters when useful.",
        ),
      content_types: z
        .array(z.enum(CONTENT_TYPES))
        .min(1)
        .max(4)
        .describe(
          "Content types to include. Defaults to messages. Use files, channels, or users only when needed. Requires matching bot scopes: search:read.public, and search:read.files / search:read.users for those types.",
        )
        .optional(),
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
      content_types,
      after,
      before,
      cursor,
      limit,
      sort,
      sort_dir,
    }) => {
      try {
        const normalizedContentTypes = normalizeContentTypes(content_types);
        const normalizedAfter = optionalTimestampSchema.parse(after);
        const normalizedBefore = optionalTimestampSchema.parse(before);
        const response = (await withSlackRetries(
          () =>
            getSlackClient().apiCall("assistant.search.context", {
              action_token: actionToken,
              query,
              channel_types: ["public_channel"],
              content_types: normalizedContentTypes,
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
        const files = (response.results?.files ?? [])
          .map(normalizeFile)
          .filter((file): file is SearchFile => Boolean(file));
        const channels = (response.results?.channels ?? [])
          .map(normalizeChannel)
          .filter((channel): channel is SearchChannel => Boolean(channel));
        const users = (response.results?.users ?? [])
          .map(normalizeUser)
          .filter((user): user is SearchUser => Boolean(user));
        const nextCursor = response.results?.next_cursor;
        const count =
          messages.length + files.length + channels.length + users.length;

        return {
          query,
          content_types: normalizedContentTypes,
          count,
          messages,
          files,
          channels,
          users,
          ...(typeof nextCursor === "string" && nextCursor
            ? { next_cursor: nextCursor }
            : {}),
        };
      } catch (error) {
        if (error instanceof SlackActionError) {
          const message = explicitSearchError(error);
          if (message) {
            throw new ToolInputError(message, { cause: error });
          }
        }
        throw error;
      }
    },
  });
}
