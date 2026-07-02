import { normalizeSlackConversationId } from "@/chat/slack/client";
import { parseSlackThreadId } from "@/chat/slack/context";

/** Slack Events API channel_type values relevant to message surfaces. */
export type SlackEventChannelType = "channel" | "group" | "mpim" | "im";

/** Slack conversation categories Junior can share with agents. */
export type SlackConversationType =
  | "public_channel"
  | "private_channel"
  | "group_dm"
  | "direct_message"
  | "private_channel_or_group_dm";

/** Conversation visibility classification derived from source-provided signals. */
export type SlackConversationVisibility = "public" | "private";

/** Slack conversation facts available to the bot for runtime context. */
export interface SlackConversationContext {
  type: SlackConversationType;
  name?: string;
  /**
   * Visibility proven by a source signal (`channel_type`) or narrowed toward
   * private by a `D`/`G` id prefix. Undefined for `C`-prefixed conversations
   * without a signal, which may be public or private.
   */
  visibility?: SlackConversationVisibility;
}

function normalizeConversationName(
  type: SlackConversationType,
  channelName: string | undefined,
): string | undefined {
  const trimmed = channelName?.trim();
  if (!trimmed) return undefined;
  if (
    type === "public_channel" ||
    type === "private_channel" ||
    type === "private_channel_or_group_dm"
  ) {
    return trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
  }
  return trimmed;
}

function typeFromSlackChannelType(
  channelType: SlackEventChannelType | undefined,
): SlackConversationType | undefined {
  if (channelType === "channel") return "public_channel";
  if (channelType === "group") return "private_channel";
  if (channelType === "mpim") return "group_dm";
  if (channelType === "im") return "direct_message";
  return undefined;
}

function typeFromChannelId(
  channelId: string | undefined,
  channelName: string | undefined,
): SlackConversationType | undefined {
  const normalized = normalizeSlackConversationId(channelId);
  if (!normalized) return undefined;
  if (normalized.startsWith("C")) return "public_channel";
  if (normalized.startsWith("D")) return "direct_message";
  if (normalized.startsWith("G")) {
    return channelName?.trim().startsWith("mpdm-")
      ? "group_dm"
      : "private_channel_or_group_dm";
  }
  return undefined;
}

function toSlackEventChannelType(
  channelType: string | undefined,
): SlackEventChannelType | undefined {
  if (
    channelType === "channel" ||
    channelType === "group" ||
    channelType === "mpim" ||
    channelType === "im"
  ) {
    return channelType;
  }
  return undefined;
}

/**
 * Map Slack's Events API channel_type to a source-confirmed visibility.
 *
 * This is the only mapping allowed to classify a Slack conversation public;
 * channel-id prefixes may only narrow classification toward private.
 */
export function conversationVisibilityFromSlackChannelType(
  channelType: SlackEventChannelType | undefined,
): SlackConversationVisibility | undefined {
  if (!channelType) return undefined;
  return channelType === "channel" ? "public" : "private";
}

// Narrows toward private only; never asserts public.
function visibilityFromChannelIdPrefix(
  channelId: string | undefined,
): SlackConversationVisibility | undefined {
  const normalized = normalizeSlackConversationId(channelId);
  if (!normalized) return undefined;
  if (normalized.startsWith("D") || normalized.startsWith("G")) {
    return "private";
  }
  return undefined;
}

/** Resolve Slack's raw event channel type from a Chat SDK message-like object. */
export function resolveSlackChannelTypeFromMessage(
  message: unknown,
): SlackEventChannelType | undefined {
  const raw = (message as { raw?: unknown }).raw;
  if (!raw || typeof raw !== "object") {
    return undefined;
  }

  const channelType = (raw as Record<string, unknown>).channel_type;
  return typeof channelType === "string"
    ? toSlackEventChannelType(channelType.trim())
    : undefined;
}

/** Build Slack conversation facts available to runtime consumers. */
export function resolveSlackConversationContext(input: {
  channelId?: string;
  channelName?: string;
  channelType?: SlackEventChannelType;
}): SlackConversationContext | undefined {
  const type =
    typeFromSlackChannelType(input.channelType) ??
    typeFromChannelId(input.channelId, input.channelName);
  if (!type) return undefined;

  const name = normalizeConversationName(type, input.channelName);
  const visibility =
    conversationVisibilityFromSlackChannelType(input.channelType) ??
    visibilityFromChannelIdPrefix(input.channelId);

  return {
    type,
    ...(name ? { name } : {}),
    ...(visibility ? { visibility } : {}),
  };
}

/** Build Slack conversation facts from Junior's persisted Slack thread id. */
export function resolveSlackConversationContextFromThreadId(input: {
  threadId?: string;
  channelName?: string;
}): SlackConversationContext | undefined {
  const slackThread = parseSlackThreadId(input.threadId);
  return resolveSlackConversationContext({
    channelId: slackThread?.channelId,
    channelName: input.channelName,
  });
}

/** Render a human label for a privacy-preserving Slack conversation type. */
export function formatSlackConversationTypeLabel(
  type: SlackConversationType,
): string {
  if (type === "public_channel") return "Public Channel";
  if (type === "private_channel") return "Private Channel";
  if (type === "group_dm") return "Group DM";
  if (type === "direct_message") return "Direct Message";
  return "Private Channel or Group DM";
}

/** Render a Slack conversation label for surfaces allowed to expose names. */
export function formatSlackConversationContextLabel(
  context: SlackConversationContext | undefined,
): string | undefined {
  if (!context) return undefined;
  return context.name ?? formatSlackConversationTypeLabel(context.type);
}

/** Render a Slack conversation label without exposing conversation names. */
export function formatSlackConversationRedactedLabel(
  context: SlackConversationContext | undefined,
): string | undefined {
  if (!context) return undefined;
  return formatSlackConversationTypeLabel(context.type);
}
