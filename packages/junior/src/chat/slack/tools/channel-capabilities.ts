import {
  isConversationChannel,
  isConversationScopedChannel,
} from "@/chat/slack/client";
import type { ToolChannelCapabilities } from "@/chat/tools/types";

/** Resolve channel capabilities from a Slack channel ID. */
export function resolveChannelCapabilities(
  channelId: string | undefined,
): ToolChannelCapabilities {
  return {
    canCreateCanvas: isConversationScopedChannel(channelId),
    canPostToChannel: isConversationChannel(channelId),
    canAddReactions: isConversationScopedChannel(channelId),
  };
}
