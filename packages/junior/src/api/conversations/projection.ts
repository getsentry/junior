import { resolveConversationPrivacy } from "@/chat/conversation-privacy";
import {
  formatSlackConversationRedactedLabel,
  resolveSlackConversationContextFromThreadId,
} from "@/chat/slack/conversation-context";
import { parseSlackThreadId } from "@/chat/slack/context";
import type { StoredSlackActor } from "@/chat/actor";
import type {
  Conversation as StoredConversation,
  ConversationSource,
} from "@/chat/conversations/store";
import { slackStatsLocationLabel, surfaceFallbackLabel } from "./shared";
import type {
  ActorIdentity,
  ConversationReportStatus,
  ConversationSummaryReport,
  ConversationSurface,
  ConversationUsage,
} from "./schema";
const PRIVATE_CONVERSATION_LABEL = "Private Conversation";

function privateConversationLabel(
  slackConversation: ReturnType<
    typeof resolveSlackConversationContextFromThreadId
  >,
): string {
  if (!slackConversation) {
    return PRIVATE_CONVERSATION_LABEL;
  }
  return slackConversation.visibility === "private"
    ? (formatSlackConversationRedactedLabel(slackConversation) ??
        PRIVATE_CONVERSATION_LABEL)
    : PRIVATE_CONVERSATION_LABEL;
}

function surfaceFromConversationId(
  conversationId: string,
): ConversationSurface {
  if (parseSlackThreadId(conversationId)) return "slack";
  if (conversationId.startsWith("scheduler:")) return "scheduler";
  if (conversationId.startsWith("api:")) return "api";
  return "internal";
}

function surfaceFromSource(
  source: ConversationSource | undefined,
  conversationId: string,
): ConversationSurface {
  if (source === "slack" || source === "api" || source === "scheduler") {
    return source;
  }
  return surfaceFromConversationId(conversationId);
}

function actorIdentityReport(
  actor: StoredSlackActor | undefined,
): ActorIdentity | undefined {
  if (!actor) return undefined;
  const identity: ActorIdentity = {
    ...(actor.email !== undefined ? { email: actor.email } : {}),
    ...(actor.fullName !== undefined ? { fullName: actor.fullName } : {}),
    ...(actor.slackUserId !== undefined
      ? { slackUserId: actor.slackUserId }
      : {}),
    ...(actor.slackUserName !== undefined
      ? { slackUserName: actor.slackUserName }
      : {}),
  };
  return Object.keys(identity).length > 0 ? identity : undefined;
}

function statusFromConversation(
  conversation: StoredConversation,
): ConversationReportStatus {
  if (conversation.execution.status === "idle") {
    return "completed";
  }
  if (conversation.execution.status === "failed") {
    return "failed";
  }
  return "active";
}

/** Build the privacy-safe title shared by summary and detail reports. */
export function titleFromConversation(args: {
  conversation: StoredConversation;
  surface: ConversationSurface;
}): string {
  const slackThread = parseSlackThreadId(args.conversation.conversationId);
  const effectiveChannelName = args.conversation.channelName;
  const slackConversation = resolveSlackConversationContextFromThreadId({
    threadId: args.conversation.conversationId,
    channelName: effectiveChannelName,
  });
  const privateLabel =
    resolveConversationPrivacy({
      conversationId: args.conversation.conversationId,
      visibility: args.conversation.visibility,
    }) !== "public"
      ? privateConversationLabel(slackConversation)
      : undefined;
  return (
    privateLabel ??
    args.conversation.title ??
    slackStatsLocationLabel({
      channel: slackThread?.channelId,
      channelName: effectiveChannelName,
    }) ??
    surfaceFallbackLabel(args.surface)
  );
}

function channelNameFromConversation(
  conversation: StoredConversation,
): string | undefined {
  const effectiveChannelName = conversation.channelName;
  const slackThread = parseSlackThreadId(conversation.conversationId);
  if (!effectiveChannelName && !slackThread) {
    return undefined;
  }
  const slackConversation = resolveSlackConversationContextFromThreadId({
    threadId: conversation.conversationId,
    channelName: effectiveChannelName,
  });
  if (
    resolveConversationPrivacy({
      conversationId: conversation.conversationId,
      visibility: conversation.visibility,
    }) !== "public"
  ) {
    return privateConversationLabel(slackConversation);
  }
  return effectiveChannelName;
}

function channelNameRedactedFromConversation(
  conversation: StoredConversation,
): boolean {
  const effectiveChannelName = conversation.channelName;
  const slackThread = parseSlackThreadId(conversation.conversationId);
  if (!effectiveChannelName && !slackThread) {
    return false;
  }
  return (
    resolveConversationPrivacy({
      conversationId: conversation.conversationId,
      visibility: conversation.visibility,
    }) !== "public"
  );
}

/** Project one durable conversation and its SQL metrics into the REST summary. */
export function conversationSummaryFromStoredConversation(args: {
  conversation: StoredConversation;
  durationMs: number;
  locationId?: string;
  usage?: ConversationUsage;
}): ConversationSummaryReport {
  const { conversation, durationMs, usage } = args;
  const surface = surfaceFromSource(
    conversation.source,
    conversation.conversationId,
  );
  const actorIdentity = actorIdentityReport(conversation.actor);
  const slackThread = parseSlackThreadId(conversation.conversationId);
  const channelName = channelNameFromConversation(conversation);
  const channelNameRedacted = channelNameRedactedFromConversation(conversation);
  return {
    conversationId: conversation.conversationId,
    cumulativeDurationMs: durationMs,
    displayTitle: titleFromConversation({ conversation, surface }),
    lastProgressAt: new Date(
      conversation.execution.updatedAtMs ?? conversation.updatedAtMs,
    ).toISOString(),
    lastSeenAt: new Date(conversation.lastActivityAtMs).toISOString(),
    startedAt: new Date(conversation.createdAtMs).toISOString(),
    status: statusFromConversation(conversation),
    surface,
    ...(usage ? { cumulativeUsage: usage } : {}),
    ...(actorIdentity ? { actorIdentity } : {}),
    ...(slackThread ? { channel: slackThread.channelId } : {}),
    ...(channelName ? { channelName } : {}),
    ...(channelNameRedacted ? { channelNameRedacted: true } : {}),
    ...(args.locationId && !channelNameRedacted
      ? { locationId: args.locationId }
      : {}),
  };
}
