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
import { conversationStore, type ConversationReaderOptions } from "./context";
import {
  newestRun,
  slackStatsLocationLabel,
  surfaceFallbackLabel,
} from "./shared";
import type {
  ActorIdentity,
  ConversationFeed,
  ConversationReportStatus,
  ConversationSummaryReport,
  ConversationSurface,
  PluginConversationSummary,
} from "./types";
const HUNG_TURN_PROGRESS_MS = 5 * 60 * 1000;
const PRIVATE_CONVERSATION_LABEL = "Private Conversation";
const CONVERSATION_FEED_LIMIT = 50;

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
  fallback: ConversationReportStatus | undefined,
  nowMs: number,
): ConversationReportStatus {
  if (fallback) {
    return fallback;
  }
  if (conversation.execution.status === "idle") {
    return "completed";
  }
  if (conversation.execution.status === "failed") {
    return "failed";
  }
  const updatedAtMs =
    conversation.execution.updatedAtMs ?? conversation.updatedAtMs;
  if (
    conversation.execution.status === "running" &&
    nowMs - updatedAtMs > HUNG_TURN_PROGRESS_MS
  ) {
    return "hung";
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

/** Project the current stored execution into the public run summary shape. */
export function sessionReportFromConversation(
  conversation: StoredConversation,
  nowMs: number,
): ConversationSummaryReport {
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
    cumulativeDurationMs: 0,
    displayTitle: titleFromConversation({ conversation, surface }),
    id: conversation.conversationId,
    lastProgressAt: new Date(
      conversation.execution.updatedAtMs ?? conversation.updatedAtMs,
    ).toISOString(),
    lastSeenAt: new Date(conversation.lastActivityAtMs).toISOString(),
    startedAt: new Date(conversation.createdAtMs).toISOString(),
    status: statusFromConversation(conversation, undefined, nowMs),
    surface,
    ...(actorIdentity ? { actorIdentity } : {}),
    ...(slackThread ? { channel: slackThread.channelId } : {}),
    ...(channelName ? { channelName } : {}),
    ...(channelNameRedacted ? { channelNameRedacted: true } : {}),
  };
}

async function reportsFromConversations(args: {
  conversations: StoredConversation[];
  nowMs: number;
}): Promise<Map<string, ConversationSummaryReport[]>> {
  const reports = new Map<string, ConversationSummaryReport[]>();
  for (const conversation of args.conversations) {
    reports.set(conversation.conversationId, [
      sessionReportFromConversation(conversation, args.nowMs),
    ]);
  }
  return reports;
}

/** Read the recent conversation feed for reporting consumers. */
export async function readConversationFeed(
  options: ConversationReaderOptions = {},
): Promise<ConversationFeed> {
  const store = conversationStore(options);
  const nowMs = Date.now();
  const conversations = await store.listByActivity({
    limit: CONVERSATION_FEED_LIMIT,
  });
  const reportsByConversation = await reportsFromConversations({
    conversations,
    nowMs,
  });
  return {
    source: "conversation_index",
    generatedAt: new Date(nowMs).toISOString(),
    conversations: conversations.map((conversation) =>
      newestRun(
        reportsByConversation.get(conversation.conversationId) ?? [
          sessionReportFromConversation(conversation, nowMs),
        ],
      ),
    ),
  };
}

/** List recent conversation summaries for plugin operational reports. */
export async function listRecentConversationSummaries(
  options: {
    limit?: number;
  } & ConversationReaderOptions = {},
): Promise<PluginConversationSummary[]> {
  const store = conversationStore(options);
  const nowMs = Date.now();
  const limit = Math.max(0, Math.min(100, Math.floor(options.limit ?? 25)));
  const conversations = await store.listByActivity({
    limit,
  });
  const reportsByConversation = await reportsFromConversations({
    conversations,
    nowMs,
  });
  return conversations.map((conversation) => {
    const surface = surfaceFromSource(
      conversation.source,
      conversation.conversationId,
    );
    const channelName = channelNameFromConversation(conversation);
    const channelNameRedacted =
      channelNameRedactedFromConversation(conversation);
    const report = newestRun(
      reportsByConversation.get(conversation.conversationId) ?? [
        sessionReportFromConversation(conversation, nowMs),
      ],
    );
    return {
      conversationId: conversation.conversationId,
      displayTitle: titleFromConversation({ conversation, surface }),
      lastActivityAt: new Date(conversation.lastActivityAtMs).toISOString(),
      lastUpdatedAt: new Date(
        conversation.execution.updatedAtMs ?? conversation.updatedAtMs,
      ).toISOString(),
      status: report.status,
      ...(channelName ? { channelName } : {}),
      ...(channelNameRedacted ? { channelNameRedacted: true } : {}),
      ...(conversation.source ? { source: conversation.source } : {}),
    };
  });
}

/** Build the current run's reportable content from the current context epoch. */
