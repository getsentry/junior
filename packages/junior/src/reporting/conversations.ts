/** Conversation reporting rendered from durable SQL conversation data. */
import { isRecord } from "@/chat/coerce";
import {
  canExposeConversationPayload,
  resolveConversationPrivacy,
} from "@/chat/conversation-privacy";
import { unwrapAdvisorRequest } from "@/chat/advisor-request";
import { unwrapCurrentInstruction } from "@/chat/current-instruction";
import type { PiMessage } from "@/chat/pi/messages";
import type {
  PluginConversationStatus,
  PluginConversations,
  PluginConversationSummary,
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
import type { StoredSlackActor } from "@/chat/actor";
import {
  getAgentStepStore,
  getConversationMessageStore,
  getConversationStore,
} from "@/chat/db";
import { loadProjection, projectSteps } from "@/chat/conversations/projection";
import type {
  ConversationMessage,
  ConversationMessageStore,
} from "@/chat/conversations/messages";
import type {
  AgentStepEntry,
  AgentStepStore,
  StoredAgentStep,
} from "@/chat/conversations/history";
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

interface ConversationReaderOptions {
  messageStore?: ConversationMessageStore;
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

export interface ActorIdentity {
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
  actorIdentity?: ActorIdentity;
  channel?: string;
  channelName?: string;
  channelNameRedacted?: boolean;
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
  activity?: ConversationActivityReport[];
  transcriptAvailable: boolean;
  transcriptMetadata?: TranscriptMessage[];
  transcriptMessageCount?: number;
  transcriptRedacted?: boolean;
  transcriptRedactionReason?: "non_public_conversation";
  /**
   * True when retention purged this conversation's content. Expiry under
   * retention is distinct from privacy redaction: the content aged out and was
   * deleted, so no metadata is derived from it (see data-redaction-policy.md).
   */
  transcriptExpired?: boolean;
  /** When the content was purged (ISO 8601); present only with `transcriptExpired`. */
  transcriptExpiredAt?: string;
  transcript: TranscriptMessage[];
}

export type ConversationActivityStatus =
  | "aborted"
  | "completed"
  | "error"
  | "running"
  | "success";

interface ActivityPayloadMetadata {
  inputKeys?: string[];
  inputSizeBytes?: number;
  inputSizeChars?: number;
  inputType?: string;
}

export interface ConversationSubagentActivityReport {
  type: "subagent";
  createdAt: string;
  endedAt?: string;
  id: string;
  outcome?: "success" | "error" | "aborted";
  parentToolCallId?: string;
  status: ConversationActivityStatus;
  subagentKind: string;
  transcriptAvailable?: boolean;
}

export interface ConversationToolActivityReport extends ActivityPayloadMetadata {
  type: "tool_execution";
  args?: unknown;
  createdAt: string;
  id: string;
  redacted?: boolean;
  status: ConversationActivityStatus;
  subagents: ConversationSubagentActivityReport[];
  toolCallId: string;
  toolName: string;
}

export type ConversationActivityReport =
  | ConversationToolActivityReport
  | ConversationSubagentActivityReport;

export interface ConversationReport {
  conversationId: string;
  /** Always-populated display title, computed the same way as per-run reports. */
  displayTitle: string;
  generatedAt: string;
  sentryConversationUrl?: string;
  runs: ConversationRunReport[];
}

export interface ConversationSubagentTranscriptReport {
  type: "subagent";
  createdAt: string;
  endedAt?: string;
  id: string;
  outcome?: "success" | "error" | "aborted";
  parentToolCallId?: string;
  status: ConversationActivityStatus;
  subagentConversationId?: string;
  subagentKind: string;
  subagentSentryConversationUrl?: string;
  transcript: TranscriptMessage[];
  transcriptAvailable: boolean;
  transcriptMessageCount?: number;
  transcriptRedacted?: boolean;
  transcriptRedactionReason?: "non_public_conversation";
  /** True when retention purged the parent conversation's content. */
  transcriptExpired?: boolean;
  /** When the content was purged (ISO 8601); present only with `transcriptExpired`. */
  transcriptExpiredAt?: string;
  unavailableReason?:
    | "missing_transcript_range"
    | "missing_transcript_ref"
    | "not_found";
}

export interface ConversationFeed {
  conversations: ConversationSummaryReport[];
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
  actors: ConversationStatsItem[];
  sampleLimit: number;
  sampleSize: number;
  source: "conversation_index";
  tokens?: number;
  truncated: boolean;
  runs: number;
  windowEnd: string;
  windowStart: string;
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

function titleFromConversation(args: {
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

function sessionReportFromConversation(
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

function actorLabel(actor: ActorIdentity | undefined): string | undefined {
  const email = actor?.email?.trim() || undefined;
  const fullName = actor?.fullName?.trim() || undefined;
  const slackUserName = actor?.slackUserName?.trim() || undefined;
  return email ?? fullName ?? slackUserName ?? actor?.slackUserId;
}

function slackStatsLocationLabel(
  input: Pick<
    ConversationSummaryReport,
    "channel" | "channelName" | "channelNameRedacted"
  >,
): string | undefined {
  const channelId = input.channel;
  if (!channelId) return undefined;

  if (input.channelNameRedacted && input.channelName) {
    return input.channelName;
  }

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
  summaries: ConversationSummaryReport[];
}): ConversationSummaryReport[][] {
  const startMs = args.nowMs - RECENT_CONVERSATION_STATS_WINDOW_MS;
  const groups = new Map<string, ConversationSummaryReport[]>();
  for (const summary of args.summaries) {
    groups.set(summary.conversationId, [
      ...(groups.get(summary.conversationId) ?? []),
      summary,
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
  summaries: ConversationSummaryReport[];
  truncated: boolean;
}): ConversationStatsReport {
  const conversations = recentConversationGroups(args);
  const actors = new Map<string, ConversationStatsItem>();
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

    const actorRuns = new Map<string, RunContribution[]>();
    for (const contribution of contributions) {
      const actor = actorLabel(contribution.run.actorIdentity) ?? "Unknown";
      actorRuns.set(actor, [...(actorRuns.get(actor) ?? []), contribution]);
    }

    for (const [actor, actorContributions] of actorRuns) {
      const item = actors.get(actor) ?? emptyStatsItem(actor);
      const signals = statusSignals(
        actorContributions.map((contribution) => contribution.run),
      );
      item.conversations += 1;
      item.runs += actorContributions.length;
      item.durationMs += contributionDurationTotal(actorContributions);
      item.active += signals.active ? 1 : 0;
      item.failed += signals.failed ? 1 : 0;
      item.hung += signals.hung ? 1 : 0;
      addItemTokens(item, contributionTokenTotal(actorContributions));
      actors.set(actor, item);
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
    actors: statsItems(actors),
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

/** Normalize Pi content parts for user-facing transcript output. */
function normalizeTranscriptPart(
  part: unknown,
  options: { unwrapAdvisorTask?: boolean; unwrapCurrentTask?: boolean } = {},
): TranscriptPart {
  const displayText = (text: string) => {
    if (options.unwrapCurrentTask) {
      const instruction = unwrapCurrentInstruction(text);
      if (instruction !== undefined) return instruction;
    }
    if (options.unwrapAdvisorTask) return unwrapAdvisorRequest(text) ?? text;
    return text;
  };

  if (typeof part === "string") {
    return textPart(displayText(part));
  }
  if (!isRecord(part)) {
    return { type: "unknown", output: part };
  }

  const rawType = typeof part.type === "string" ? part.type : "unknown";
  if (rawType === "text") {
    const text = recordField(part, ["text", "content"]);
    return textPart(
      typeof text === "string"
        ? displayText(text)
        : (JSON.stringify(text) ?? ""),
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

function normalizeTranscriptMessage(
  message: PiMessage,
  options: { unwrapAdvisorTask?: boolean } = {},
): TranscriptMessage {
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
          ? content.map((part) =>
              normalizeTranscriptPart(part, {
                unwrapAdvisorTask: options.unwrapAdvisorTask && role === "user",
                unwrapCurrentTask: role === "user",
              }),
            )
          : [
              normalizeTranscriptPart(content, {
                unwrapAdvisorTask: options.unwrapAdvisorTask && role === "user",
                unwrapCurrentTask: role === "user",
              }),
            ],
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

function toolResultStatuses(
  messages: PiMessage[],
): Map<string, ConversationActivityStatus> {
  const statuses = new Map<string, ConversationActivityStatus>();
  for (const message of messages) {
    const record = message as unknown as Record<string, unknown>;
    if (record.role !== "toolResult" || typeof record.toolCallId !== "string") {
      continue;
    }
    statuses.set(record.toolCallId, record.isError ? "error" : "completed");
  }
  return statuses;
}

function activityPayloadFields(
  args: unknown,
  canExposePayload: boolean,
): ActivityPayloadMetadata & { args?: unknown; redacted?: boolean } {
  if (args === undefined) {
    return {};
  }
  return canExposePayload
    ? { args }
    : { redacted: true, ...redactedPayloadFields("input", args) };
}

/**
 * Build the current-run activity timeline from durable agent steps.
 *
 * Tool executions, subagent starts/ends, and their nesting are derived from the
 * conversation's `junior_agent_steps` rows instead of the legacy Redis session
 * log; tool statuses come from the aligned `pi_message` tool results. Redaction
 * stays byte-compatible with the prior session-log path.
 */
function buildConversationActivityFromSteps(args: {
  canExposePayload: boolean;
  steps: StoredAgentStep[];
  messages: PiMessage[];
}): ConversationActivityReport[] {
  const toolStatuses = toolResultStatuses(args.messages);
  const subagentEnds = new Map<string, SubagentEndedStep>();
  const subagentsByToolCallId = new Map<
    string,
    ConversationSubagentActivityReport[]
  >();
  const orphanSubagents: ConversationSubagentActivityReport[] = [];

  for (const step of args.steps) {
    if (step.entry.type === "subagent_ended") {
      subagentEnds.set(
        step.entry.subagentInvocationId,
        step as SubagentEndedStep,
      );
    }
  }

  for (const step of args.steps) {
    if (step.entry.type !== "subagent_started") {
      continue;
    }
    const start = step as SubagentStartedStep;
    const parentStatus = start.entry.parentToolCallId
      ? toolStatuses.get(start.entry.parentToolCallId)
      : undefined;
    const activity = subagentActivityFromSteps(
      start,
      subagentEnds.get(start.entry.subagentInvocationId),
      { canExposeTranscript: args.canExposePayload, parentStatus },
    );
    if (start.entry.parentToolCallId) {
      subagentsByToolCallId.set(start.entry.parentToolCallId, [
        ...(subagentsByToolCallId.get(start.entry.parentToolCallId) ?? []),
        activity,
      ]);
      continue;
    }
    orphanSubagents.push(activity);
  }

  const rows: ConversationActivityReport[] = [];
  for (const step of args.steps) {
    if (step.entry.type !== "tool_execution_started") {
      continue;
    }
    rows.push({
      type: "tool_execution",
      id: step.entry.toolCallId,
      toolCallId: step.entry.toolCallId,
      toolName: step.entry.toolName,
      createdAt: new Date(step.createdAtMs).toISOString(),
      status: toolStatuses.get(step.entry.toolCallId) ?? "running",
      subagents: subagentsByToolCallId.get(step.entry.toolCallId) ?? [],
      ...activityPayloadFields(step.entry.args, args.canExposePayload),
    });
  }

  return [...rows, ...orphanSubagents].sort(
    (left, right) =>
      Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
      left.id.localeCompare(right.id),
  );
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

function subagentTranscriptReport(
  activity: ConversationSubagentActivityReport,
  options: {
    subagentConversationId?: string;
    subagentSentryConversationUrl?: string;
    transcript?: TranscriptMessage[];
    transcriptMessageCount?: number;
    transcriptRedacted?: boolean;
    transcriptRedactionReason?: "non_public_conversation";
    transcriptExpired?: boolean;
    transcriptExpiredAt?: string;
    unavailableReason?: ConversationSubagentTranscriptReport["unavailableReason"];
  } = {},
): ConversationSubagentTranscriptReport {
  return {
    type: "subagent",
    ...(options.subagentConversationId
      ? { subagentConversationId: options.subagentConversationId }
      : {}),
    createdAt: activity.createdAt,
    id: activity.id,
    status: activity.status,
    ...(options.subagentSentryConversationUrl
      ? { subagentSentryConversationUrl: options.subagentSentryConversationUrl }
      : {}),
    subagentKind: activity.subagentKind,
    transcript: options.transcript ?? [],
    transcriptAvailable: Boolean(options.transcript?.length),
    ...(activity.endedAt ? { endedAt: activity.endedAt } : {}),
    ...(activity.outcome ? { outcome: activity.outcome } : {}),
    ...(activity.parentToolCallId
      ? { parentToolCallId: activity.parentToolCallId }
      : {}),
    ...(options.transcriptMessageCount !== undefined
      ? { transcriptMessageCount: options.transcriptMessageCount }
      : {}),
    ...(options.transcriptRedacted
      ? { transcriptRedacted: options.transcriptRedacted }
      : {}),
    ...(options.transcriptRedactionReason
      ? { transcriptRedactionReason: options.transcriptRedactionReason }
      : {}),
    ...(options.transcriptExpired
      ? { transcriptExpired: options.transcriptExpired }
      : {}),
    ...(options.transcriptExpiredAt
      ? { transcriptExpiredAt: options.transcriptExpiredAt }
      : {}),
    ...(options.unavailableReason
      ? { unavailableReason: options.unavailableReason }
      : {}),
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
  const summaries = sampledConversations.map((conversation) =>
    sessionReportFromConversation(conversation, nowMs),
  );
  return buildConversationStatsReport({
    generatedAt,
    nowMs,
    sampleLimit: CONVERSATION_STATS_LIMIT,
    sampleSize: sampledConversations.length,
    summaries,
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
async function currentRunContent(args: {
  conversationId: string;
  messageStore: ConversationMessageStore;
  stepStore: AgentStepStore;
  canExposePayload: boolean;
}): Promise<{
  activity: ConversationActivityReport[];
  transcript: TranscriptMessage[];
}> {
  const steps = await args.stepStore.loadCurrentEpoch(args.conversationId);
  const messages = projectSteps(steps).messages;
  const transcript =
    messages.length > 0
      ? messages.map((message) => normalizeTranscriptMessage(message))
      : (await args.messageStore.list(args.conversationId)).map(
          visibleMessageTranscript,
        );
  return {
    activity: buildConversationActivityFromSteps({
      canExposePayload: args.canExposePayload,
      steps,
      messages,
    }),
    transcript,
  };
}

function visibleMessageTranscript(
  message: ConversationMessage,
): TranscriptMessage {
  return {
    role: message.role,
    timestamp: message.createdAtMs,
    parts: [{ type: "text", text: message.text }],
  };
}

/** Read one conversation transcript for reporting consumers. */
export async function readConversationReport(
  conversationId: string,
  options: ConversationReaderOptions = {},
): Promise<ConversationReport> {
  const store = conversationStore(options);
  const nowMs = Date.now();
  const conversation = await store.get({ conversationId });

  const stepStore = getAgentStepStore();
  const messageStore = options.messageStore ?? getConversationMessageStore();
  const transcriptPurgedAtMs = conversation?.transcriptPurgedAtMs;
  const transcriptExpiredAt =
    transcriptPurgedAtMs !== undefined
      ? new Date(transcriptPurgedAtMs).toISOString()
      : undefined;

  // The activity timeline is the current run's, derived from the current
  // context epoch's durable steps; older epochs stay audit-only. Purged
  // conversations have no steps to read.
  const canExposeSqlContent =
    conversation !== undefined &&
    canExposeConversationPayload({
      conversationId,
      visibility: conversation.visibility,
    });
  const currentContent =
    conversation && transcriptPurgedAtMs === undefined
      ? await currentRunContent({
          conversationId,
          messageStore,
          stepStore,
          canExposePayload: canExposeSqlContent,
        })
      : { activity: [], transcript: [] };

  const currentTranscript = currentContent.transcript;
  const traceId = canExposeSqlContent
    ? traceIdFromTranscript(currentTranscript)
    : undefined;
  const sentryTraceUrl = traceId ? buildSentryTraceUrl(traceId) : undefined;
  const effectiveRuns: ConversationRunReport[] = conversation
    ? [
        {
          ...sessionReportFromConversation(conversation, nowMs),
          ...(traceId ? { traceId } : {}),
          ...(sentryTraceUrl ? { sentryTraceUrl } : {}),
          activity: currentContent.activity,
          transcriptAvailable:
            transcriptExpiredAt === undefined &&
            canExposeSqlContent &&
            currentTranscript.length > 0,
          ...(currentTranscript.length > 0
            ? {
                transcriptMessageCount:
                  countConversationMessages(currentTranscript),
              }
            : {}),
          ...(!canExposeSqlContent && transcriptExpiredAt === undefined
            ? {
                transcriptMetadata: currentTranscript.map(
                  redactTranscriptMessage,
                ),
                transcriptRedacted: true,
                transcriptRedactionReason: "non_public_conversation" as const,
              }
            : {}),
          ...(transcriptExpiredAt !== undefined
            ? {
                transcriptExpired: true,
                transcriptExpiredAt,
                transcriptMetadata: [],
              }
            : {}),
          transcript:
            transcriptExpiredAt === undefined && canExposeSqlContent
              ? currentTranscript
              : [],
        },
      ]
    : [];

  const firstRun = effectiveRuns[0];
  const displayTitle =
    firstRun?.displayTitle ??
    surfaceFallbackLabel(firstRun?.surface ?? "slack");
  const sentryConversationUrl = buildSentryConversationUrl(conversationId);

  return {
    conversationId,
    displayTitle,
    generatedAt: new Date(nowMs).toISOString(),
    ...(sentryConversationUrl ? { sentryConversationUrl } : {}),
    runs: effectiveRuns,
  };
}

type SubagentStartedStep = StoredAgentStep & {
  entry: Extract<AgentStepEntry, { type: "subagent_started" }>;
};
type SubagentEndedStep = StoredAgentStep & {
  entry: Extract<AgentStepEntry, { type: "subagent_ended" }>;
};

function subagentActivityFromSteps(
  start: SubagentStartedStep,
  end: SubagentEndedStep | undefined,
  options: {
    canExposeTranscript?: boolean;
    parentStatus?: ConversationActivityStatus;
  } = {},
): ConversationSubagentActivityReport {
  return {
    type: "subagent",
    id: start.entry.subagentInvocationId,
    subagentKind: start.entry.subagentKind,
    ...(start.entry.parentToolCallId
      ? { parentToolCallId: start.entry.parentToolCallId }
      : {}),
    createdAt: new Date(start.createdAtMs).toISOString(),
    ...(end
      ? {
          endedAt: new Date(end.createdAtMs).toISOString(),
          outcome: end.entry.outcome,
          status: end.entry.outcome,
          // Every subagent is a child conversation whose transcript loads on
          // demand; expose the affordance only when the parent is public.
          ...(options.canExposeTranscript ? { transcriptAvailable: true } : {}),
        }
      : { status: options.parentStatus ?? "running" }),
  };
}

/**
 * Read one child-agent transcript through its parent conversation.
 *
 * The parent records `subagent_started`/`subagent_ended` as durable steps that
 * name the child by `childConversationId`; the transcript is the child
 * conversation's own projected Pi messages. `runId` is retained for the route
 * signature but no longer scopes the lookup — subagent steps live on the parent
 * conversation regardless of the run that produced them.
 */
export async function readConversationSubagentTranscriptReport(
  conversationId: string,
  _runId: string,
  subagentId: string,
  options: ConversationReaderOptions = {},
): Promise<ConversationSubagentTranscriptReport> {
  const store = conversationStore(options);
  const stepStore = getAgentStepStore();
  const [conversation, parentSteps] = await Promise.all([
    store.get({ conversationId }),
    stepStore.loadHistory(conversationId),
  ]);

  // Retention purge deletes the parent tree's steps wholesale; present the
  // subagent as expired rather than "not found" (data-redaction-policy.md).
  if (conversation?.transcriptPurgedAtMs !== undefined) {
    return {
      type: "subagent",
      createdAt: new Date(0).toISOString(),
      id: subagentId,
      status: "completed",
      subagentKind: "unknown",
      transcript: [],
      transcriptAvailable: false,
      transcriptExpired: true,
      transcriptExpiredAt: new Date(
        conversation.transcriptPurgedAtMs,
      ).toISOString(),
    };
  }

  const start = parentSteps.find(
    (step): step is SubagentStartedStep =>
      step.entry.type === "subagent_started" &&
      step.entry.subagentInvocationId === subagentId,
  );
  if (!start) {
    return {
      type: "subagent",
      createdAt: new Date(0).toISOString(),
      id: subagentId,
      status: "error",
      subagentKind: "unknown",
      transcript: [],
      transcriptAvailable: false,
      unavailableReason: "not_found",
    };
  }
  const end = parentSteps.find(
    (step): step is SubagentEndedStep =>
      step.entry.type === "subagent_ended" &&
      step.entry.subagentInvocationId === subagentId,
  );

  const childConversationId = start.entry.childConversationId;
  const activity = subagentActivityFromSteps(start, end);
  const subagentSentryConversationUrl =
    buildSentryConversationUrl(childConversationId);
  const conversationFields = {
    subagentConversationId: childConversationId,
    ...(subagentSentryConversationUrl ? { subagentSentryConversationUrl } : {}),
  };

  const canExposeTranscript = canExposeConversationPayload({
    conversationId,
    visibility: conversation?.visibility,
  });
  if (!canExposeTranscript) {
    return subagentTranscriptReport(activity, {
      ...conversationFields,
      transcriptRedacted: true,
      transcriptRedactionReason: "non_public_conversation",
    });
  }

  const childMessages: PiMessage[] = await loadProjection({
    conversationId: childConversationId,
  });
  if (childMessages.length === 0) {
    return subagentTranscriptReport(activity, {
      ...conversationFields,
      unavailableReason: "missing_transcript_ref",
    });
  }

  const transcript = childMessages.map((message) =>
    normalizeTranscriptMessage(message, {
      unwrapAdvisorTask: activity.subagentKind === "advisor",
    }),
  );
  return subagentTranscriptReport(activity, {
    ...conversationFields,
    transcript,
    transcriptMessageCount: countConversationMessages(transcript),
  });
}
