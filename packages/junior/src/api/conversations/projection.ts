import {
  formatSlackConversationRedactedLabel,
  resolveSlackConversationContextFromThreadId,
  type SlackConversationVisibility,
} from "@/chat/slack/conversation-context";
import { parseSlackThreadId } from "@/chat/slack/context";
import { buildSlackLocationUrl } from "@/chat/slack/location-url";
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
  | "channelName"
  | "conversationId"
  | "createdAtMs"
  | "execution"
  | "lastActivityAtMs"
  | "location"
  | "source"
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
  if (
    source === "slack" ||
    source === "api" ||
    source === "web" ||
    source === "scheduler"
  ) {
    // Dashboard web conversations share the product api surface label.
    return source === "web" ? "api" : source;
  }
  return surfaceFromConversationId(conversationId);
}

function locationUrlFromConversation(args: {
  canViewPrivateContent: boolean;
  conversation: ConversationProjectionSource;
  teamDomainByTeamId?: ReadonlyMap<string, string>;
}): string | undefined {
  const { conversation } = args;
  if (
    !args.canViewPrivateContent ||
    conversation.location?.provider !== "slack"
  ) {
    return undefined;
  }
  const teamDomain = args.teamDomainByTeamId?.get(conversation.location.teamId);
  const threadTs = conversation.location.threadTs;
  if (!teamDomain || !threadTs) return undefined;
  return buildSlackLocationUrl({
    channelId: conversation.location.channelId,
    teamDomain,
    threadTs,
  });
}

function actorIdentityReport(
  actor: StoredSlackActor | undefined,
): ActorIdentity | undefined {
  if (!actor) return undefined;
  const identity: ActorIdentity = {
    ...(actor.email !== undefined ? { email: actor.email } : undefined),
    ...(actor.fullName !== undefined
      ? { fullName: actor.fullName }
      : undefined),
    ...(actor.slackUserId !== undefined
      ? { slackUserId: actor.slackUserId }
      : undefined),
    ...(actor.slackUserName !== undefined
      ? { slackUserName: actor.slackUserName }
      : undefined),
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
  visibility?: SlackConversationVisibility;
}): string {
  const slackThread = parseSlackThreadId(args.conversation.conversationId);
  const effectiveChannelName = args.conversation.channelName;
  const slackConversation = resolveSlackConversationContextFromThreadId({
    threadId: args.conversation.conversationId,
    channelName: effectiveChannelName,
    ...(args.visibility ? { visibility: args.visibility } : undefined),
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
  visibility?: SlackConversationVisibility,
): string | undefined {
  const effectiveChannelName = conversation.channelName;
  const slackThread = parseSlackThreadId(conversation.conversationId);
  if (!effectiveChannelName && !slackThread) {
    return undefined;
  }
  const slackConversation = resolveSlackConversationContextFromThreadId({
    threadId: conversation.conversationId,
    channelName: effectiveChannelName,
    ...(visibility ? { visibility } : undefined),
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
  archivedAtMs?: number;
  auxiliaryCosts?: ConversationSummaryReport["auxiliaryCosts"];
  conversation: ConversationProjectionSource;
  durationMs: number;
  locationId?: string;
  teamDomainByTeamId?: ReadonlyMap<string, string>;
  usage?: ConversationUsage;
}): ConversationSummaryReport {
  const { conversation, durationMs, usage } = args;
  const canViewPrivateContent = args.access?.canViewPrivateContent ?? false;
  const accessVisibility = args.access?.visibility;
  const visibility =
    accessVisibility === "public" || accessVisibility === "private"
      ? accessVisibility
      : undefined;
  const surface = surfaceFromSource(
    conversation.source,
    conversation.conversationId,
  );
  const actorIdentity = actorIdentityReport(conversation.actor);
  const locationUrl = locationUrlFromConversation({
    canViewPrivateContent,
    conversation,
    ...(args.teamDomainByTeamId
      ? { teamDomainByTeamId: args.teamDomainByTeamId }
      : undefined),
  });
  const slackThread = parseSlackThreadId(conversation.conversationId);
  const channelName = channelNameFromConversation(
    conversation,
    canViewPrivateContent,
    visibility,
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
      visibility,
    }),
    isParticipant: args.access?.isParticipant ?? false,
    ...(visibility ? { visibility } : undefined),
    lastProgressAt: new Date(
      conversation.execution.updatedAtMs ?? conversation.updatedAtMs,
    ).toISOString(),
    lastSeenAt: new Date(conversation.lastActivityAtMs).toISOString(),
    startedAt: new Date(conversation.createdAtMs).toISOString(),
    status: statusFromConversation(conversation),
    surface,
    ...(args.auxiliaryCosts
      ? { auxiliaryCosts: args.auxiliaryCosts }
      : undefined),
    ...(usage ? { cumulativeUsage: usage } : undefined),
    ...(actorIdentity ? { actorIdentity } : undefined),
    ...(locationUrl ? { locationUrl } : undefined),
    archivedAt:
      args.archivedAtMs === undefined
        ? null
        : new Date(args.archivedAtMs).toISOString(),
    ...(slackThread ? { channel: slackThread.channelId } : undefined),
    ...(channelName ? { channelName } : undefined),
    ...(channelNameRedacted ? { channelNameRedacted: true } : undefined),
    ...(args.locationId && !channelNameRedacted
      ? { locationId: args.locationId }
      : undefined),
  };
}
