import { z } from "zod";
import { toOptionalString } from "@/chat/coerce";
import {
  parseSlackChannelId,
  parseSlackTeamId,
  type SlackChannelId,
  type SlackTeamId,
} from "@/chat/slack/ids";
import {
  parseSlackMessageTs,
  type SlackMessageTs,
} from "@/chat/slack/timestamp";

function toTrimmedSlackString(value: unknown): string | undefined {
  const normalized = toOptionalString(value);
  return normalized?.trim() || undefined;
}

const slackMessageEnvelopeSchema = z.object({
  raw: z.unknown().optional(),
});

const rawSlackMessageSchema = z.object({
  channel: z.unknown().optional(),
  message: z.unknown().optional(),
  team: z.unknown().optional(),
  team_id: z.unknown().optional(),
  thread_ts: z.unknown().optional(),
  ts: z.unknown().optional(),
  user_team: z.unknown().optional(),
});

const nestedRawSlackMessageSchema = z.object({
  ts: z.unknown().optional(),
});

export interface SlackRawMessageContext {
  authorTeamId?: SlackTeamId;
  channelId?: SlackChannelId;
  messageTs?: SlackMessageTs;
  nestedMessageTs?: SlackMessageTs;
  teamId?: SlackTeamId;
  threadTs?: SlackMessageTs;
}

/** Project only the Slack raw fields consumed by runtime thread context. */
export function readSlackRawMessageContext(
  message: unknown,
): SlackRawMessageContext | undefined {
  const envelope = slackMessageEnvelopeSchema.safeParse(message);
  if (!envelope.success) {
    return undefined;
  }
  const raw = rawSlackMessageSchema.safeParse(envelope.data.raw);
  if (!raw.success) {
    return undefined;
  }
  const nestedMessage = nestedRawSlackMessageSchema.safeParse(raw.data.message);
  const channelId = parseSlackChannelId(raw.data.channel);
  const threadTs = parseSlackMessageTs(raw.data.thread_ts);
  const messageTs = parseSlackMessageTs(raw.data.ts);
  const nestedMessageTs =
    nestedMessage.success && parseSlackMessageTs(nestedMessage.data.ts);
  const teamId =
    parseSlackTeamId(raw.data.team_id) ?? parseSlackTeamId(raw.data.team);
  const authorTeamId = parseSlackTeamId(raw.data.user_team);

  return {
    ...(channelId ? { channelId } : {}),
    ...(threadTs ? { threadTs } : {}),
    ...(messageTs ? { messageTs } : {}),
    ...(nestedMessageTs ? { nestedMessageTs } : {}),
    ...(teamId ? { teamId } : {}),
    ...(authorTeamId ? { authorTeamId } : {}),
  };
}

/** Extract a channel ID and validated Slack timestamp from `slack:<channel>:<ts>`. */
export function parseSlackThreadId(
  threadId: string | undefined,
): { channelId: SlackChannelId; threadTs: SlackMessageTs } | undefined {
  const normalizedThreadId = toTrimmedSlackString(threadId);
  if (!normalizedThreadId) {
    return undefined;
  }

  const parts = normalizedThreadId.split(":");
  if (parts.length !== 3 || parts[0] !== "slack") {
    return undefined;
  }

  const channelId = parseSlackChannelId(parts[1]);
  const threadTs = parseSlackMessageTs(parts[2]);
  if (!channelId || !threadTs) {
    return undefined;
  }

  return { channelId, threadTs };
}

/** Resolve the Slack channel ID from a `slack:<channel>:<ts>` thread identifier. */
export function resolveSlackChannelIdFromThreadId(
  threadId: string | undefined,
): SlackChannelId | undefined {
  return parseSlackThreadId(threadId)?.channelId;
}

/** Best-effort channel ID extraction from a raw Slack message payload. */
export function resolveSlackChannelIdFromMessage(
  message: unknown,
): SlackChannelId | undefined {
  const messageChannelId = parseSlackChannelId(
    (message as { channelId?: unknown }).channelId,
  );
  if (messageChannelId) {
    return messageChannelId;
  }

  const raw = (message as { raw?: unknown }).raw;
  if (raw && typeof raw === "object") {
    const rawChannel = parseSlackChannelId(
      (raw as { channel?: unknown }).channel,
    );
    if (rawChannel) {
      return rawChannel;
    }
  }

  const threadId = toTrimmedSlackString(
    (message as { threadId?: unknown }).threadId,
  );
  return resolveSlackChannelIdFromThreadId(threadId);
}
