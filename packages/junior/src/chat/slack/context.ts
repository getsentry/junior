function toOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Extract channelId and threadTs from a `slack:<channel>:<ts>` thread identifier. */
export function parseSlackThreadId(
  threadId: string | undefined,
): { channelId: string; threadTs: string } | undefined {
  const normalizedThreadId = toOptionalString(threadId);
  if (!normalizedThreadId) {
    return undefined;
  }

  const parts = normalizedThreadId.split(":");
  if (parts.length !== 3 || parts[0] !== "slack") {
    return undefined;
  }

  const channelId = toOptionalString(parts[1]);
  const threadTs = toOptionalString(parts[2]);
  if (!channelId || !threadTs) {
    return undefined;
  }

  return { channelId, threadTs };
}

/** Resolve the Slack channel ID from a `slack:<channel>:<ts>` thread identifier. */
export function resolveSlackChannelIdFromThreadId(
  threadId: string | undefined,
): string | undefined {
  return parseSlackThreadId(threadId)?.channelId;
}

/** Best-effort channel ID extraction from a raw Slack message payload. */
export function resolveSlackChannelIdFromMessage(
  message: unknown,
): string | undefined {
  const messageChannelId = toOptionalString(
    (message as { channelId?: unknown }).channelId,
  );
  if (messageChannelId) {
    return messageChannelId;
  }

  const raw = (message as { raw?: unknown }).raw;
  if (raw && typeof raw === "object") {
    const rawChannel = toOptionalString((raw as { channel?: unknown }).channel);
    if (rawChannel) {
      return rawChannel;
    }
  }

  const threadId = toOptionalString(
    (message as { threadId?: unknown }).threadId,
  );
  return resolveSlackChannelIdFromThreadId(threadId);
}
