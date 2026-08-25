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

/** Return true when a Slack reaction tool invocation keeps the processing reaction. */
export function shouldKeepProcessingReactionForToolInvocation(
  input: TurnToolInvocation,
): boolean {
  return (
    input.toolName === "addReaction" &&
    isProcessingReactionEmoji(input.params.emoji)
  );
}

/** Start Junior's automatic Slack processing reaction for one inbound message. */
export async function startProcessingReaction(args: {
  logException: (
    error: unknown,
    eventName: string,
    attributes?: Record<string, unknown>,
  ) => string | undefined;
  message: Message;
  thread: Thread;
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
    logException: args.logException,
  });
}

/** Start Junior's automatic Slack processing reaction for a known Slack message. */
export async function startProcessingReactionForMessage(args: {
  channelId: string;
  timestamp: SlackMessageTs;
  logException: (
    error: unknown,
    eventName: string,
    attributes?: Record<string, unknown>,
  ) => string | undefined;
}): Promise<ProcessingReaction> {
  try {
    await addReactionToMessage({
      channelId: args.channelId,
      timestamp: args.timestamp,
      emoji: getChatConfig().slack.processingReactionEmoji,
    });
  } catch (error) {
    args.logException(error, "slack.processing.reaction_add.failed", {
      "app.slack.action": "reactions.add",
      "messaging.message.id": args.timestamp,
      ...getSlackErrorObservabilityAttributes(error),
    });
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
      args.logException(error, "slack.processing.reaction_remove.failed", {
        "app.slack.action": "reactions.remove",
        "messaging.message.id": args.timestamp,
        ...getSlackErrorObservabilityAttributes(error),
      });
      return false;
    }
  };

  return {
    complete: async () => {
      // Always attempt both sides of the completion lifecycle independently.
      // Reaction-only Turns still need `:done` even if removing the processing
      // reaction fails, and a prior keep() must not block the completed emoji.
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
        args.logException(error, "slack.processing.reaction_complete.failed", {
          "app.slack.action": "reactions.add",
          "messaging.message.id": args.timestamp,
          ...getSlackErrorObservabilityAttributes(error),
        });
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
