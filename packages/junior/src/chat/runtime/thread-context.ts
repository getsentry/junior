import type { Message, Thread } from "chat";
import { botConfig } from "@/chat/config";
import { toOptionalString } from "@/chat/coerce";
import {
  getHeaderString,
  isDmChannel,
  normalizeSlackConversationId,
} from "@/chat/slack/client";
import {
  parseSlackThreadId,
  resolveSlackChannelIdFromThreadId,
  resolveSlackChannelIdFromMessage,
} from "@/chat/slack/context";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function stripLeadingBotMention(
  text: string,
  options: {
    stripLeadingSlackMentionToken?: boolean;
  } = {},
): string {
  if (!text.trim()) return text;

  let next = text;
  if (options.stripLeadingSlackMentionToken) {
    next = next.replace(/^\s*<@[^>]+>[\s,:-]*/, "").trim();
  }

  const mentionByNameRe = new RegExp(
    `^\\s*@${escapeRegExp(botConfig.userName)}\\b[\\s,:-]*`,
    "i",
  );
  next = next.replace(mentionByNameRe, "").trim();

  const mentionByLabeledEntityRe = new RegExp(
    `^\\s*<@[^>|]+\\|${escapeRegExp(botConfig.userName)}>[\\s,:-]*`,
    "i",
  );
  next = next.replace(mentionByLabeledEntityRe, "").trim();

  return next;
}

export function getThreadId(
  thread: Thread,
  _message: Message,
): string | undefined {
  return toOptionalString(thread.id);
}

export function getRunId(thread: Thread, message: Message): string | undefined {
  return (
    toOptionalString((thread as unknown as { runId?: unknown }).runId) ??
    toOptionalString((message as unknown as { runId?: unknown }).runId)
  );
}

export function getChannelId(
  thread: Thread,
  message: Message,
): string | undefined {
  return (
    resolveSlackChannelIdFromThreadId(toOptionalString(thread.id)) ??
    normalizeSlackConversationId(toOptionalString(thread.channelId)) ??
    resolveSlackChannelIdFromMessage(message)
  );
}

export function getThreadTs(threadId: string | undefined): string | undefined {
  return parseSlackThreadId(threadId)?.threadTs;
}

/**
 * Resolve Slack assistant-thread API context for the current turn.
 *
 * Slack assistant-thread methods must use the live inbound thread context
 * Slack provided on the current message. Slack's assistant utilities build
 * `setStatus`/`setTitle` from `message.channel` plus `message.thread_ts ?? message.ts`
 * for non-DM message events, while `message.im` still requires an explicit
 * `thread_ts`. Do not synthesize assistant-thread roots from persisted state.
 */
export function getAssistantThreadContext(
  message: Message,
): { channelId: string; threadTs: string } | undefined {
  const raw = (message as unknown as { raw?: unknown }).raw;
  const rawRecord =
    raw && typeof raw === "object"
      ? (raw as Record<string, unknown>)
      : undefined;
  const channelId = toOptionalString(rawRecord?.channel);
  if (channelId) {
    const rawThreadTs = toOptionalString(rawRecord?.thread_ts);
    const threadTs = isDmChannel(channelId)
      ? rawThreadTs
      : (rawThreadTs ?? toOptionalString(rawRecord?.ts));
    if (threadTs) {
      return { channelId, threadTs };
    }
  }

  const parsedThreadId = parseSlackThreadId(
    toOptionalString((message as unknown as { threadId?: unknown }).threadId),
  );
  if (!parsedThreadId || isDmChannel(parsedThreadId.channelId)) {
    return undefined;
  }

  return parsedThreadId;
}

export function getMessageTs(message: Message): string | undefined {
  const directTs = toOptionalString(
    (message as unknown as { ts?: unknown }).ts,
  );
  if (directTs) {
    return directTs;
  }

  const raw = (message as unknown as { raw?: unknown }).raw;
  if (!raw || typeof raw !== "object") {
    return undefined;
  }

  const rawRecord = raw as Record<string, unknown>;
  return (
    toOptionalString(rawRecord.ts) ??
    toOptionalString(rawRecord.event_ts) ??
    toOptionalString((rawRecord.message as { ts?: unknown } | undefined)?.ts)
  );
}

export function getSlackApiErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const candidate = error as {
    code?: unknown;
    data?: { error?: unknown };
  };

  if (
    typeof candidate.data?.error === "string" &&
    candidate.data.error.trim().length > 0
  ) {
    return candidate.data.error;
  }
  if (typeof candidate.code === "string" && candidate.code.trim().length > 0) {
    return candidate.code;
  }

  return undefined;
}

export function getSlackErrorObservabilityAttributes(
  error: unknown,
): Record<string, string | number> {
  if (!error || typeof error !== "object") {
    return {};
  }

  const candidate = error as {
    code?: unknown;
    data?: { error?: unknown };
    headers?: unknown;
    statusCode?: unknown;
  };

  const attributes: Record<string, string | number> = {};
  if (typeof candidate.code === "string" && candidate.code.trim().length > 0) {
    attributes["app.slack.error_code"] = candidate.code;
  }
  if (
    typeof candidate.data?.error === "string" &&
    candidate.data.error.trim().length > 0
  ) {
    attributes["app.slack.api_error"] = candidate.data.error;
  }
  const requestId = getHeaderString(candidate.headers, "x-slack-req-id");
  if (requestId) {
    attributes["app.slack.request_id"] = requestId;
  }
  if (
    typeof candidate.statusCode === "number" &&
    Number.isFinite(candidate.statusCode)
  ) {
    attributes["http.response.status_code"] = candidate.statusCode;
  }

  return attributes;
}

export function isSlackTitlePermissionError(error: unknown): boolean {
  const code = getSlackApiErrorCode(error);
  return (
    code === "no_permission" ||
    code === "missing_scope" ||
    code === "not_allowed_token_type"
  );
}
