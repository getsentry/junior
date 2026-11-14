import * as z from "zod";
import type { Message } from "chat";
import {
  parseSlackChannelId,
  parseSlackTeamId,
  slackThreadId,
  type SlackChannelId,
  type SlackTeamId,
  type SlackThreadId,
} from "@/chat/slack/ids";
import {
  parseSlackMessageTs,
  type SlackMessageTs,
} from "@/chat/slack/timestamp";

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
    ...(channelId ? { channelId } : undefined),
    ...(threadTs ? { threadTs } : undefined),
    ...(messageTs ? { messageTs } : undefined),
    ...(nestedMessageTs ? { nestedMessageTs } : undefined),
    ...(teamId ? { teamId } : undefined),
    ...(authorTeamId ? { authorTeamId } : undefined),
  };
}

/**
 * Read the Slack thread of an inbound Slack message from its raw Slack event:
 * the channel and `thread_ts`, or `ts` for a thread root. Do not read
 * `Message.threadId` or `Thread.id`: a dispatched Turn sets them to its
 * Conversation id.
 */
export function slackThreadIdOfMessage(
  message: Message,
): SlackThreadId | undefined {
  const raw = readSlackRawMessageContext(message);
  const threadTs = raw?.threadTs ?? raw?.messageTs;
  return raw?.channelId && threadTs
    ? slackThreadId(raw.channelId, threadTs)
    : undefined;
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
  return undefined;
}
