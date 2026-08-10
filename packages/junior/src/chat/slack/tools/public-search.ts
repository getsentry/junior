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

const optionalUnixTimestampParam = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? undefined : value,
  z.coerce
    .number()
    .int()
    .nonnegative()
    .describe("Unix timestamp bound.")
    .optional(),
);

const optionalString = z.string().min(1).optional();
const optionalUrl = z.string().url().optional();
const optionalBoolean = z.boolean().optional();

const searchMessageSchema = z.object({
  author_name: optionalString.describe("Author display name."),
  author_user_id: optionalString.describe("Author user ID."),
  channel_id: z.string().min(1).describe("Channel ID."),
  channel_name: optionalString.describe("Channel name."),
  message_ts: z.string().min(1).describe("Message timestamp."),
  content: z.string().describe("Message text."),
  is_author_bot: optionalBoolean.describe("Whether the author is a bot."),
  permalink: z.string().url().describe("Message permalink."),
});

const searchFileSchema = z.object({
  file_id: optionalString.describe("File ID."),
  title: optionalString.describe("File title."),
  name: optionalString.describe("File name."),
  filetype: optionalString.describe("File type."),
  user_id: optionalString.describe("Uploader user ID."),
  user_name: optionalString.describe("Uploader user name."),
  channel_id: optionalString.describe("Channel ID."),
  channel_name: optionalString.describe("Channel name."),
  permalink: optionalUrl.describe("File permalink."),
  content: optionalString.describe("File preview or content snippet."),
});

const searchChannelSchema = z.object({
  channel_id: optionalString.describe("Channel ID."),
  channel_name: optionalString.describe("Channel name."),
  is_private: optionalBoolean.describe("Whether the channel is private."),
  is_member: optionalBoolean.describe("Whether the bot is a member."),
  topic: optionalString.describe("Channel topic."),
  purpose: optionalString.describe("Channel purpose."),
  permalink: optionalUrl.describe("Channel permalink."),
});

const searchUserSchema = z.object({
  user_id: optionalString.describe("User ID."),
  user_name: optionalString.describe("Username."),
  real_name: optionalString.describe("Real name."),
  display_name: optionalString.describe("Display name."),
  title: optionalString.describe("Profile title."),
  permalink: optionalUrl.describe("Profile permalink."),
});

const publicSearchOutputSchema = juniorToolOutputSchema.extend({
  query: z.string().describe("Search query."),
  content_types: z
    .array(z.enum(CONTENT_TYPES))
    .describe("Content types included in the search."),
  count: z.number().int().nonnegative().describe("Total matched results."),
  messages: z.array(searchMessageSchema).describe("Matched messages."),
  files: z.array(searchFileSchema).describe("Matched files."),
  channels: z.array(searchChannelSchema).describe("Matched channels."),
  users: z.array(searchUserSchema).describe("Matched users."),
  next_cursor: optionalString.describe("Cursor for the next result page."),
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function pickString(
  record: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return undefined;
}

function pickBoolean(
  record: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function pickUrl(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const text = pickString(record, key);
  if (!text) {
    return undefined;
  }
  try {
    new URL(text);
    return text;
  } catch {
    return undefined;
  }
}

function normalizeMessage(value: unknown): SearchMessage | undefined {
  const parsed = searchMessageSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function normalizeFile(value: unknown): SearchFile | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const file = searchFileSchema.safeParse({
    file_id: pickString(record, "file_id", "id"),
    title: pickString(record, "title"),
    name: pickString(record, "name"),
    filetype: pickString(record, "filetype", "file_type"),
    user_id: pickString(record, "user_id", "user"),
    user_name: pickString(record, "user_name", "username"),
    channel_id: pickString(record, "channel_id"),
    channel_name: pickString(record, "channel_name"),
    permalink: pickUrl(record, "permalink"),
    content: pickString(record, "content", "preview"),
  });
  return file.success && Object.values(file.data).some((v) => v !== undefined)
    ? file.data
    : undefined;
}

function normalizeChannel(value: unknown): SearchChannel | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const channel = searchChannelSchema.safeParse({
    channel_id: pickString(record, "channel_id", "id"),
    channel_name: pickString(record, "channel_name", "name"),
    is_private: pickBoolean(record, "is_private"),
    is_member: pickBoolean(record, "is_member"),
    topic: pickString(record, "topic"),
    purpose: pickString(record, "purpose"),
    permalink: pickUrl(record, "permalink"),
  });
  return channel.success &&
    Object.values(channel.data).some((v) => v !== undefined)
    ? channel.data
    : undefined;
}

function normalizeUser(value: unknown): SearchUser | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const user = searchUserSchema.safeParse({
    user_id: pickString(record, "user_id", "id"),
    user_name: pickString(record, "user_name", "name", "username"),
    real_name: pickString(record, "real_name"),
    display_name: pickString(record, "display_name"),
    title: pickString(record, "title"),
    permalink: pickUrl(record, "permalink"),
  });
  return user.success && Object.values(user.data).some((v) => v !== undefined)
    ? user.data
    : undefined;
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

/** Create the public-channel Slack search tool. */
export function createSlackPublicSearchTool(actionToken?: SlackActionToken) {
  return zodTool({
    description:
      "Search live public Slack content across the workspace. Defaults to messages; optionally include files, channels, or users. Private channels and DMs are never searched.",
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
        .describe("Slack search query."),
      content_types: z
        .array(z.enum(CONTENT_TYPES))
        .min(1)
        .max(4)
        .describe("Content types to include. Defaults to messages.")
        .optional(),
      after: optionalUnixTimestampParam.describe(
        "Optional Unix timestamp lower bound.",
      ),
      before: optionalUnixTimestampParam.describe(
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
      if (!actionToken) {
        throw new ToolInputError(
          "Public Slack search needs a fresh interactive mention or DM. Slack only issues the short-lived action token on those turns, so resumes and scheduled runs cannot search the workspace. Ask again in a new message, or use channel history / thread read when you already know the channel.",
        );
      }
      try {
        const normalizedContentTypes = normalizeContentTypes(content_types);
        const normalizedAfter = optionalUnixTimestampParam.parse(after);
        const normalizedBefore = optionalUnixTimestampParam.parse(before);
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
