import { getConversationStore } from "@/chat/db";
import {
  getConversationInfo,
  joinPublicChannel,
} from "@/chat/slack/channel";
import { SlackActionError } from "@/chat/slack/client";
import type { SlackChannelId, SlackTeamId } from "@/chat/slack/ids";

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

const DENIED_PRIVATE =
  "Cannot read this Slack conversation because it is private. Only the current conversation or public channels are readable.";
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
 * persisted visibility in the same workspace. Cross-channel reads require live
 * `conversations.info` proof that the destination is public. Stale persisted
 * public rows are not enough, so a channel that later becomes private fails
 * closed. Channel-id prefixes alone cannot prove a channel public.
 */
export async function checkSlackChannelReadAccess(args: {
  currentChannelIds: Array<SlackChannelId | undefined>;
  targetChannelId: SlackChannelId;
  teamId: SlackTeamId;
}): Promise<SlackChannelReadAccess> {
  const currentChannels = args.currentChannelIds.filter(
    (channelId): channelId is SlackChannelId => Boolean(channelId),
  );
  if (currentChannels.includes(args.targetChannelId)) {
    return { allowed: true, isMember: true };
  }

  const visibility = await getConversationStore().getDestinationVisibility({
    provider: "slack",
    providerTenantId: args.teamId,
    providerDestinationId: args.targetChannelId,
  });
  if (visibility === "private") {
    return deny("private", DENIED_PRIVATE);
  }

  // Live Slack metadata is the only proof a non-current channel is public.
  // Persisted public visibility may be stale after a channel is converted.
  try {
    const info = await getConversationInfo(args.targetChannelId);
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
  targetChannelId: SlackChannelId;
}): Promise<
  | { ok: true; channelName?: string }
  | { ok: false; error: string; reason: SlackChannelReadDenialReason }
> {
  try {
    await joinPublicChannel(args.targetChannelId);
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
          "Could not join this public Slack channel. Ask an admin to add the bot, then retry.",
      };
    }
    throw error;
  }
}
