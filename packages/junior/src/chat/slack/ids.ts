import { z } from "zod";
import { parseSlackMessageTs } from "@/chat/slack/timestamp";

// Slack-owned runtime boundaries parse raw strings into branded IDs here.
// Exact ID parsers reject Junior reference strings; reference parsing stays
// explicit for persisted `slack:<channel>` and `slack:<channel>:<ts>` values.
const slackChannelIdSchema = z
  .string()
  .regex(/^[CDG][A-Z0-9]+$/)
  .brand<"SlackChannelId">();

const slackTeamIdSchema = z
  .string()
  .regex(/^T[A-Z0-9]+$/)
  .brand<"SlackTeamId">();

const slackUserIdSchema = z
  .string()
  .regex(/^[UW][A-Z0-9]+$/)
  .brand<"SlackUserId">();

export type SlackChannelId = z.output<typeof slackChannelIdSchema>;
export type SlackTeamId = z.output<typeof slackTeamIdSchema>;
export type SlackUserId = z.output<typeof slackUserIdSchema>;

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

/** Parse a Slack channel ID from native IDs or Junior Slack reference strings. */
export function parseSlackChannelReferenceId(
  value: unknown,
): SlackChannelId | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = slackChannelIdSchema.safeParse(
    slackChannelReferenceCandidate(value),
  );
  return parsed.success ? parsed.data : undefined;
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
