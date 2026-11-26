import { Message } from "chat";

/** Rebuild a Message onto a normalized Slack thread id. */
export function withNormalizedThreadId(
  message: Message,
  threadId: string,
): Message {
  if (message.threadId === threadId) {
    return message;
  }
  return new Message({
    attachments: message.attachments,
    author: message.author,
    formatted: message.formatted,
    id: message.id,
    isMention: message.isMention,
    links: message.links,
    metadata: message.metadata,
    raw: message.raw,
    text: message.text,
    threadId,
  });
}

/** Derive canonical Slack thread IDs from the raw event payload. */
export function normalizeIncomingSlackThreadId(
  threadId: string,
  message: unknown,
): string {
  if (!threadId.startsWith("slack:")) {
    return threadId;
  }

  if (!message || typeof message !== "object") {
    return threadId;
  }

  const raw = (message as { raw?: Record<string, unknown> }).raw;
  if (!raw || typeof raw !== "object") {
    return threadId;
  }

  const channelId = nonEmptyString(raw["channel"]);
  const threadTs =
    nonEmptyString(raw["thread_ts"]) ?? nonEmptyString(raw["ts"]);
  if (!channelId || !threadTs) {
    return threadId;
  }

  return `slack:${channelId}:${threadTs}`;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}
