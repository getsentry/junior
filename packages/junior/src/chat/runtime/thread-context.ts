import type { Message, Thread } from "chat";
import { botConfig } from "@/chat/config";
import { toOptionalString } from "@/chat/coerce";
import { isDmChannel, normalizeSlackConversationId } from "@/chat/slack/client";
import { getWorkspaceTeamId } from "@/chat/slack/workspace-context";
import { isSlackTeamId } from "@/chat/slack/ids";
import {
  parseSlackThreadId,
  readSlackRawMessageContext,
  resolveSlackChannelIdFromThreadId,
  resolveSlackChannelIdFromMessage,
} from "@/chat/slack/context";
import {
  parseSlackMessageTs,
  type SlackMessageTs,
} from "@/chat/slack/timestamp";

function toSlackTeamId(value: unknown): string | undefined {
  const candidate = toOptionalString(value);
  return candidate && isSlackTeamId(candidate) ? candidate : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readObjectField(value: object, key: string): unknown {
  return (value as Record<string, unknown>)[key];
}

function readOptionalStringField(
  value: object,
  key: string,
): string | undefined {
  return toOptionalString(readObjectField(value, key));
}

interface StripLeadingBotMentionOptions {
  botUserId?: string;
  stripLeadingSlackMentionToken?: boolean;
}

export function stripLeadingBotMention(
  text: string,
  options: StripLeadingBotMentionOptions = {},
): string {
  if (!text.trim()) return text;

  let next = text;
  if (options.stripLeadingSlackMentionToken) {
    if (options.botUserId) {
      const botUserId = escapeRegExp(options.botUserId);
      const mentionByBotUserIdRe = new RegExp(
        `^\\s*(?:<@${botUserId}(?:\\|[^>]+)?>|@${botUserId})[\\s,:-]*`,
        "i",
      );
      next = next.replace(mentionByBotUserIdRe, "").trim();
    } else {
      next = next.replace(/^\s*<@[^>]+>[\s,:-]*/, "").trim();
    }
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
    readOptionalStringField(thread, "runId") ??
    readOptionalStringField(message, "runId")
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
  const rawContext = readSlackRawMessageContext(message);
  const channelId = rawContext?.channelId;
  if (channelId) {
    const threadTs = isDmChannel(channelId)
      ? rawContext.threadTs
      : (rawContext.threadTs ?? rawContext.messageTs);
    if (threadTs) {
      return { channelId, threadTs };
    }
  }

  const parsedThreadId = parseSlackThreadId(
    readOptionalStringField(message, "threadId"),
  );
  if (!parsedThreadId || isDmChannel(parsedThreadId.channelId)) {
    return undefined;
  }

  return parsedThreadId;
}

/** Resolve the native Slack timestamp for a message that can target Slack APIs. */
export function getMessageTs(message: Message): SlackMessageTs | undefined {
  const directTs = readOptionalStringField(message, "ts");
  const parsedDirectTs = parseSlackMessageTs(directTs);
  if (parsedDirectTs) {
    return parsedDirectTs;
  }

  const rawContext = readSlackRawMessageContext(message);
  if (!rawContext) {
    return undefined;
  }

  const candidates = [rawContext.messageTs, rawContext.nestedMessageTs];
  for (const candidate of candidates) {
    const ts = parseSlackMessageTs(candidate);
    if (ts) {
      return ts;
    }
  }
  return undefined;
}

/** Resolve the Slack workspace/team id from the raw inbound message payload. */
export function getTeamId(message: Message): string | undefined {
  const rawContext = readSlackRawMessageContext(message);
  if (!rawContext) {
    return undefined;
  }

  return (
    toSlackTeamId(rawContext.teamId) ??
    toSlackTeamId(getWorkspaceTeamId()) ??
    toSlackTeamId(rawContext.authorTeamId)
  );
}
