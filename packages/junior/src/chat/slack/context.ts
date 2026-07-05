import { toOptionalString } from "@/chat/coerce";
import { parseSlackChannelId, type SlackChannelId } from "@/chat/slack/ids";
import {
  parseSlackMessageTs,
  type SlackMessageTs,
} from "@/chat/slack/timestamp";

function toTrimmedSlackString(value: unknown): string | undefined {
  const normalized = toOptionalString(value);
  return normalized?.trim() || undefined;
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
