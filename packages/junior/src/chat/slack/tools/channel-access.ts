import type { ConversationPrivacy } from "@/chat/conversation-privacy";
import { getConversationStore } from "@/chat/db";
import {
  getConversationInfo,
  joinPublicChannel,
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
  | {
      allowed: true;
      channelName?: string;
      isMember?: boolean;
      isPublic?: boolean;
    }
  | { allowed: false; error: string; reason: SlackChannelReadDenialReason };

export type SlackChannelReadDenialReason =
  | "private"
  | "not_found"
  | "not_in_channel"
  | "missing_scope"
  | "unknown";

export interface SlackConversationInfoReader {
  getConversationInfo(
    channelId: SlackChannelId,
  ): Promise<SlackConversationInfo>;
}

export interface SlackChannelJoinWriter {
  joinPublicChannel(channelId: SlackChannelId): Promise<void>;
}

const DENIED_PRIVATE =
  "Cannot read this Slack conversation because it is private. Junior only reads the current conversation or public channels.";
const DENIED_NOT_FOUND =
  "Cannot read this Slack conversation because the channel was not found or the bot cannot see it.";
const DENIED_NOT_IN_CHANNEL =
  "Cannot read this Slack conversation because the bot is not in the channel.";
const DENIED_MISSING_SCOPE =
  "Cannot verify Slack channel access because this installation is missing channel read scopes.";

function deny(
  reason: SlackChannelReadDenialReason,
  error: string,
): Extract<SlackChannelReadAccess, { allowed: false }> {
  return { allowed: false, reason, error };
}

/**
 * Decide whether the model may read Slack content from a target channel.
 *
 * The current conversation is always readable. Any other channel first checks
 * persisted visibility in the same workspace. When visibility is unknown,
 * Junior asks Slack via `conversations.info` and allows only public channels.
 * Missing or private destinations fail closed. Channel-id prefixes alone
 * cannot prove a channel public.
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
    return { allowed: true, isMember: true };
  }

  const store = args.store ?? getConversationStore();
  const visibility = await store.getDestinationVisibility({
    provider: "slack",
    providerTenantId: args.teamId,
    providerDestinationId: args.targetChannelId,
  });
  if (visibility === "private") {
    return deny("private", DENIED_PRIVATE);
  }

  const conversationInfo =
    args.conversationInfo ??
    ({
      getConversationInfo,
    } satisfies SlackConversationInfoReader);

  // Prefer live Slack metadata when available so membership and public proof
  // stay current. Fall back to persisted public visibility only when Slack
  // cannot answer.
  try {
    const info = await conversationInfo.getConversationInfo(
      args.targetChannelId,
    );
    const isPublicChannel =
      info.isChannel && !info.isPrivate && !info.isIm && !info.isMpim;
    if (!isPublicChannel) {
      return deny("private", DENIED_PRIVATE);
    }
    return {
      allowed: true,
      isPublic: true,
      ...(info.name ? { channelName: info.name } : {}),
      ...(typeof info.isMember === "boolean" ? { isMember: info.isMember } : {}),
    };
  } catch (error) {
    if (visibility === "public") {
      return { allowed: true, isPublic: true };
    }
    if (error instanceof SlackActionError) {
      if (error.code === "not_found") {
        return deny("not_found", DENIED_NOT_FOUND);
      }
      if (error.code === "not_in_channel") {
        return deny("not_in_channel", DENIED_NOT_IN_CHANNEL);
      }
      if (error.code === "missing_scope") {
        return deny("missing_scope", DENIED_MISSING_SCOPE);
      }
    }
    throw error;
  }
}

/**
 * Join one public channel when a read failed because the bot is not a member.
 *
 * Callers should try the read first, then use this helper on `not_in_channel`.
 */
export async function joinPublicChannelForRead(args: {
  channelName?: string;
  joinChannel?: SlackChannelJoinWriter;
  targetChannelId: SlackChannelId;
}): Promise<
  | { ok: true; channelName?: string }
  | { ok: false; error: string; reason: SlackChannelReadDenialReason }
> {
  const joinChannel =
    args.joinChannel ??
    ({
      joinPublicChannel,
    } satisfies SlackChannelJoinWriter);

  try {
    await joinChannel.joinPublicChannel(args.targetChannelId);
    return {
      ok: true,
      ...(args.channelName ? { channelName: args.channelName } : {}),
    };
  } catch (error) {
    if (error instanceof SlackActionError) {
      if (error.code === "missing_scope") {
        return {
          ok: false as const,
          reason: "missing_scope" as const,
          error:
            "Cannot join this public Slack channel because this installation is missing the `channels:join` scope.",
        };
      }
      if (error.code === "not_found") {
        return {
          ok: false as const,
          reason: "not_found" as const,
          error: DENIED_NOT_FOUND,
        };
      }
      if (
        error.apiError === "method_not_supported_for_channel_type" ||
        error.apiError === "is_archived" ||
        error.apiError === "cant_invite_self"
      ) {
        return {
          ok: false as const,
          reason: "private" as const,
          error: DENIED_PRIVATE,
        };
      }
      return {
        ok: false as const,
        reason: "not_in_channel" as const,
        error:
          "Could not join this public Slack channel. Ask an admin to add the bot, or invite Junior, then retry.",
      };
    }
    throw error;
  }
}
