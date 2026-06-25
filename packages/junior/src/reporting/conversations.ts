/**
 * Conversation reporting joins the activity index with turn-session summaries.
 *
 * The conversation record is the queryable activity source; turn-session
 * records add run/transcript detail, and privacy rules decide whether raw
 * transcript payloads can leave this module.
 */
import { isRecord } from "@/chat/coerce";
import {
  canExposeConversationPayload,
  resolveConversationPrivacy,
} from "@/chat/conversation-privacy";
import type { PiMessage } from "@/chat/pi/messages";
import { buildSystemPrompt } from "@/chat/prompt";
import type {
  PluginConversationStatus,
  PluginConversations,
  PluginConversationSummary,
  Destination,
  Source,
} from "@sentry/junior-plugin-api";
import {
  createLocalSource,
  createSlackSource,
} from "@sentry/junior-plugin-api";
import {
  buildSentryConversationUrl,
  buildSentryTraceUrl,
} from "@/chat/sentry-links";
import {
  formatSlackConversationRedactedLabel,
  resolveSlackConversationContextFromThreadId,
} from "@/chat/slack/conversation-context";
import { parseSlackThreadId } from "@/chat/slack/context";
import {
  getConversationDetails,
  getConversationDetailsForIds,
  type ConversationDetailsRecord,
} from "@/chat/state/conversation-details";
import {
  getAgentTurnSessionRecord,
  listAgentTurnSessionSummariesForConversation,
  type AgentTurnSessionSummary,
} from "@/chat/state/turn-session";
import type { StoredSlackRequester } from "@/chat/requester";
import type { AgentTurnUsage } from "@/chat/usage";
import { getConversationStore } from "@/chat/db";
import type {
  Conversation as StoredConversation,
  ConversationSource,
  ConversationStore,
} from "@/chat/conversations/store";

export type {
  PluginConversationStatus,
  PluginConversations,
  PluginConversationSummary,
};

const HUNG_TURN_PROGRESS_MS = 5 * 60 * 1000;
const SAFE_METADATA_KEY_LIMIT = 20;
const PRIVATE_CONVERSATION_LABEL = "Private Conversation";
const CONVERSATION_FEED_LIMIT = 50;
const CONVERSATION_STATS_LIMIT = 5_000;
const RECENT_CONVERSATION_STATS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

interface ConversationReaderOptions {
  conversationStore?: ConversationStore;
}

function conversationStore(
  options: ConversationReaderOptions = {},
): ConversationStore {
  return options.conversationStore ?? getConversationStore();
}

export type ConversationReportStatus =
  | "active"
  | "completed"
  | "failed"
  | "hung"
  | "superseded";

export type ConversationSurface = "api" | "internal" | "scheduler" | "slack";

export interface ConversationUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheCreationTokens?: number;
  totalTokens?: number;
}

export interface RequesterIdentity {
  email?: string;
  fullName?: string;
  slackUserId?: string;
  slackUserName?: string;
}

export interface ConversationSummaryReport {
  /** Always-populated display title, with privacy redaction applied first. */
  displayTitle: string;
  cumulativeDurationMs: number;
  cumulativeUsage?: ConversationUsage;
  conversationId: string;
  id: string;
  status: ConversationReportStatus;
  startedAt: string;
  lastSeenAt: string;
  lastProgressAt: string;
  completedAt?: string;
  surface: ConversationSurface;
  requesterIdentity?: RequesterIdentity;
  channel?: string;
  channelName?: string;
  sentryConversationUrl?: string;
  sentryTraceUrl?: string;
  traceId?: string;
}

export type TranscriptPartType =
  | "text"
  | "thinking"
  | "tool_call"
  | "tool_result"
  | "unknown";

export interface TranscriptPart {
  bytes?: number;
  chars?: number;
  id?: string;
  input?: unknown;
  inputKeys?: string[];
  inputSizeBytes?: number;
  inputSizeChars?: number;
  inputType?: string;
  name?: string;
  output?: unknown;
  outputKeys?: string[];
  outputSizeBytes?: number;
  outputSizeChars?: number;
  outputType?: string;
  redacted?: boolean;
  sourceType?: string;
  text?: string;
  type: TranscriptPartType;
}

export type TranscriptRole =
  | "assistant"
  | "system"
  | "tool"
  | "toolResult"
  | "unknown"
  | "user";

export interface TranscriptMessage {
  parts: TranscriptPart[];
  role: TranscriptRole;
  timestamp?: number;
}

export interface ConversationRunReport extends ConversationSummaryReport {
  transcriptAvailable: boolean;
  transcriptMetadata?: TranscriptMessage[];
  transcriptMessageCount?: number;
  transcriptRedacted?: boolean;
  transcriptRedactionReason?: "non_public_conversation";
  transcript: TranscriptMessage[];
}

export interface ConversationReport {
  conversationId: string;
  /** Always-populated display title, computed the same way as per-run reports. */
  displayTitle: string;
  generatedAt: string;
  runs: ConversationRunReport[];
}

export interface ConversationFeed {
  sessions: ConversationSummaryReport[];
  source: "conversation_index";
  generatedAt: string;
}

export interface ConversationStatsItem {
  active: number;
  conversations: number;
  durationMs: number;
  failed: number;
  hung: number;
  label: string;
  runs: number;
  tokens?: number;
}

export interface ConversationStatsReport {
  active: number;
  conversations: number;
  durationMs: number;
  failed: number;
  generatedAt: string;
  hung: number;
  locations: ConversationStatsItem[];
  requesters: ConversationStatsItem[];
  sampleLimit: number;
  sampleSize: number;
  source: "conversation_index";
  tokens?: number;
  truncated: boolean;
  runs: number;
  windowEnd: string;
  windowStart: string;
}

function statusFromCheckpoint(
  summary: AgentTurnSessionSummary,
  nowMs = Date.now(),
): ConversationSummaryReport["status"] {
  const state = summary.state;
  if (
    state === "running" &&
    nowMs - summary.lastProgressAtMs > HUNG_TURN_PROGRESS_MS
  ) {
    return "hung";
  }
  if (state === "running" || state === "awaiting_resume") {
    return "active";
  }
  if (state === "abandoned") {
    return "superseded";
  }
  return state;
}

function surfaceFromConversationId(
  conversationId: string,
): ConversationSurface {
  if (parseSlackThreadId(conversationId)) return "slack";
  if (conversationId.startsWith("scheduler:")) return "scheduler";
  if (conversationId.startsWith("api:")) return "api";
  return "internal";
}

function surfaceFromSummary(
  summary: AgentTurnSessionSummary,
): ConversationSurface {
  return summary.surface ?? surfaceFromConversationId(summary.conversationId);
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

function requesterIdentityReport(
  requester: StoredSlackRequester | undefined,
): RequesterIdentity | undefined {
  if (!requester) return undefined;
  const identity: RequesterIdentity = {
    ...(requester.email !== undefined ? { email: requester.email } : {}),
    ...(requester.fullName !== undefined
      ? { fullName: requester.fullName }
      : {}),
    ...(requester.slackUserId !== undefined
      ? { slackUserId: requester.slackUserId }
      : {}),
    ...(requester.slackUserName !== undefined
      ? { slackUserName: requester.slackUserName }
      : {}),
  };
  return Object.keys(identity).length > 0 ? identity : undefined;
}

function usageReport(
  usage: AgentTurnUsage | undefined,
): ConversationUsage | undefined {
  if (!usage) return undefined;
  const report: ConversationUsage = {
    ...(usage.inputTokens !== undefined
      ? { inputTokens: usage.inputTokens }
      : {}),
    ...(usage.outputTokens !== undefined
      ? { outputTokens: usage.outputTokens }
      : {}),
    ...(usage.cachedInputTokens !== undefined
      ? { cachedInputTokens: usage.cachedInputTokens }
      : {}),
    ...(usage.cacheCreationTokens !== undefined
      ? { cacheCreationTokens: usage.cacheCreationTokens }
      : {}),
    ...(usage.totalTokens !== undefined
      ? { totalTokens: usage.totalTokens }
      : {}),
  };
  return Object.keys(report).length > 0 ? report : undefined;
}

/** Build one run row while preserving privacy redaction over stored labels. */
function sessionReportFromSummary(
  summary: AgentTurnSessionSummary,
  nowMs = Date.now(),
  details?: ConversationDetailsRecord,
): ConversationSummaryReport {
  const slackThread = parseSlackThreadId(summary.conversationId);
  const privacy = resolveConversationPrivacy({
    conversationId: summary.conversationId,
  });
  const effectiveChannelName = details?.channelName ?? summary.channelName;
  const slackConversation = resolveSlackConversationContextFromThreadId({
    threadId: summary.conversationId,
    channelName: effectiveChannelName,
  });
  const privateLabel =
    privacy !== "public"
      ? slackConversation
        ? formatSlackConversationRedactedLabel(slackConversation)
        : PRIVATE_CONVERSATION_LABEL
      : undefined;
  const channelName = privateLabel ?? effectiveChannelName;
  const effectiveSurface =
    details?.originSurface ?? surfaceFromSummary(summary);
  const displayTitle =
    privateLabel ??
    details?.displayTitle ??
    slackStatsLocationLabel({
      channel: slackThread?.channelId,
      channelName: effectiveChannelName,
    }) ??
    surfaceFallbackLabel(effectiveSurface);
  const effectiveRequester = details?.originRequester ?? summary.requester;
  const sentryConversationUrl = buildSentryConversationUrl(
    summary.conversationId,
  );
  const sentryTraceUrl = summary.traceId
    ? buildSentryTraceUrl(summary.traceId)
    : undefined;
  const requesterIdentity = requesterIdentityReport(effectiveRequester);
  const cumulativeUsage = usageReport(summary.cumulativeUsage);
  return {
    conversationId: summary.conversationId,
    displayTitle,
    id: summary.sessionId,
    status: statusFromCheckpoint(summary, nowMs),
    startedAt: new Date(summary.startedAtMs).toISOString(),
    lastProgressAt: new Date(summary.lastProgressAtMs).toISOString(),
    lastSeenAt: new Date(summary.updatedAtMs).toISOString(),
    ...(summary.state === "completed"
      ? { completedAt: new Date(summary.updatedAtMs).toISOString() }
      : {}),
    cumulativeDurationMs: summary.cumulativeDurationMs,
    ...(cumulativeUsage ? { cumulativeUsage } : {}),
    surface: effectiveSurface,
    ...(requesterIdentity ? { requesterIdentity } : {}),
    ...(slackThread ? { channel: slackThread.channelId } : {}),
    ...(channelName ? { channelName } : {}),
    ...(sentryConversationUrl ? { sentryConversationUrl } : {}),
    ...(summary.traceId ? { traceId: summary.traceId } : {}),
    ...(sentryTraceUrl ? { sentryTraceUrl } : {}),
  };
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

function titleFromConversation(args: {
  conversation: StoredConversation;
  details?: ConversationDetailsRecord;
  surface: ConversationSurface;
}): string {
  const slackThread = parseSlackThreadId(args.conversation.conversationId);
  const effectiveChannelName =
    args.details?.channelName ?? args.conversation.channelName;
  const slackConversation = resolveSlackConversationContextFromThreadId({
    threadId: args.conversation.conversationId,
    channelName: effectiveChannelName,
  });
  const privateLabel =
    resolveConversationPrivacy({
      conversationId: args.conversation.conversationId,
    }) !== "public"
      ? slackConversation
        ? formatSlackConversationRedactedLabel(slackConversation)
        : PRIVATE_CONVERSATION_LABEL
      : undefined;
  return (
    privateLabel ??
    args.details?.displayTitle ??
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
  details?: ConversationDetailsRecord,
): string | undefined {
  const effectiveChannelName = details?.channelName ?? conversation.channelName;
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
    }) !== "public"
  ) {
    return (
      formatSlackConversationRedactedLabel(slackConversation) ??
      (slackConversation ? undefined : PRIVATE_CONVERSATION_LABEL)
    );
  }
  return effectiveChannelName;
}

function applyConversationIndexMetadata(args: {
  conversation: StoredConversation;
  details?: ConversationDetailsRecord;
  nowMs: number;
  report: ConversationSummaryReport;
}): ConversationSummaryReport {
  const surface =
    args.details?.originSurface ??
    (args.conversation.source
      ? surfaceFromSource(
          args.conversation.source,
          args.conversation.conversationId,
        )
      : args.report.surface);
  const slackThread = parseSlackThreadId(args.conversation.conversationId);
  const effectiveChannelName =
    channelNameFromConversation(args.conversation, args.details) ??
    args.report.channelName;
  const requesterIdentity =
    requesterIdentityReport(args.details?.originRequester) ??
    args.report.requesterIdentity ??
    requesterIdentityReport(args.conversation.requester);
  const status = statusFromConversation(
    args.conversation,
    args.report.status,
    args.nowMs,
  );
  const lastSeenAtMs = Math.max(
    reportTime(args.report.lastSeenAt) ?? 0,
    args.conversation.lastActivityAtMs,
  );
  return {
    ...args.report,
    displayTitle: titleFromConversation({
      conversation: args.conversation,
      details: args.details,
      surface,
    }),
    status,
    lastSeenAt: new Date(lastSeenAtMs).toISOString(),
    surface,
    ...(requesterIdentity ? { requesterIdentity } : {}),
    ...(slackThread ? { channel: slackThread.channelId } : {}),
    ...(effectiveChannelName ? { channelName: effectiveChannelName } : {}),
  };
}

function sessionReportFromConversation(
  conversation: StoredConversation,
  nowMs: number,
  details?: ConversationDetailsRecord,
): ConversationSummaryReport {
  const surface =
    details?.originSurface ??
    surfaceFromSource(conversation.source, conversation.conversationId);
  const sentryConversationUrl = buildSentryConversationUrl(
    conversation.conversationId,
  );
  const requesterIdentity = requesterIdentityReport(
    details?.originRequester ?? conversation.requester,
  );
  const slackThread = parseSlackThreadId(conversation.conversationId);
  const channelName = channelNameFromConversation(conversation, details);
  return {
    conversationId: conversation.conversationId,
    cumulativeDurationMs: 0,
    displayTitle: titleFromConversation({ conversation, details, surface }),
    id: conversation.execution.runId ?? conversation.conversationId,
    lastProgressAt: new Date(
      conversation.execution.updatedAtMs ?? conversation.updatedAtMs,
    ).toISOString(),
    lastSeenAt: new Date(conversation.lastActivityAtMs).toISOString(),
    startedAt: new Date(conversation.createdAtMs).toISOString(),
    status: statusFromConversation(conversation, undefined, nowMs),
    surface,
    ...(requesterIdentity ? { requesterIdentity } : {}),
    ...(slackThread ? { channel: slackThread.channelId } : {}),
    ...(channelName ? { channelName } : {}),
    ...(sentryConversationUrl ? { sentryConversationUrl } : {}),
  };
}

function reportTime(value: string): number | undefined {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
}

function usageTokenTotal(
  usage: ConversationUsage | undefined,
): number | undefined {
  if (!usage) return undefined;
  const components = [
    usage.inputTokens,
    usage.outputTokens,
    usage.cachedInputTokens,
    usage.cacheCreationTokens,
  ].reduce<number | undefined>((sum, value) => {
    const count =
      typeof value === "number" && Number.isFinite(value)
        ? Math.max(0, Math.floor(value))
        : undefined;
    return count === undefined ? sum : (sum ?? 0) + count;
  }, undefined);
  if (components !== undefined) {
    return components;
  }
  return typeof usage.totalTokens === "number" &&
    Number.isFinite(usage.totalTokens)
    ? Math.max(0, Math.floor(usage.totalTokens))
    : undefined;
}

type RunContribution = {
  durationMs: number;
  tokens?: number;
  run: ConversationSummaryReport;
};

function runDurationSnapshot(
  run: ConversationSummaryReport,
): number | undefined {
  return typeof run.cumulativeDurationMs === "number" &&
    Number.isFinite(run.cumulativeDurationMs)
    ? Math.max(0, Math.floor(run.cumulativeDurationMs))
    : undefined;
}

function runContributions(
  runs: ConversationSummaryReport[],
): RunContribution[] {
  let previousDuration = 0;
  let previousTokens = 0;
  return runs.map((run) => {
    const duration = runDurationSnapshot(run);
    const tokens = usageTokenTotal(run.cumulativeUsage);
    const contribution: RunContribution = {
      durationMs:
        duration === undefined ? 0 : Math.max(0, duration - previousDuration),
      run,
    };
    if (tokens !== undefined) {
      contribution.tokens = Math.max(0, tokens - previousTokens);
    }
    if (duration !== undefined) {
      previousDuration = Math.max(previousDuration, duration);
    }
    if (tokens !== undefined) {
      previousTokens = Math.max(previousTokens, tokens);
    }
    return contribution;
  });
}

function contributionDurationTotal(contributions: RunContribution[]): number {
  return contributions.reduce(
    (sum, contribution) => sum + contribution.durationMs,
    0,
  );
}

function addTokenTotal(
  total: number | undefined,
  tokens: number | undefined,
): number | undefined {
  return tokens === undefined ? total : (total ?? 0) + tokens;
}

function contributionTokenTotal(
  contributions: RunContribution[],
): number | undefined {
  return contributions.reduce(
    (sum, contribution) => addTokenTotal(sum, contribution.tokens),
    undefined as number | undefined,
  );
}

function requesterLabel(
  requester: RequesterIdentity | undefined,
): string | undefined {
  const email = requester?.email?.trim() || undefined;
  const fullName = requester?.fullName?.trim() || undefined;
  const slackUserName = requester?.slackUserName?.trim() || undefined;
  return email ?? fullName ?? slackUserName ?? requester?.slackUserId;
}

function slackStatsLocationLabel(
  input: Pick<ConversationSummaryReport, "channel" | "channelName">,
): string | undefined {
  const channelId = input.channel;
  if (!channelId) return undefined;

  const name = input.channelName?.replace(/^#/, "");
  if (channelId.startsWith("D")) {
    return "Direct Message";
  }
  if (channelId.startsWith("C")) {
    return name ? `#${name}` : "Public Channel";
  }
  if (channelId.startsWith("G")) {
    if (name?.startsWith("mpdm-")) return "Group DM";
    return "Private Channel";
  }
  return name || channelId;
}

function surfaceFallbackLabel(surface: ConversationSurface): string {
  if (surface === "scheduler") return "Scheduler";
  if (surface === "api") return "API";
  if (surface === "internal") return "Internal";
  return "Conversation";
}

function displayTitleFromDetails(
  conversationId: string,
  details: ConversationDetailsRecord | undefined,
): string | undefined {
  if (!details) return undefined;
  const slackThread = parseSlackThreadId(conversationId);
  const slackConversation = resolveSlackConversationContextFromThreadId({
    threadId: conversationId,
    channelName: details.channelName,
  });
  const privateLabel =
    resolveConversationPrivacy({ conversationId }) !== "public"
      ? (formatSlackConversationRedactedLabel(slackConversation) ??
        PRIVATE_CONVERSATION_LABEL)
      : undefined;
  return (
    privateLabel ??
    details.displayTitle ??
    slackStatsLocationLabel({
      channel: slackThread?.channelId,
      channelName: details.channelName,
    }) ??
    (details.originSurface
      ? surfaceFallbackLabel(details.originSurface)
      : undefined)
  );
}

function locationLabel(run: ConversationSummaryReport): string {
  return slackStatsLocationLabel(run) ?? surfaceFallbackLabel(run.surface);
}

function emptyStatsItem(label: string): ConversationStatsItem {
  return {
    active: 0,
    conversations: 0,
    durationMs: 0,
    failed: 0,
    hung: 0,
    label,
    runs: 0,
  };
}

function addItemTokens(
  item: ConversationStatsItem,
  tokens: number | undefined,
): void {
  if (tokens !== undefined) {
    item.tokens = (item.tokens ?? 0) + tokens;
  }
}

function statusSignals(runs: ConversationSummaryReport[]) {
  return {
    active: runs.some((run) => run.status === "active"),
    failed: runs.some((run) => run.status === "failed"),
    hung: runs.some((run) => run.status === "hung"),
  };
}

function statsItems(map: Map<string, ConversationStatsItem>) {
  return [...map.values()].sort(
    (left, right) =>
      right.conversations - left.conversations ||
      right.runs - left.runs ||
      right.durationMs - left.durationMs ||
      left.label.localeCompare(right.label),
  );
}

function newestRun(
  runs: ConversationSummaryReport[],
): ConversationSummaryReport {
  return [...runs].sort(
    (left, right) =>
      (reportTime(right.lastSeenAt) ?? 0) -
        (reportTime(left.lastSeenAt) ?? 0) || right.id.localeCompare(left.id),
  )[0]!;
}

function recentConversationGroups(args: {
  nowMs: number;
  sessions: ConversationSummaryReport[];
}): ConversationSummaryReport[][] {
  const startMs = args.nowMs - RECENT_CONVERSATION_STATS_WINDOW_MS;
  const groups = new Map<string, ConversationSummaryReport[]>();
  for (const session of args.sessions) {
    groups.set(session.conversationId, [
      ...(groups.get(session.conversationId) ?? []),
      session,
    ]);
  }

  return [...groups.values()]
    .map((runs) =>
      [...runs].sort(
        (left, right) =>
          (reportTime(left.startedAt) ?? 0) -
            (reportTime(right.startedAt) ?? 0) ||
          left.id.localeCompare(right.id),
      ),
    )
    .filter((runs) => {
      const activityAt = reportTime(newestRun(runs).lastSeenAt);
      return (
        activityAt !== undefined &&
        activityAt >= startMs &&
        activityAt <= args.nowMs
      );
    });
}

function conversationDurationMs(runs: ConversationSummaryReport[]): number {
  if (!runs.some((run) => runDurationSnapshot(run) !== undefined)) {
    return 0;
  }
  return contributionDurationTotal(runContributions(runs));
}

function buildConversationStatsReport(args: {
  generatedAt: string;
  nowMs: number;
  sampleLimit: number;
  sampleSize: number;
  sessions: ConversationSummaryReport[];
  truncated: boolean;
}): ConversationStatsReport {
  const conversations = recentConversationGroups(args);
  const requesters = new Map<string, ConversationStatsItem>();
  const locations = new Map<string, ConversationStatsItem>();
  let durationMs = 0;
  let tokens: number | undefined;
  let active = 0;
  let failed = 0;
  let hung = 0;

  for (const runs of conversations) {
    const contributions = runContributions(runs);
    const conversationSignals = statusSignals(runs);
    const conversationTokens = contributionTokenTotal(contributions);
    durationMs += contributionDurationTotal(contributions);
    tokens = addTokenTotal(tokens, conversationTokens);
    active += conversationSignals.active ? 1 : 0;
    failed += conversationSignals.failed ? 1 : 0;
    hung += conversationSignals.hung ? 1 : 0;

    const requesterRuns = new Map<string, RunContribution[]>();
    for (const contribution of contributions) {
      const requester =
        requesterLabel(contribution.run.requesterIdentity) ?? "Unknown";
      requesterRuns.set(requester, [
        ...(requesterRuns.get(requester) ?? []),
        contribution,
      ]);
    }

    for (const [requester, requesterContributions] of requesterRuns) {
      const item = requesters.get(requester) ?? emptyStatsItem(requester);
      const signals = statusSignals(
        requesterContributions.map((contribution) => contribution.run),
      );
      item.conversations += 1;
      item.runs += requesterContributions.length;
      item.durationMs += contributionDurationTotal(requesterContributions);
      item.active += signals.active ? 1 : 0;
      item.failed += signals.failed ? 1 : 0;
      item.hung += signals.hung ? 1 : 0;
      addItemTokens(item, contributionTokenTotal(requesterContributions));
      requesters.set(requester, item);
    }

    const location = locationLabel(newestRun(runs));
    const locationItem = locations.get(location) ?? emptyStatsItem(location);
    locationItem.conversations += 1;
    locationItem.runs += runs.length;
    locationItem.durationMs += conversationDurationMs(runs);
    locationItem.active += conversationSignals.active ? 1 : 0;
    locationItem.failed += conversationSignals.failed ? 1 : 0;
    locationItem.hung += conversationSignals.hung ? 1 : 0;
    addItemTokens(locationItem, conversationTokens);
    locations.set(location, locationItem);
  }

  return {
    active,
    conversations: conversations.length,
    durationMs,
    failed,
    generatedAt: args.generatedAt,
    hung,
    locations: statsItems(locations),
    requesters: statsItems(requesters),
    sampleLimit: args.sampleLimit,
    sampleSize: args.sampleSize,
    source: "conversation_index",
    ...(tokens !== undefined ? { tokens } : {}),
    truncated: args.truncated,
    runs: conversations.reduce((sum, runs) => sum + runs.length, 0),
    windowEnd: new Date(args.nowMs).toISOString(),
    windowStart: new Date(
      args.nowMs - RECENT_CONVERSATION_STATS_WINDOW_MS,
    ).toISOString(),
  };
}

function canExposeConversationTranscript(
  summary: AgentTurnSessionSummary,
): boolean {
  return canExposeConversationPayload({
    conversationId: summary.conversationId,
  });
}

function textPart(text: string): TranscriptPart {
  return { type: "text", text };
}

function recordField(value: Record<string, unknown>, names: string[]): unknown {
  for (const name of names) {
    if (value[name] !== undefined) {
      return value[name];
    }
  }
  return undefined;
}

function normalizeTranscriptPart(part: unknown): TranscriptPart {
  if (typeof part === "string") {
    return textPart(part);
  }
  if (!isRecord(part)) {
    return { type: "unknown", output: part };
  }

  const rawType = typeof part.type === "string" ? part.type : "unknown";
  if (rawType === "text") {
    const text = recordField(part, ["text", "content"]);
    return textPart(
      typeof text === "string" ? text : (JSON.stringify(text) ?? ""),
    );
  }
  if (rawType === "toolCall") {
    return {
      type: "tool_call",
      ...(typeof part.id === "string" ? { id: part.id } : {}),
      ...(typeof part.name === "string" ? { name: part.name } : {}),
      input: recordField(part, ["arguments", "input", "args"]),
    };
  }
  if (rawType === "toolResult") {
    return {
      type: "tool_result",
      ...(typeof part.id === "string" ? { id: part.id } : {}),
      ...(typeof part.name === "string" ? { name: part.name } : {}),
      output: recordField(part, ["result", "output", "content"]),
    };
  }
  if (rawType === "thinking") {
    return {
      type: "thinking",
      output: recordField(part, ["thinking", "text", "content", "output"]),
    };
  }

  return {
    type: "unknown",
    ...(rawType !== "unknown" ? { sourceType: rawType } : {}),
    output: part,
  };
}

function normalizeToolResultMessage(
  record: Record<string, unknown>,
): TranscriptPart {
  const content = record.content;
  let output = content;
  if (Array.isArray(content) && content.length === 1 && isRecord(content[0])) {
    const extracted = recordField(content[0], [
      "text",
      "content",
      "output",
      "result",
    ]);
    output = extracted !== undefined ? extracted : content;
  }
  return {
    type: "tool_result",
    ...(typeof record.toolCallId === "string" ? { id: record.toolCallId } : {}),
    ...(typeof record.name === "string"
      ? { name: record.name }
      : typeof record.toolName === "string"
        ? { name: record.toolName }
        : {}),
    output,
  };
}

function normalizeTranscriptMessage(message: PiMessage): TranscriptMessage {
  const record = message as unknown as Record<string, unknown>;
  const content = record.content;
  const role = transcriptRole(record.role);
  return {
    role,
    ...(typeof record.timestamp === "number"
      ? { timestamp: record.timestamp }
      : {}),
    parts:
      role === "toolResult"
        ? [normalizeToolResultMessage(record)]
        : Array.isArray(content)
          ? content.map(normalizeTranscriptPart)
          : [normalizeTranscriptPart(content)],
  };
}

function transcriptRole(role: unknown): TranscriptRole {
  return role === "assistant" ||
    role === "system" ||
    role === "tool" ||
    role === "toolResult" ||
    role === "user"
    ? role
    : "unknown";
}

function serializedChars(value: unknown): number {
  if (typeof value === "string") return value.length;
  return JSON.stringify(value)?.length ?? 0;
}

function serializedBytes(value: unknown): number {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  return new TextEncoder().encode(serialized ?? "").byteLength;
}

function payloadType(value: unknown): string {
  return Array.isArray(value) ? "array" : typeof value;
}

function payloadKeys(value: unknown): string[] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const keys = Object.keys(value as Record<string, unknown>).slice(
    0,
    SAFE_METADATA_KEY_LIMIT,
  );
  return keys.length > 0 ? keys : undefined;
}

function redactedPayloadFields(prefix: "input" | "output", value: unknown) {
  const keys = payloadKeys(value);
  return {
    [`${prefix}Type`]: payloadType(value),
    [`${prefix}SizeBytes`]: serializedBytes(value),
    [`${prefix}SizeChars`]: serializedChars(value),
    ...(keys ? { [`${prefix}Keys`]: keys } : {}),
  };
}

function redactTranscriptPart(part: TranscriptPart): TranscriptPart {
  if (part.type === "text") {
    return {
      type: "text",
      redacted: true,
      bytes: serializedBytes(part.text ?? ""),
      chars: serializedChars(part.text ?? ""),
    };
  }
  if (part.type === "thinking") {
    return {
      type: "thinking",
      redacted: true,
      ...redactedPayloadFields("output", part.output),
    };
  }
  if (part.type === "tool_call") {
    return {
      type: "tool_call",
      redacted: true,
      ...(part.id ? { id: part.id } : {}),
      ...(part.name ? { name: part.name } : {}),
      ...redactedPayloadFields("input", part.input),
    };
  }
  if (part.type === "tool_result") {
    return {
      type: "tool_result",
      redacted: true,
      ...(part.id ? { id: part.id } : {}),
      ...(part.name ? { name: part.name } : {}),
      ...redactedPayloadFields("output", part.output),
    };
  }
  return {
    type: "unknown",
    redacted: true,
    ...(part.sourceType ? { sourceType: part.sourceType } : {}),
    ...redactedPayloadFields("output", part.output ?? part.input ?? part.text),
  };
}

function redactTranscriptMessage(
  message: TranscriptMessage,
): TranscriptMessage {
  return {
    role: message.role,
    ...(typeof message.timestamp === "number"
      ? { timestamp: message.timestamp }
      : {}),
    parts: message.parts.map(redactTranscriptPart),
  };
}

function isConversationMessageRole(role: TranscriptRole): boolean {
  return role === "user" || role === "assistant";
}

function hasTextPart(message: TranscriptMessage): boolean {
  return message.parts.some((part) => {
    if (part.type !== "text") return false;
    if (part.redacted) return true;
    return typeof part.text === "string" && part.text.trim().length > 0;
  });
}

function isConversationMessage(message: TranscriptMessage): boolean {
  if (!isConversationMessageRole(message.role)) return false;
  if (message.role === "assistant") return hasTextPart(message);
  return message.parts.length > 0;
}

function countConversationMessages(transcript: TranscriptMessage[]): number {
  return transcript.filter(isConversationMessage).length;
}

function systemPromptMessage(destination: Destination): TranscriptMessage {
  return {
    role: "system",
    parts: [
      {
        type: "text",
        text: buildSystemPrompt({ source: sourceFromDestination(destination) }),
      },
    ],
  };
}

function sourceFromDestination(destination: Destination): Source {
  if (destination.platform === "local") {
    return createLocalSource(destination.conversationId);
  }
  return createSlackSource({
    teamId: destination.teamId,
    channelId: destination.channelId,
  });
}

interface ScopedTurnMessages {
  messages: PiMessage[];
  startsAtRunBoundary: boolean;
}

function turnScopedMessages(
  messages: PiMessage[],
  turnStartMessageIndex?: number,
): ScopedTurnMessages {
  if (
    turnStartMessageIndex !== undefined &&
    turnStartMessageIndex >= 0 &&
    turnStartMessageIndex < messages.length
  ) {
    return {
      messages: messages.slice(turnStartMessageIndex),
      startsAtRunBoundary: turnStartMessageIndex === 0,
    };
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const record = messages[index] as unknown as Record<string, unknown>;
    if (record.role === "user") {
      return {
        messages: messages.slice(index),
        startsAtRunBoundary: index === 0,
      };
    }
  }
  return {
    messages,
    startsAtRunBoundary: messages.length > 0,
  };
}

function traceIdFromTranscript(
  transcript: TranscriptMessage[],
): string | undefined {
  for (const message of transcript) {
    for (const part of message.parts) {
      const text =
        part.text ??
        (typeof part.output === "string"
          ? part.output
          : typeof part.input === "string"
            ? part.input
            : undefined);
      const match = text?.match(
        /\btrace[_-]?id["']?\s*[:=]\s*["']?([a-f0-9]{16,32})\b/i,
      );
      if (match?.[1]) {
        return match[1];
      }
    }
  }
  return undefined;
}

async function summariesByConversation(
  conversations: StoredConversation[],
): Promise<Map<string, AgentTurnSessionSummary[]>> {
  const entries = await Promise.all(
    conversations.map(async (conversation) => {
      const summaries = await listAgentTurnSessionSummariesForConversation(
        conversation.conversationId,
      );
      return [conversation.conversationId, summaries] as const;
    }),
  );
  return new Map(entries);
}

async function reportsFromConversations(args: {
  conversations: StoredConversation[];
  detailsByConversationId: Map<string, ConversationDetailsRecord>;
  nowMs: number;
}): Promise<Map<string, ConversationSummaryReport[]>> {
  const summaries = await summariesByConversation(args.conversations);
  const reports = new Map<string, ConversationSummaryReport[]>();
  for (const conversation of args.conversations) {
    const details = args.detailsByConversationId.get(
      conversation.conversationId,
    );
    const conversationSummaries =
      summaries.get(conversation.conversationId) ?? [];
    const conversationReports =
      conversationSummaries.length > 0
        ? conversationSummaries.map((summary) =>
            applyConversationIndexMetadata({
              conversation,
              details,
              nowMs: args.nowMs,
              report: sessionReportFromSummary(summary, args.nowMs, details),
            }),
          )
        : [sessionReportFromConversation(conversation, args.nowMs, details)];
    reports.set(conversation.conversationId, conversationReports);
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
  const detailsByConversationId = await getConversationDetailsForIds(
    conversations.map((conversation) => conversation.conversationId),
  );
  const reportsByConversation = await reportsFromConversations({
    conversations,
    detailsByConversationId,
    nowMs,
  });
  return {
    source: "conversation_index",
    generatedAt: new Date(nowMs).toISOString(),
    sessions: conversations.map((conversation) =>
      newestRun(
        reportsByConversation.get(conversation.conversationId) ?? [
          sessionReportFromConversation(
            conversation,
            nowMs,
            detailsByConversationId.get(conversation.conversationId),
          ),
        ],
      ),
    ),
  };
}

/** Read aggregate conversation statistics for reporting consumers. */
export async function readConversationStatsReport(
  options: ConversationReaderOptions = {},
): Promise<ConversationStatsReport> {
  const store = conversationStore(options);
  const nowMs = Date.now();
  const generatedAt = new Date(nowMs).toISOString();
  const conversations = await store.listByActivity({
    limit: CONVERSATION_STATS_LIMIT + 1,
  });
  const truncated = conversations.length > CONVERSATION_STATS_LIMIT;
  const sampledConversations = conversations.slice(0, CONVERSATION_STATS_LIMIT);
  const detailsByConversationId = await getConversationDetailsForIds(
    sampledConversations.map((conversation) => conversation.conversationId),
  );
  const reportsByConversation = await reportsFromConversations({
    conversations: sampledConversations,
    detailsByConversationId,
    nowMs,
  });
  const sessions = sampledConversations.flatMap(
    (conversation) =>
      reportsByConversation.get(conversation.conversationId) ?? [
        sessionReportFromConversation(
          conversation,
          nowMs,
          detailsByConversationId.get(conversation.conversationId),
        ),
      ],
  );
  return buildConversationStatsReport({
    generatedAt,
    nowMs,
    sampleLimit: CONVERSATION_STATS_LIMIT,
    sampleSize: sampledConversations.length,
    sessions,
    truncated,
  });
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
  const detailsByConversationId = await getConversationDetailsForIds(
    conversations.map((conversation) => conversation.conversationId),
  );
  const reportsByConversation = await reportsFromConversations({
    conversations,
    detailsByConversationId,
    nowMs,
  });
  return conversations.map((conversation) => {
    const details = detailsByConversationId.get(conversation.conversationId);
    const surface = surfaceFromSource(
      conversation.source,
      conversation.conversationId,
    );
    const channelName = channelNameFromConversation(conversation, details);
    const report = newestRun(
      reportsByConversation.get(conversation.conversationId) ?? [
        sessionReportFromConversation(conversation, nowMs, details),
      ],
    );
    return {
      conversationId: conversation.conversationId,
      displayTitle: titleFromConversation({ conversation, details, surface }),
      lastActivityAt: new Date(conversation.lastActivityAtMs).toISOString(),
      lastUpdatedAt: new Date(
        conversation.execution.updatedAtMs ?? conversation.updatedAtMs,
      ).toISOString(),
      status: report.status,
      ...(channelName ? { channelName } : {}),
      ...(conversation.source ? { source: conversation.source } : {}),
    };
  });
}

/** Read one conversation transcript for reporting consumers. */
export async function readConversationReport(
  conversationId: string,
  options: ConversationReaderOptions = {},
): Promise<ConversationReport> {
  const store = conversationStore(options);
  const nowMs = Date.now();
  const [rawSummaries, details, conversation] = await Promise.all([
    listAgentTurnSessionSummariesForConversation(conversationId),
    getConversationDetails(conversationId),
    store.get({ conversationId }),
  ]);
  const summaries = rawSummaries.sort(
    (left, right) =>
      left.startedAtMs - right.startedAtMs ||
      left.updatedAtMs - right.updatedAtMs ||
      left.sessionId.localeCompare(right.sessionId),
  );

  const runs = await Promise.all(
    summaries.map(async (summary): Promise<ConversationRunReport> => {
      const sessionRecord = await getAgentTurnSessionRecord(
        summary.conversationId,
        summary.sessionId,
      );
      const scopedMessages = sessionRecord?.piMessages
        ? turnScopedMessages(
            sessionRecord.piMessages,
            sessionRecord.turnStartMessageIndex,
          )
        : { messages: [], startsAtRunBoundary: false };
      const canExposeTranscript = canExposeConversationTranscript(summary);
      const normalizedTranscript = scopedMessages.messages.map(
        normalizeTranscriptMessage,
      );
      const transcriptMessageCount =
        countConversationMessages(normalizedTranscript);
      const transcript = canExposeTranscript
        ? [
            ...(scopedMessages.startsAtRunBoundary &&
            normalizedTranscript.length > 0 &&
            sessionRecord?.destination
              ? [systemPromptMessage(sessionRecord.destination)]
              : []),
            ...normalizedTranscript,
          ]
        : [];
      const transcriptMetadata = canExposeTranscript
        ? undefined
        : normalizedTranscript.map(redactTranscriptMessage);
      const traceId =
        summary.traceId ??
        sessionRecord?.traceId ??
        (canExposeTranscript ? traceIdFromTranscript(transcript) : undefined);
      const sentryTraceUrl = traceId ? buildSentryTraceUrl(traceId) : undefined;
      const report: ConversationRunReport = {
        ...sessionReportFromSummary(summary, nowMs, details),
        ...(traceId ? { traceId } : {}),
        ...(sentryTraceUrl ? { sentryTraceUrl } : {}),
        transcriptAvailable: Boolean(sessionRecord) && canExposeTranscript,
        ...(sessionRecord && transcriptMessageCount > 0
          ? { transcriptMessageCount }
          : {}),
        ...(!canExposeTranscript
          ? {
              transcriptMetadata,
              transcriptRedacted: true,
              transcriptRedactionReason: "non_public_conversation" as const,
            }
          : {}),
        transcript,
      };
      return conversation
        ? {
            ...report,
            ...applyConversationIndexMetadata({
              conversation,
              details,
              nowMs,
              report,
            }),
          }
        : report;
    }),
  );

  const effectiveRuns =
    runs.length > 0 || !conversation
      ? runs
      : [
          {
            ...sessionReportFromConversation(conversation, nowMs, details),
            transcriptAvailable: false,
            transcript: [],
          },
        ];

  const firstRun = effectiveRuns[0];
  const displayTitle =
    firstRun?.displayTitle ??
    displayTitleFromDetails(conversationId, details) ??
    surfaceFallbackLabel(firstRun?.surface ?? "slack");

  return {
    conversationId,
    displayTitle,
    generatedAt: new Date(nowMs).toISOString(),
    runs: effectiveRuns,
  };
}
