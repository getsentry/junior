import type { Message, Thread } from "chat";
import { getSlackErrorObservabilityAttributes } from "@/chat/slack/errors";
import { normalizeSlackEmojiName } from "@/chat/slack/emoji";
import {
  addReactionToMessage,
  removeReactionFromMessage,
} from "@/chat/slack/outbound";
import { getChannelId, getMessageTs } from "@/chat/runtime/thread-context";
import type { TurnToolInvocation } from "@/chat/runtime/turn-input";
import { getChatConfig } from "@/chat/config";
import type { SlackMessageTs } from "@/chat/slack/timestamp";
import { logException, logWarn } from "@/chat/logging";
import { isSlackRequestTimeout, SlackActionError } from "@/chat/slack/client";

/** Controls the automatic Slack processing reaction lifecycle for one message. */
export interface ProcessingReaction {
  complete: () => Promise<void>;
  keep: () => void;
  stop: () => Promise<void>;
}

const noProcessingReaction: ProcessingReaction = {
  complete: async () => undefined,
  keep: () => undefined,
  stop: async () => undefined,
};

function isProcessingReactionEmoji(value: unknown): boolean {
  return (
    typeof value === "string" &&
    normalizeSlackEmojiName(value) ===
      getChatConfig().slack.processingReactionEmoji
  );
}

// The processing reaction is best-effort UI. A deleted message or the
// deliberately short ingress deadline is not actionable, so log a warning;
// capture every other Slack failure.
function logProcessingReactionFailure(
  error: unknown,
  eventName: string,
  attributes: Record<string, string>,
): void {
  const logAttributes = {
    ...attributes,
    ...getSlackErrorObservabilityAttributes(error),
  };
  if (
    (error instanceof SlackActionError &&
      error.apiError === "message_not_found") ||
    isSlackRequestTimeout(error)
  ) {
    logWarn(eventName, logAttributes);
    return;
  }
  logException(error, eventName, logAttributes);
}

/** Return true when a Slack reaction tool invocation keeps the processing reaction. */
export function shouldKeepProcessingReactionForToolInvocation(
  input: TurnToolInvocation,
): boolean {
  return (
    input.toolName === "addReaction" &&
    isProcessingReactionEmoji(input.params["emoji"])
  );
}

/** Start Junior's automatic Slack processing reaction for one inbound message. */
export async function startProcessingReaction(args: {
  message: Message;
  thread: Thread;
  timeoutMs?: number;
}): Promise<ProcessingReaction> {
  if (args.message.author.isMe) {
    return noProcessingReaction;
  }

  const channelId = getChannelId(args.thread, args.message);
  const messageTs = getMessageTs(args.message);
  if (!channelId || !messageTs) {
    return noProcessingReaction;
  }

  return startProcessingReactionForMessage({
    channelId,
    timestamp: messageTs,
    timeoutMs: args.timeoutMs,
  });
}

/** Start Junior's automatic Slack processing reaction for a known Slack message. */
export async function startProcessingReactionForMessage(args: {
  channelId: string;
  timestamp: SlackMessageTs;
  timeoutMs?: number | undefined;
}): Promise<ProcessingReaction> {
  try {
    await addReactionToMessage({
      channelId: args.channelId,
      timestamp: args.timestamp,
      emoji: getChatConfig().slack.processingReactionEmoji,
      timeoutMs: args.timeoutMs,
    });
  } catch (error) {
    logProcessingReactionFailure(
      error,
      "slack.processing.reaction_add.failed",
      {
        "app.slack.action": "reactions.add",
        "messaging.message.id": args.timestamp,
      },
    );
    return noProcessingReaction;
  }

  let shouldRemove = true;
  const removeProcessingReaction = async (): Promise<boolean> => {
    if (!shouldRemove) {
      return false;
    }

    try {
      await removeReactionFromMessage({
        channelId: args.channelId,
        timestamp: args.timestamp,
        emoji: getChatConfig().slack.processingReactionEmoji,
      });
      return true;
    } catch (error) {
      logProcessingReactionFailure(
        error,
        "slack.processing.reaction_remove.failed",
        {
          "app.slack.action": "reactions.remove",
          "messaging.message.id": args.timestamp,
        },
      );
      return false;
    }
  };

  return {
    complete: async () => {
      // Always attempt both sides of the completion lifecycle independently.
      // Reaction-only Turns still need `:done` even if removing the processing
      // reaction fails. After keep(), the processing reaction is the result
      // that the person asked for, so the Turn adds no completed emoji.
      const shouldAddCompleted = shouldRemove;
      await removeProcessingReaction();

      if (!shouldAddCompleted) {
        return;
      }

      try {
        await addReactionToMessage({
          channelId: args.channelId,
          timestamp: args.timestamp,
          emoji: getChatConfig().slack.completedReactionEmoji,
        });
      } catch (error) {
        logProcessingReactionFailure(
          error,
          "slack.processing.reaction_complete.failed",
          {
            "app.slack.action": "reactions.add",
            "messaging.message.id": args.timestamp,
          },
        );
      }
    },
    keep: () => {
      shouldRemove = false;
    },
    stop: async () => {
      await removeProcessingReaction();
    },
  };
}
