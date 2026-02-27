function toOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function resolveSlackChannelIdFromThreadId(threadId: string | undefined): string | undefined {
  const normalizedThreadId = toOptionalString(threadId);
  if (!normalizedThreadId) {
    return undefined;
  }

  const parts = normalizedThreadId.split(":");
  if (parts.length !== 3 || parts[0] !== "slack") {
    return undefined;
  }

  return toOptionalString(parts[1]);
}

export function resolveSlackChannelIdFromMessage(message: unknown): string | undefined {
  const messageChannelId = toOptionalString((message as { channelId?: unknown }).channelId);
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

  const threadId = toOptionalString((message as { threadId?: unknown }).threadId);
  return resolveSlackChannelIdFromThreadId(threadId);
}
