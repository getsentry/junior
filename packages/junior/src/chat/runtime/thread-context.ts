import type { Message, Thread } from "chat";
import { botConfig } from "@/chat/config";
import { toOptionalString } from "@/chat/coerce";
import { isDmChannel, normalizeSlackConversationId } from "@/chat/slack/client";
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
