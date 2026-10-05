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
   * Channel topic. Any channel member can edit it, so it is untrusted text.
   * The prompt renders it only as a hint.
   */
  topic?: string;
  /**
   * Channel purpose, which Slack shows as the description. Any channel member
   * can edit it, so it is untrusted text. The prompt renders it only as a hint.
   */
  purpose?: string;
  /** Visibility proven by source or persisted metadata. */
  visibility?: SlackConversationVisibility;
}

/**
 * Slack limits a topic or purpose to 250 characters. Junior applies the same
 * limit, so a changed Slack limit cannot grow the prompt.
 */
const CHANNEL_HINT_MAX_LENGTH = 250;

function normalizeChannelHint(value: string | undefined): string | undefined {
  const collapsed = value?.replace(/\s+/g, " ").trim();
  if (!collapsed) return undefined;
  const chars = Array.from(collapsed);
  return chars.length > CHANNEL_HINT_MAX_LENGTH
    ? `${chars.slice(0, CHANNEL_HINT_MAX_LENGTH - 1).join("")}…`
    : collapsed;
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
 * Slack's event metadata and live conversation metadata are the only
 * visibility authorities; channel IDs never classify visibility.
 */
export function conversationVisibilityFromSlackChannelType(
  channelType: SlackEventChannelType | undefined,
): SlackConversationVisibility | undefined {
  if (!channelType) return undefined;
  return channelType === "channel" ? "public" : "private";
}

/**
 * Map live `conversations.info` metadata to Slack's Events API channel type,
 * for events that carry no `channel_type`.
 */
export function slackChannelTypeFromConversationInfo(info: {
  isChannel: boolean;
  isIm: boolean;
  isMpim: boolean;
  isPrivate: boolean;
}): SlackEventChannelType | undefined {
  if (info.isIm) return "im";
  if (info.isMpim) return "mpim";
  if (info.isPrivate) return "group";
  return info.isChannel ? "channel" : undefined;
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
  channelPurpose?: string;
  channelTopic?: string;
  channelType?: SlackEventChannelType;
}): SlackConversationContext | undefined {
  const type =
    typeFromSlackChannelType(input.channelType) ??
    typeFromChannelId(input.channelId, input.channelName);
  if (!type) return undefined;

  const name = normalizeConversationName(type, input.channelName);
  const topic = normalizeChannelHint(input.channelTopic);
  const purpose = normalizeChannelHint(input.channelPurpose);
  const visibility = conversationVisibilityFromSlackChannelType(
    input.channelType,
  );

  return {
    type,
    ...(name ? { name } : undefined),
    ...(topic ? { topic } : undefined),
    ...(purpose ? { purpose } : undefined),
    ...(visibility ? { visibility } : undefined),
  };
}

/** Build Slack conversation facts from Junior's persisted Slack thread id. */
export function resolveSlackConversationContextFromThreadId(input: {
  threadId?: string;
  channelName?: string;
  visibility?: SlackConversationVisibility;
}): SlackConversationContext | undefined {
  const slackThread = parseSlackThreadId(input.threadId);
  const context = resolveSlackConversationContext({
    channelId: slackThread?.channelId,
    channelName: input.channelName,
  });
  if (!context || !input.visibility) {
    return context;
  }
  return {
    ...context,
    type:
      input.visibility === "private" && context.type === "public_channel"
        ? "private_channel"
        : context.type,
    visibility: input.visibility,
  };
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
