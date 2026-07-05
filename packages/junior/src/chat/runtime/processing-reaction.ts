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
export interface ProcessingReactionSession {
  complete: () => Promise<void>;
  keep: () => void;
  stop: () => Promise<void>;
}

const noProcessingReaction: ProcessingReactionSession = {
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

/** Return true when a Slack reaction tool call should leave the processing reaction in place. */
export function shouldKeepProcessingReactionForToolInvocation(
  input: TurnToolInvocation,
): boolean {
  return (
    input.toolName === "addReaction" &&
    isProcessingReactionEmoji(input.params.emoji)
  );
}

/** Start Junior's automatic Slack processing reaction for one inbound message. */
export async function startSlackProcessingReaction(args: {
  logException: (
    error: unknown,
    eventName: string,
    context?: Record<string, unknown>,
    attributes?: Record<string, unknown>,
    body?: string,
  ) => string | undefined;
  logContext: Record<string, unknown>;
  message: Message;
  thread: Thread;
}): Promise<ProcessingReactionSession> {
  if (args.message.author.isMe) {
    return noProcessingReaction;
  }

  const channelId = getChannelId(args.thread, args.message);
  const messageTs = getMessageTs(args.message);
  if (!channelId || !messageTs) {
    return noProcessingReaction;
  }

  return startSlackProcessingReactionForMessage({
    channelId,
    timestamp: messageTs,
    logException: args.logException,
    logContext: args.logContext,
  });
}

/** Start Junior's automatic Slack processing reaction for a known Slack message. */
export async function startSlackProcessingReactionForMessage(args: {
  channelId: string;
  timestamp: SlackMessageTs;
  logException: (
    error: unknown,
    eventName: string,
    context?: Record<string, unknown>,
    attributes?: Record<string, unknown>,
    body?: string,
  ) => string | undefined;
  logContext: Record<string, unknown>;
}): Promise<ProcessingReactionSession> {
  try {
    await addReactionToMessage({
      channelId: args.channelId,
      timestamp: args.timestamp,
      emoji: getChatConfig().slack.processingReactionEmoji,
    });
  } catch (error) {
    args.logException(
      error,
      "slack_processing_reaction_add_failed",
      args.logContext,
      {
        "app.slack.action": "reactions.add",
        "messaging.message.id": args.timestamp,
        ...getSlackErrorObservabilityAttributes(error),
      },
      "Failed to add Slack processing reaction",
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
      args.logException(
        error,
        "slack_processing_reaction_remove_failed",
        args.logContext,
        {
          "app.slack.action": "reactions.remove",
          "messaging.message.id": args.timestamp,
          ...getSlackErrorObservabilityAttributes(error),
        },
        "Failed to remove Slack processing reaction",
      );
      return false;
    }
  };

  return {
    complete: async () => {
      if (!(await removeProcessingReaction())) {
        return;
      }

      try {
        await addReactionToMessage({
          channelId: args.channelId,
          timestamp: args.timestamp,
          emoji: getChatConfig().slack.completedReactionEmoji,
        });
      } catch (error) {
        args.logException(
          error,
          "slack_processing_reaction_complete_failed",
          args.logContext,
          {
            "app.slack.action": "reactions.add",
            "messaging.message.id": args.timestamp,
            ...getSlackErrorObservabilityAttributes(error),
          },
          "Failed to add Slack completed reaction",
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
