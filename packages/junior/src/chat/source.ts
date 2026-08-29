import { sourceSchema, type Source } from "@sentry/junior-plugin-api";

/** Source coordinates reduced to the stable locator for one conversation. */
export type SessionSource =
  | Extract<Source, { kind: "web" }>
  | Extract<Source, { kind: "local" }>
  | Omit<Extract<Source, { kind: "slack" }>, "messageTs">;

/**
 * Normalize a turn Source into the session-stable locator persisted on a
 * conversation. Drops per-message timestamps. Threaded Slack turns keep their
 * thread anchor; channel-level turns (scheduled/event dispatch) keep the
 * channel locator without inventing a threadTs.
 */
export function normalizeSessionSource(
  value: Source | undefined,
): SessionSource | undefined {
  if (!value) {
    return undefined;
  }
  if (value.kind === "local") {
    return {
      kind: "local",
      visibility: value.visibility,
      conversationId: value.conversationId,
    };
  }
  if (value.kind === "web") {
    return {
      kind: "web",
      visibility: value.visibility,
      conversationId: value.conversationId,
    };
  }
  if (value.kind === "resource_event") {
    return undefined;
  }
  const threadTs = value.threadTs?.trim();
  return {
    kind: "slack",
    visibility: value.visibility,
    teamId: value.teamId,
    channelId: value.channelId,
    ...(threadTs ? { threadTs } : undefined),
  };
}

/** Parse a serialized Source into the stable locator stored on a conversation. */
export function parseSessionSource(value: unknown): SessionSource | undefined {
  const parsed = sourceSchema.safeParse(value);
  return parsed.success ? normalizeSessionSource(parsed.data) : undefined;
}
