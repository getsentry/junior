import {
  isConversationChannel,
  isConversationScopedChannel,
} from "@/chat/slack/client";

/** Declared capabilities of the current channel context. */
export interface ChannelCapabilities {
  /** Can create canvases in this channel (C/G/D channels). */
  canCreateCanvas: boolean;
  /** Can send messages into this conversation scope (C/G/D channels). */
  canSendMessage: boolean;
  /** Can post standalone messages to this channel (C/G channels only). */
  canPostToChannel: boolean;
  /** Can add reactions to messages (C/G/D channels). */
  canAddReactions: boolean;
}

/** Resolve channel capabilities from a Slack channel ID. */
export function resolveChannelCapabilities(
  channelId: string | undefined,
): ChannelCapabilities {
  return {
    canCreateCanvas: isConversationScopedChannel(channelId),
    canSendMessage: isConversationScopedChannel(channelId),
    canPostToChannel: isConversationChannel(channelId),
    canAddReactions: isConversationScopedChannel(channelId),
  };
}
