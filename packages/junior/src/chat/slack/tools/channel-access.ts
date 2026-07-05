import type { ConversationPrivacy } from "@/chat/conversation-privacy";
import { getConversationStore } from "@/chat/db";
import type { SlackChannelId, SlackTeamId } from "@/chat/slack/ids";

/** Minimal persisted-visibility port for cross-conversation read gates. */
export interface DestinationVisibilityReader {
  getDestinationVisibility(args: {
    provider: string;
    providerDestinationId: string;
    providerTenantId?: string;
  }): Promise<ConversationPrivacy | undefined>;
}

export type SlackChannelReadAccess =
  | { allowed: true }
  | { allowed: false; error: string };

/**
 * Decide whether the model may read Slack content from a target channel.
 *
 * The current conversation is always readable. Any other channel requires
 * persisted `public` visibility in the same workspace: channel-id prefixes
 * cannot prove a channel public (modern Slack private channels also use `C`
 * ids), so missing or private destinations fail closed.
 */
export async function checkSlackChannelReadAccess(args: {
  currentChannelIds: Array<SlackChannelId | undefined>;
  store?: DestinationVisibilityReader;
  targetChannelId: SlackChannelId;
  teamId: SlackTeamId;
}): Promise<SlackChannelReadAccess> {
  const currentChannels = args.currentChannelIds.filter(
    (channelId): channelId is SlackChannelId => Boolean(channelId),
  );
  if (currentChannels.includes(args.targetChannelId)) {
    return { allowed: true };
  }

  const store = args.store ?? getConversationStore();
  const visibility = await store.getDestinationVisibility({
    provider: "slack",
    providerTenantId: args.teamId,
    providerDestinationId: args.targetChannelId,
  });
  if (visibility === "public") {
    return { allowed: true };
  }

  return {
    allowed: false,
    error:
      "Cannot read this Slack conversation: only the current conversation or public channels Junior has seen in this workspace are readable.",
  };
}
