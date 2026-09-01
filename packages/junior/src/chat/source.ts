import { sourceSchema, type Source } from "@sentry/junior-plugin-api";

// TODO(dcramer): Delete SessionSource and this module after resume and SQL
// Location reads no longer use Conversation.sessionSource.
/** Legacy provider Source fields stored on a Conversation. */
export type SessionSource =
  | Extract<Source, { kind: "web" }>
  | Extract<Source, { kind: "local" }>
  | Omit<Extract<Source, { kind: "slack" }>, "messageTs">;

/**
 * Normalize a Turn Source into legacy provider fields stored on a Conversation.
 * System Sources do not contain a Conversation Location.
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
  if (
    value.kind === "resource_event" ||
    value.kind === "scheduled_task" ||
    value.kind === "event_task" ||
    value.kind === "plugin_dispatch" ||
    value.kind === "agent_invocation"
  ) {
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

/** Parse a serialized Source into legacy provider fields stored on a Conversation. */
export function parseSessionSource(value: unknown): SessionSource | undefined {
  const parsed = sourceSchema.safeParse(value);
  return parsed.success ? normalizeSessionSource(parsed.data) : undefined;
}
