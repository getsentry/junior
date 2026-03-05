import type { Message, Thread } from "chat";
import { botConfig } from "@/chat/config";
import { toOptionalString } from "@/chat/observability";
import { parseSlackThreadId, resolveSlackChannelIdFromMessage } from "@/chat/slack-context";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function stripLeadingBotMention(
  text: string,
  options: {
    stripLeadingSlackMentionToken?: boolean;
  } = {}
): string {
  if (!text.trim()) return text;

  let next = text;
  if (options.stripLeadingSlackMentionToken) {
    next = next.replace(/^\s*<@[^>]+>[\s,:-]*/, "").trim();
  }

  const mentionByNameRe = new RegExp(`^\\s*@${escapeRegExp(botConfig.userName)}\\b[\\s,:-]*`, "i");
  next = next.replace(mentionByNameRe, "").trim();

  const mentionByLabeledEntityRe = new RegExp(
    `^\\s*<@[^>|]+\\|${escapeRegExp(botConfig.userName)}>[\\s,:-]*`,
    "i"
  );
  next = next.replace(mentionByLabeledEntityRe, "").trim();

  return next;
}

export function getThreadId(thread: Thread, _message: Message): string | undefined {
  return toOptionalString(thread.id);
}

export function getRunId(thread: Thread, message: Message): string | undefined {
  return (
    toOptionalString((thread as unknown as { runId?: unknown }).runId) ??
    toOptionalString((message as unknown as { runId?: unknown }).runId)
  );
}

export function getChannelId(thread: Thread, message: Message): string | undefined {
  return thread.channelId ?? resolveSlackChannelIdFromMessage(message);
}

export function getThreadTs(threadId: string | undefined): string | undefined {
  return parseSlackThreadId(threadId)?.threadTs;
}

export function getMessageTs(message: Message): string | undefined {
  const directTs = toOptionalString((message as unknown as { ts?: unknown }).ts);
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

  if (typeof candidate.data?.error === "string" && candidate.data.error.trim().length > 0) {
    return candidate.data.error;
  }
  if (typeof candidate.code === "string" && candidate.code.trim().length > 0) {
    return candidate.code;
  }

  return undefined;
}

export function isSlackTitlePermissionError(error: unknown): boolean {
  const code = getSlackApiErrorCode(error);
  return code === "no_permission" || code === "missing_scope" || code === "not_allowed_token_type";
}
