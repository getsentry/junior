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

/** Canonical public-search message result. */
const searchMessageSchema = z.object({
  author_name: z.string().min(1).optional().describe("Author display name."),
  author_user_id: z.string().min(1).optional().describe("Author user ID."),
  channel_id: z.string().min(1).describe("Channel ID."),
  channel_name: z.string().min(1).optional().describe("Channel name."),
  message_ts: z.string().min(1).describe("Message timestamp."),
  content: z.string().describe("Message text."),
  is_author_bot: z.boolean().optional().describe("Whether the author is a bot."),
  permalink: z.string().url().describe("Message permalink."),
});

/** Canonical public-search file result. */
const searchFileSchema = z.object({
  file_id: z.string().min(1).describe("File ID."),
  title: z.string().min(1).optional().describe("File title."),
  name: z.string().min(1).optional().describe("File name."),
  filetype: z.string().min(1).optional().describe("File type."),
  user_id: z.string().min(1).optional().describe("Uploader user ID."),
  user_name: z.string().min(1).optional().describe("Uploader user name."),
  channel_id: z.string().min(1).optional().describe("Channel ID."),
  channel_name: z.string().min(1).optional().describe("Channel name."),
  permalink: z.string().url().optional().describe("File permalink."),
  content: z
    .string()
    .min(1)
    .optional()
    .describe("File preview or content snippet."),
});

/** Canonical public-search channel result. */
const searchChannelSchema = z.object({
  channel_id: z.string().min(1).describe("Channel ID."),
  channel_name: z.string().min(1).optional().describe("Channel name."),
  is_private: z.boolean().optional().describe("Whether the channel is private."),
  is_member: z.boolean().optional().describe("Whether the bot is a member."),
  topic: z.string().min(1).optional().describe("Channel topic."),
  purpose: z.string().min(1).optional().describe("Channel purpose."),
  permalink: z.string().url().optional().describe("Channel permalink."),
});

/** Canonical public-search user result. */
const searchUserSchema = z.object({
  user_id: z.string().min(1).describe("User ID."),
  user_name: z.string().min(1).optional().describe("Username."),
  real_name: z.string().min(1).optional().describe("Real name."),
  display_name: z.string().min(1).optional().describe("Display name."),
  title: z.string().min(1).optional().describe("Profile title."),
  permalink: z.string().url().optional().describe("Profile permalink."),
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
  next_cursor: z
    .string()
    .min(1)
    .optional()
    .describe("Cursor for the next result page."),
});

type SearchMessage = z.infer<typeof searchMessageSchema>;
type SearchFile = z.infer<typeof searchFileSchema>;
type SearchChannel = z.infer<typeof searchChannelSchema>;
type SearchUser = z.infer<typeof searchUserSchema>;

const nonEmptyString = z.string().trim().min(1);

/** Slack wire shape for one search message. */
const slackSearchMessageWireSchema = z
  .object({
    author_name: nonEmptyString.optional(),
    author_user_id: nonEmptyString.optional(),
    channel_id: nonEmptyString,
    channel_name: nonEmptyString.optional(),
    message_ts: nonEmptyString,
    content: z.string(),
    is_author_bot: z.boolean().optional(),
    permalink: z.string().url(),
  })
  .transform(
    (value): SearchMessage => ({
      channel_id: value.channel_id,
      message_ts: value.message_ts,
      content: value.content,
      permalink: value.permalink,
      ...(value.author_name ? { author_name: value.author_name } : {}),
      ...(value.author_user_id
        ? { author_user_id: value.author_user_id }
        : {}),
      ...(value.channel_name ? { channel_name: value.channel_name } : {}),
      ...(value.is_author_bot !== undefined
        ? { is_author_bot: value.is_author_bot }
        : {}),
    }),
  );

/** Slack wire shape for one search file. */
const slackSearchFileWireSchema = z
  .object({
    id: nonEmptyString.optional(),
    file_id: nonEmptyString.optional(),
    title: nonEmptyString.optional(),
    name: nonEmptyString.optional(),
    filetype: nonEmptyString.optional(),
    file_type: nonEmptyString.optional(),
    user: nonEmptyString.optional(),
    user_id: nonEmptyString.optional(),
    username: nonEmptyString.optional(),
    user_name: nonEmptyString.optional(),
    channel_id: nonEmptyString.optional(),
    channel_name: nonEmptyString.optional(),
    permalink: z.string().url().optional(),
    content: nonEmptyString.optional(),
    preview: nonEmptyString.optional(),
  })
  .transform((value): SearchFile | undefined => {
    const fileId = value.file_id ?? value.id;
    if (!fileId) {
      return undefined;
    }
    return {
      file_id: fileId,
      ...(value.title ? { title: value.title } : {}),
      ...(value.name ? { name: value.name } : {}),
      ...((value.filetype ?? value.file_type)
        ? { filetype: value.filetype ?? value.file_type }
        : {}),
      ...((value.user_id ?? value.user)
        ? { user_id: value.user_id ?? value.user }
        : {}),
      ...((value.user_name ?? value.username)
        ? { user_name: value.user_name ?? value.username }
        : {}),
      ...(value.channel_id ? { channel_id: value.channel_id } : {}),
      ...(value.channel_name ? { channel_name: value.channel_name } : {}),
      ...(value.permalink ? { permalink: value.permalink } : {}),
      ...((value.content ?? value.preview)
        ? { content: value.content ?? value.preview }
        : {}),
    };
  });

/** Slack wire shape for one search channel. */
const slackSearchChannelWireSchema = z
  .object({
    id: nonEmptyString.optional(),
    channel_id: nonEmptyString.optional(),
    name: nonEmptyString.optional(),
    channel_name: nonEmptyString.optional(),
    is_private: z.boolean().optional(),
    is_member: z.boolean().optional(),
    topic: nonEmptyString.optional(),
    purpose: nonEmptyString.optional(),
    permalink: z.string().url().optional(),
  })
  .transform((value): SearchChannel | undefined => {
    const channelId = value.channel_id ?? value.id;
    if (!channelId) {
      return undefined;
    }
    return {
      channel_id: channelId,
      ...((value.channel_name ?? value.name)
        ? { channel_name: value.channel_name ?? value.name }
        : {}),
      ...(value.is_private !== undefined
        ? { is_private: value.is_private }
        : {}),
      ...(value.is_member !== undefined ? { is_member: value.is_member } : {}),
      ...(value.topic ? { topic: value.topic } : {}),
      ...(value.purpose ? { purpose: value.purpose } : {}),
      ...(value.permalink ? { permalink: value.permalink } : {}),
    };
  });

/** Slack wire shape for one search user. */
const slackSearchUserWireSchema = z
  .object({
    id: nonEmptyString.optional(),
    user_id: nonEmptyString.optional(),
    name: nonEmptyString.optional(),
    username: nonEmptyString.optional(),
    user_name: nonEmptyString.optional(),
    real_name: nonEmptyString.optional(),
    display_name: nonEmptyString.optional(),
    title: nonEmptyString.optional(),
    permalink: z.string().url().optional(),
  })
  .transform((value): SearchUser | undefined => {
    const userId = value.user_id ?? value.id;
    if (!userId) {
      return undefined;
    }
    return {
      user_id: userId,
      ...((value.user_name ?? value.name ?? value.username)
        ? { user_name: value.user_name ?? value.name ?? value.username }
        : {}),
      ...(value.real_name ? { real_name: value.real_name } : {}),
      ...(value.display_name ? { display_name: value.display_name } : {}),
      ...(value.title ? { title: value.title } : {}),
      ...(value.permalink ? { permalink: value.permalink } : {}),
    };
  });

const slackSearchResponseSchema = z.object({
  results: z
    .object({
      messages: z.array(z.unknown()).default([]),
      files: z.array(z.unknown()).default([]),
      channels: z.array(z.unknown()).default([]),
      users: z.array(z.unknown()).default([]),
      next_cursor: z.string().min(1).optional(),
    })
    .default({
      messages: [],
      files: [],
      channels: [],
      users: [],
    }),
});

function parseItems<T>(
  values: unknown[],
  schema: z.ZodType<T | undefined>,
): T[] {
  const items: T[] = [];
  for (const value of values) {
    const parsed = schema.safeParse(value);
    if (parsed.success && parsed.data !== undefined) {
      items.push(parsed.data);
    }
  }
  return items;
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
        const response = slackSearchResponseSchema.parse(
          await withSlackRetries(
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
          ),
        );
        const messages = parseItems(
          response.results.messages,
          slackSearchMessageWireSchema,
        );
        const files = parseItems(
          response.results.files,
          slackSearchFileWireSchema,
        );
        const channels = parseItems(
          response.results.channels,
          slackSearchChannelWireSchema,
        );
        const users = parseItems(
          response.results.users,
          slackSearchUserWireSchema,
        );
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
          ...(response.results.next_cursor
            ? { next_cursor: response.results.next_cursor }
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
