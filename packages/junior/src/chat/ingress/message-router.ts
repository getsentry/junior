import type { ThreadMessageKind } from "@/chat/queue/thread-message-dispatcher";

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

  const channelId = nonEmptyString(raw.channel);
  const threadTs = nonEmptyString(raw.thread_ts) ?? nonEmptyString(raw.ts);
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

function isSlackDirectMessageThreadId(threadId: string): boolean {
  const parts = threadId.split(":");
  return (
    parts.length === 3 && parts[0] === "slack" && parts[1]?.startsWith("D")
  );
}

/** Classify an incoming message as a mention or subscribed message. */
export function determineThreadMessageKind(args: {
  isDirectMessage: boolean;
  isMention: boolean;
  isSubscribed: boolean;
}): ThreadMessageKind | undefined {
  if (args.isDirectMessage) {
    return "new_mention";
  }

  if (args.isSubscribed) {
    return "subscribed_message";
  }

  if (args.isMention) {
    return "new_mention";
  }

  return undefined;
}
