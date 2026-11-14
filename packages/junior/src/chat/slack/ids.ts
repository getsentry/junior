import * as z from "zod";
import {
  parseSlackMessageTs,
  slackMessageTsSchema,
  type SlackMessageTs,
} from "@/chat/slack/timestamp";

// Slack-owned runtime boundaries parse raw strings into branded IDs here.
// Exact ID parsers reject Junior reference strings; reference parsing stays
// explicit for persisted `slack:<channel>` and `slack:<channel>:<ts>` values.
export const slackChannelIdSchema = z
  .string()
  .regex(/^[CDG][A-Z0-9]+$/)
  .brand<"SlackChannelId">();

export const slackTeamIdSchema = z
  .string()
  .regex(/^T[A-Z0-9]+$/)
  .brand<"SlackTeamId">();

export const slackUserIdSchema = z
  .string()
  .regex(/^[UW][A-Z0-9]+$/)
  .brand<"SlackUserId">();

export const slackBotIdSchema = z
  .string()
  .regex(/^B[A-Z0-9]+$/)
  .brand<"SlackBotId">();

// The brand is a private symbol and the schema is not exported, so no other
// module can make a SlackThreadId from a Conversation id string.
declare const slackThreadIdBrand: unique symbol;
const slackThreadIdSchema = z
  .string()
  .regex(/^slack:[CDG][A-Z0-9]+:\d+(?:\.\d+)?$/)
  .brand<typeof slackThreadIdBrand>();

export type SlackBotId = z.output<typeof slackBotIdSchema>;
export type SlackChannelId = z.output<typeof slackChannelIdSchema>;
export type SlackTeamId = z.output<typeof slackTeamIdSchema>;
export type SlackUserId = z.output<typeof slackUserIdSchema>;
/**
 * A Slack thread, as `slack:<channel>:<thread ts>`. A Conversation id is a
 * plain string, so it is not a SlackThreadId, also when it has this format.
 */
export type SlackThreadId = z.output<typeof slackThreadIdSchema>;

const SLACK_CHANNEL_MENTION_RE = /^<#([CDG][A-Z0-9]+)(?:\|[^>]*)?>$/;

function slackChannelReferenceCandidate(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("slack:")) {
    return trimmed;
  }

  const parts = trimmed.split(":");
  if (parts.length === 2) {
    return parts[1]?.trim() ?? "";
  }
  if (parts.length === 3 && parseSlackMessageTs(parts[2])) {
    return parts[1]?.trim() ?? "";
  }
  return "";
}

/** Parse an exact Slack channel/conversation ID from untrusted input. */
export function parseSlackChannelId(
  value: unknown,
): SlackChannelId | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = slackChannelIdSchema.safeParse(value.trim());
  return parsed.success ? parsed.data : undefined;
}

/**
 * Parse a channel id from common tool/model reference forms.
 *
 * Accepts exact ids (`C123`), Slack mentions (`<#C123>` / `<#C123|name>`),
 * and Junior slack references (`slack:C123`, `slack:C123:ts`). Plain channel
 * names are not ids and are rejected here.
 */
export function parseSlackChannelReferenceId(
  value: unknown,
): SlackChannelId | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  const mentionMatch = SLACK_CHANNEL_MENTION_RE.exec(trimmed);
  if (mentionMatch?.[1]) {
    return parseSlackChannelId(mentionMatch[1]);
  }
  return parseSlackChannelId(slackChannelReferenceCandidate(trimmed));
}

/** Parse a Slack workspace/team ID from untrusted metadata. */
export function parseSlackTeamId(value: unknown): SlackTeamId | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = slackTeamIdSchema.safeParse(value.trim());
  return parsed.success ? parsed.data : undefined;
}

/** Parse a Slack user ID from untrusted metadata. */
export function parseSlackUserId(value: unknown): SlackUserId | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = slackUserIdSchema.safeParse(value.trim());
  return parsed.success ? parsed.data : undefined;
}

/** Return true when a value is exactly a Slack workspace/team id. */
export function isSlackTeamId(value: string): value is SlackTeamId {
  return value === value.trim() && slackTeamIdSchema.safeParse(value).success;
}

/** Build the Slack thread id of a verified channel and thread timestamp. */
export function slackThreadId(
  channelId: SlackChannelId,
  threadTs: SlackMessageTs,
): SlackThreadId {
  return slackThreadIdSchema.parse(`slack:${channelId}:${threadTs}`);
}

/** Split a Slack thread id into its channel and thread timestamp. */
export function parseSlackThreadId(threadId: SlackThreadId): {
  channelId: SlackChannelId;
  threadTs: SlackMessageTs;
} {
  const [, channelId, threadTs] = threadId.split(":");
  return {
    channelId: slackChannelIdSchema.parse(channelId),
    threadTs: slackMessageTsSchema.parse(threadTs),
  };
}

/**
 * Verify a `slack:<channel>:<ts>` string that has no typed Slack source, such
 * as model tool input. A Conversation id is not a Slack thread reference: an
 * Automation Conversation that owns a Slack thread has another id. Read an
 * inbound thread with `slackThreadIdOfMessage`, and get where to post from
 * `resolveSlackReplyTarget`.
 */
export function parseSlackThreadReference(
  value: unknown,
): SlackThreadId | undefined {
  if (typeof value !== "string") return undefined;
  const parts = value.trim().split(":");
  if (parts.length !== 3 || parts[0] !== "slack") return undefined;
  const channelId = parseSlackChannelId(parts[1]);
  const threadTs = parseSlackMessageTs(parts[2]);
  return channelId && threadTs ? slackThreadId(channelId, threadTs) : undefined;
}
