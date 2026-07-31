import {
  sourceSchema,
  type Source,
} from "@sentry/junior-plugin-api";

/** Parse and validate a serialized Source that crossed a runtime boundary. */
export function parseSource(value: unknown): Source | undefined {
  const parsed = sourceSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Normalize a turn Source into the session-stable locator persisted on a
 * conversation. Drops per-message timestamps; requires a Slack thread anchor.
 */
export function normalizeSessionSource(
  value: Source | undefined,
): Source | undefined {
  if (!value) {
    return undefined;
  }
  if (value.platform === "local") {
    return {
      platform: "local",
      type: "priv",
      conversationId: value.conversationId,
    };
  }
  const threadTs = value.threadTs?.trim();
  if (!threadTs) {
    return undefined;
  }
  return {
    platform: "slack",
    type: value.type,
    teamId: value.teamId,
    channelId: value.channelId,
    threadTs,
  };
}
