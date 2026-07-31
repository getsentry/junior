import {
  formatSlackConversationRedactedLabel,
  resolveSlackConversationContextFromThreadId,
} from "@/chat/slack/conversation-context";
import { parseSlackThreadId } from "@/chat/slack/context";
import { buildSlackSourceUrl } from "@/chat/slack/source-link";
import type { StoredSlackActor } from "@/chat/actor";
import type {
  Conversation as StoredConversation,
  ConversationSource,
} from "@/chat/conversations/store";
import { slackStatsLocationLabel, surfaceFallbackLabel } from "./shared";
import type {
  ActorIdentity,
  ConversationEventHistory,
  ConversationReportStatus,
  ConversationSummaryReport,
  ConversationSurface,
  ConversationUsage,
} from "../schema/conversation";
import type { ConversationAccess } from "./access";
const PRIVATE_CONVERSATION_LABEL = "Private Conversation";

type ConversationProjectionSource = Pick<
  StoredConversation,
  | "actor"
  | "archivedAtMs"
  | "channelName"
  | "conversationId"
  | "createdAtMs"
  | "execution"
  | "lastActivityAtMs"
  | "source"
  | "sessionSource"
  | "title"
  | "updatedAtMs"
>;

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

function sourceUrlFromConversation(
  conversation: ConversationProjectionSource,
  canViewPrivateContent: boolean,
): string | undefined {
  if (
    !canViewPrivateContent ||
    conversation.sessionSource?.platform !== "slack"
  ) {
    return undefined;
  }
  return buildSlackSourceUrl(conversation.sessionSource);
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
  conversation: ConversationProjectionSource,
): ConversationReportStatus {
  if (conversation.execution.status === "idle") {
    return "completed";
  }
  if (conversation.execution.status === "failed") {
    return "failed";
  }
  return "active";
}

function titleFromConversation(args: {
  canViewPrivateContent: boolean;
  conversation: ConversationProjectionSource;
  surface: ConversationSurface;
}): string {
  const slackThread = parseSlackThreadId(args.conversation.conversationId);
  const effectiveChannelName = args.conversation.channelName;
  const slackConversation = resolveSlackConversationContextFromThreadId({
    threadId: args.conversation.conversationId,
    channelName: effectiveChannelName,
  });
  const privateLabel = args.canViewPrivateContent
    ? undefined
    : privateConversationLabel(slackConversation);
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
  conversation: ConversationProjectionSource,
  canViewPrivateContent: boolean,
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
  if (!canViewPrivateContent) {
    return privateConversationLabel(slackConversation);
  }
  return effectiveChannelName;
}

function channelNameRedactedFromConversation(
  conversation: ConversationProjectionSource,
  canViewPrivateContent: boolean,
): boolean {
  const effectiveChannelName = conversation.channelName;
  const slackThread = parseSlackThreadId(conversation.conversationId);
  if (!effectiveChannelName && !slackThread) {
    return false;
  }
  return !canViewPrivateContent;
}

/** Describe whether a viewer can read one conversation's retained events. */
export function conversationEventHistory(args: {
  canExposePayload: boolean;
  transcriptPurgedAtMs?: number;
}): ConversationEventHistory {
  if (args.transcriptPurgedAtMs !== undefined) {
    return {
      status: "expired",
      expiredAt: new Date(args.transcriptPurgedAtMs).toISOString(),
    };
  }
  return args.canExposePayload
    ? { status: "available" }
    : { status: "redacted", reason: "non_public_conversation" };
}

/** Project one durable conversation and its SQL metrics into the REST summary. */
export function conversationSummaryFromStoredConversation(args: {
  access?: ConversationAccess;
  conversation: ConversationProjectionSource;
  durationMs: number;
  locationId?: string;
  usage?: ConversationUsage;
}): ConversationSummaryReport {
  const { conversation, durationMs, usage } = args;
  const canViewPrivateContent = args.access?.canViewPrivateContent ?? false;
  const surface = surfaceFromSource(
    conversation.source,
    conversation.conversationId,
  );
  const actorIdentity = actorIdentityReport(conversation.actor);
  const sourceUrl = sourceUrlFromConversation(
    conversation,
    canViewPrivateContent,
  );
  const slackThread = parseSlackThreadId(conversation.conversationId);
  const channelName = channelNameFromConversation(
    conversation,
    canViewPrivateContent,
  );
  const channelNameRedacted = channelNameRedactedFromConversation(
    conversation,
    canViewPrivateContent,
  );
  return {
    conversationId: conversation.conversationId,
    cumulativeDurationMs: durationMs,
    displayTitle: titleFromConversation({
      canViewPrivateContent,
      conversation,
      surface,
    }),
    isParticipant: args.access?.isParticipant ?? false,
    lastProgressAt: new Date(
      conversation.execution.updatedAtMs ?? conversation.updatedAtMs,
    ).toISOString(),
    lastSeenAt: new Date(conversation.lastActivityAtMs).toISOString(),
    startedAt: new Date(conversation.createdAtMs).toISOString(),
    status: statusFromConversation(conversation),
    surface,
    ...(usage ? { cumulativeUsage: usage } : {}),
    ...(actorIdentity ? { actorIdentity } : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(conversation.archivedAtMs
      ? { archivedAt: new Date(conversation.archivedAtMs).toISOString() }
      : {}),
    ...(slackThread ? { channel: slackThread.channelId } : {}),
    ...(channelName ? { channelName } : {}),
    ...(channelNameRedacted ? { channelNameRedacted: true } : {}),
    ...(args.locationId && !channelNameRedacted
      ? { locationId: args.locationId }
      : {}),
  };
}
