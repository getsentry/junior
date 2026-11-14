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
import { fallbackShortTitle } from "@/chat/services/short-title";
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
  | "kind"
  | "lastActivityAtMs"
  | "location"
  | "parentConversationId"
  | "source"
  | "stoppedAtMs"
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

/**
 * A stopped Conversation shows as `stopped` while no work runs. A Turn that
 * runs before the stop ends, such as one that its parent's new work starts,
 * shows as `active`.
 */
function statusFromConversation(
  conversation: ConversationProjectionSource,
): ConversationReportStatus {
  const status = conversation.execution.status;
  if (status !== "idle" && status !== "failed") {
    return "active";
  }
  if (conversation.stoppedAtMs !== undefined) {
    return "stopped";
  }
  return status === "idle" ? "completed" : "failed";
}

function titleFromConversation(args: {
  automationTitle?: string | undefined;
  canViewPrivateContent: boolean;
  conversation: ConversationProjectionSource;
  firstHumanMessageText?: string | undefined;
  surface: ConversationSurface;
  visibility?: SlackConversationVisibility | undefined;
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
    // Read-time fallback while a run's own title is unset. Nothing is stored.
    args.automationTitle ??
    slackStatsLocationLabel({
      channel: slackThread?.channelId,
      channelName: effectiveChannelName,
    }) ??
    // Dispatched runs, such as automation runs, are not internal machinery.
    (args.conversation.source === "plugin"
      ? "Automation run"
      : // Read-time fallback while title generation runs. Nothing is stored.
        fallbackShortTitle(
          args.firstHumanMessageText ?? "",
          surfaceFallbackLabel(args.surface),
        ))
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
  access?: ConversationAccess | undefined;
  /** Name of the Automation that started this conversation, when known. */
  automationTitle?: string | undefined;
  auxiliaryCosts?: ConversationSummaryReport["auxiliaryCosts"] | undefined;
  childAgentTotals?: ConversationSummaryReport["childAgentTotals"];
  conversation: ConversationProjectionSource;
  durationMs: number;
  /** First human message text, used as the title until one is stored. */
  firstHumanMessageText?: string | undefined;
  locationId?: string;
  pinnedAtMs?: number | undefined;
  pinPosition?: number;
  teamDomainByTeamId?: ReadonlyMap<string, string>;
  usage?: ConversationUsage | undefined;
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
  const status = statusFromConversation(conversation);
  return {
    conversationId: conversation.conversationId,
    cumulativeDurationMs: durationMs,
    displayTitle: titleFromConversation({
      automationTitle: args.automationTitle,
      canViewPrivateContent,
      conversation,
      firstHumanMessageText: args.firstHumanMessageText,
      surface,
      visibility,
    }),
    kind: conversation.kind,
    ...(conversation.parentConversationId
      ? { parentConversationId: conversation.parentConversationId }
      : undefined),
    isParticipant: args.access?.isParticipant ?? false,
    ...(visibility ? { visibility } : undefined),
    lastProgressAt: new Date(
      conversation.execution.updatedAtMs ?? conversation.updatedAtMs,
    ).toISOString(),
    lastSeenAt: new Date(conversation.lastActivityAtMs).toISOString(),
    startedAt: new Date(conversation.createdAtMs).toISOString(),
    status,
    surface,
    ...(args.auxiliaryCosts
      ? { auxiliaryCosts: args.auxiliaryCosts }
      : undefined),
    ...(usage ? { cumulativeUsage: usage } : undefined),
    ...(args.childAgentTotals
      ? { childAgentTotals: args.childAgentTotals }
      : undefined),
    ...(actorIdentity ? { actorIdentity } : undefined),
    ...(locationUrl ? { locationUrl } : undefined),
    archivedAt:
      conversation.archivedAtMs === undefined
        ? null
        : new Date(conversation.archivedAtMs).toISOString(),
    pinnedAt:
      args.pinnedAtMs === undefined
        ? null
        : new Date(args.pinnedAtMs).toISOString(),
    ...(args.pinPosition === undefined
      ? undefined
      : { pinPosition: args.pinPosition }),
    ...(slackThread ? { channel: slackThread.channelId } : undefined),
    ...(channelName ? { channelName } : undefined),
    ...(channelNameRedacted ? { channelNameRedacted: true } : undefined),
    ...(args.locationId && !channelNameRedacted
      ? { locationId: args.locationId }
      : undefined),
  };
}
