import type { ConversationPrivacy } from "@/chat/conversation-privacy";
import { getConversationStore } from "@/chat/db";
import {
  getConversationInfo,
  type SlackConversationInfo,
} from "@/chat/slack/channel";
import { SlackActionError } from "@/chat/slack/client";
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
  | { allowed: true; channelName?: string }
  | { allowed: false; error: string };

export interface SlackConversationInfoReader {
  getConversationInfo(
    channelId: SlackChannelId,
  ): Promise<SlackConversationInfo>;
}

const DENIED_UNSEEN_PUBLIC =
  "Cannot read this Slack conversation: only the current conversation or public channels the bot can access are readable.";

/**
 * Decide whether the model may read Slack content from a target channel.
 *
 * The current conversation is always readable. Any other channel first checks
 * persisted `public` visibility in the same workspace. When visibility is
 * unknown, Junior asks Slack via `conversations.info` and allows only public
 * channels. Missing or private destinations fail closed. Channel-id prefixes
 * alone cannot prove a channel public.
 */
export async function checkSlackChannelReadAccess(args: {
  currentChannelIds: Array<SlackChannelId | undefined>;
  conversationInfo?: SlackConversationInfoReader;
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
  if (visibility === "private") {
    return {
      allowed: false,
      error: DENIED_UNSEEN_PUBLIC,
    };
  }

  const conversationInfo =
    args.conversationInfo ??
    ({
      getConversationInfo,
    } satisfies SlackConversationInfoReader);

  try {
    const info = await conversationInfo.getConversationInfo(
      args.targetChannelId,
    );
    const isPublicChannel =
      info.isChannel && !info.isPrivate && !info.isIm && !info.isMpim;
    if (isPublicChannel) {
      return {
        allowed: true,
        ...(info.name ? { channelName: info.name } : {}),
      };
    }
    return {
      allowed: false,
      error: DENIED_UNSEEN_PUBLIC,
    };
  } catch (error) {
    if (error instanceof SlackActionError) {
      if (error.code === "not_found" || error.code === "not_in_channel") {
        return {
          allowed: false,
          error: DENIED_UNSEEN_PUBLIC,
        };
      }
      if (error.code === "missing_scope") {
        return {
          allowed: false,
          error:
            "Cannot verify Slack channel access because this installation is missing channel read scopes.",
        };
      }
    }
    throw error;
  }
}
