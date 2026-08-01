import { sourceSchema, type Source } from "@sentry/junior-plugin-api";

/** Source coordinates reduced to the stable locator for one conversation. */
export type SessionSource =
  | Extract<Source, { platform: "local" }>
  | (Omit<Extract<Source, { platform: "slack" }>, "messageTs" | "threadTs"> & {
      threadTs: string;
    });

/**
 * Normalize a turn Source into the session-stable locator persisted on a
 * conversation. Drops per-message timestamps; requires a Slack thread anchor.
 */
export function normalizeSessionSource(
  value: Source | undefined,
): SessionSource | undefined {
  if (!value) {
    return undefined;
  }
  if (value.platform === "local") {
    return {
      platform: "local",
      visibility: "private",
      conversationId: value.conversationId,
    };
  }
  const threadTs = value.threadTs?.trim();
  if (!threadTs) {
    return undefined;
  }
  return {
    platform: "slack",
    visibility: value.visibility,
    teamId: value.teamId,
    channelId: value.channelId,
    threadTs,
  };
}

/** Parse a serialized Source into the stable locator stored on a conversation. */
export function parseSessionSource(value: unknown): SessionSource | undefined {
  const parsed = sourceSchema.safeParse(value);
  return parsed.success ? normalizeSessionSource(parsed.data) : undefined;
}
