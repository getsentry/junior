import { readFileSync } from "node:fs";
import path from "node:path";
import { isRecord } from "@/chat/coerce";
import { homeDir } from "@/chat/discovery";
import type { PiMessage } from "@/chat/pi/messages";
import type { AgentTurnUsage } from "@/chat/usage";
import {
  getPluginPackageContent,
  getPluginProviders,
} from "@/chat/plugins/registry";
import { discoverSkills } from "@/chat/skills";
import { parseSlackThreadId } from "@/chat/slack/context";
import {
  buildSentryConversationUrl,
  buildSentryTraceUrl,
} from "@/chat/sentry-links";
import {
  formatSlackConversationRedactedLabel,
  resolveSlackConversationContextFromThreadId,
} from "@/chat/slack/conversation-context";
import {
  canExposeConversationPayload,
  resolveConversationPrivacy,
} from "@/chat/conversation-privacy";
import {
  getAgentTurnSessionRecord,
  listAgentTurnSessionSummaries,
  listAgentTurnSessionSummariesForConversation,
  type AgentTurnRequester,
  type AgentTurnSurface,
  type AgentTurnSessionSummary,
} from "@/chat/state/turn-session";
import { buildSystemPrompt } from "@/chat/prompt";
import { GET as healthGET } from "@/handlers/health";
import { getAgentPluginOperationalReports } from "@/chat/plugins/agent-hooks";
import type { PluginOperationalReport } from "@sentry/junior-plugin-api";

const HUNG_TURN_PROGRESS_MS = 5 * 60 * 1000;
const SAFE_METADATA_KEY_LIMIT = 20;
const PRIVATE_CONVERSATION_LABEL = "Private Conversation";
const DASHBOARD_SESSION_FEED_LIMIT = 50;
const DASHBOARD_CONVERSATION_STATS_LIMIT = 5_000;
const RECENT_CONVERSATION_STATS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface HealthReport {
  status: "ok";
  service: string;
  timestamp: string;
}

export interface PluginReport {
  name: string;
}

export interface SkillReport {
  name: string;
  pluginProvider?: string;
}

export interface RuntimeInfoReport {
  cwd: string;
  homeDir: string;
  descriptionText?: string;
  providers: string[];
  skills: SkillReport[];
  packagedContent: ReturnType<typeof getPluginPackageContent>;
}

export type DashboardSessionStatus =
  | "active"
  | "completed"
  | "failed"
  | "hung"
  | "superseded";

export type DashboardSurface = AgentTurnSurface;

export interface DashboardTurnUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheCreationTokens?: number;
  totalTokens?: number;
}

export interface DashboardRequesterIdentity {
  email?: string;
  fullName?: string;
  slackUserId?: string;
  slackUserName?: string;
}

export interface DashboardSessionReport {
  conversationTitle?: string;
  cumulativeDurationMs: number;
  cumulativeUsage?: DashboardTurnUsage;
  conversationId: string;
  id: string;
  status: DashboardSessionStatus;
  startedAt: string;
  lastSeenAt: string;
  lastProgressAt: string;
  completedAt?: string;
  surface: DashboardSurface;
  title: string;
  requesterIdentity?: DashboardRequesterIdentity;
  channel?: string;
  channelName?: string;
  sentryConversationUrl?: string;
  sentryTraceUrl?: string;
  traceId?: string;
}

export type DashboardTranscriptPartType =
  | "text"
  | "thinking"
  | "tool_call"
  | "tool_result"
  | "unknown";

export interface DashboardTranscriptPart {
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
  type: DashboardTranscriptPartType;
}

export type DashboardTranscriptRole =
  | "assistant"
  | "system"
  | "tool"
  | "toolResult"
  | "unknown"
  | "user";

export interface DashboardTranscriptMessage {
  parts: DashboardTranscriptPart[];
  role: DashboardTranscriptRole;
  timestamp?: number;
}

export interface DashboardTurnReport extends DashboardSessionReport {
  transcriptAvailable: boolean;
  transcriptMetadata?: DashboardTranscriptMessage[];
  transcriptMessageCount?: number;
  transcriptRedacted?: boolean;
  transcriptRedactionReason?: "non_public_conversation";
  transcript: DashboardTranscriptMessage[];
}

export interface DashboardConversationReport {
  conversationId: string;
  generatedAt: string;
  turns: DashboardTurnReport[];
}

export interface DashboardSessionFeed {
  sessions: DashboardSessionReport[];
  source: "turn_session_records";
  generatedAt: string;
}

export interface DashboardConversationStatsItem {
  active: number;
  conversations: number;
  durationMs: number;
  failed: number;
  hung: number;
  label: string;
  tokens?: number;
  turns: number;
}

export interface DashboardConversationStatsReport {
  active: number;
  conversations: number;
  durationMs: number;
  failed: number;
  generatedAt: string;
  hung: number;
  locations: DashboardConversationStatsItem[];
  requesters: DashboardConversationStatsItem[];
  sampleLimit: number;
  sampleSize: number;
  source: "turn_session_records";
  tokens?: number;
  truncated: boolean;
  turns: number;
  windowEnd: string;
  windowStart: string;
}

export type { PluginOperationalReport } from "@sentry/junior-plugin-api";

export interface PluginOperationalReportFeed {
  generatedAt: string;
  reports: PluginOperationalReport[];
  source: "trusted_plugins";
}

export interface JuniorReporting {
  /** Read the public runtime health snapshot without exposing discovery data. */
  getHealth(): Promise<HealthReport>;
  /** Read authenticated dashboard runtime discovery data. */
  getRuntimeInfo(): Promise<RuntimeInfoReport>;
  /** Read configured plugin names for authenticated dashboard views. */
  getPlugins(): Promise<PluginReport[]>;
  /** Read discovered skill names for authenticated dashboard views. */
  getSkills(): Promise<SkillReport[]>;
  /**
   * Read recent turn metadata for authenticated dashboard views.
   *
   * Keep this API trace-shaped: callers should rely on timestamps, status,
   * actor, route, usage, and links that can later be reconstructed from spans.
   */
  getSessions(): Promise<DashboardSessionFeed>;
  /** Read aggregate conversation stats for authenticated dashboard views. */
  getConversationStats?(): Promise<DashboardConversationStatsReport>;
  /** Read sanitized operational summaries contributed by trusted plugins. */
  getPluginOperationalReports?(): Promise<PluginOperationalReportFeed>;
  /**
   * Read one conversation transcript for the dashboard.
   *
   * The current implementation joins turn-session records with expiring session
   * logs, but the API should stay compatible with a future Sentry trace-history
   * source. Avoid adding fields that require Redis-only transcript internals.
   */
  getConversation(conversationId: string): Promise<DashboardConversationReport>;
}

function readDescriptionText(): string | undefined {
  try {
    const raw = readFileSync(
      path.join(homeDir(), "DESCRIPTION.md"),
      "utf8",
    ).trim();
    return raw || undefined;
  } catch {
    return undefined;
  }
}

async function readHealth(): Promise<HealthReport> {
  const res = healthGET();
  return (await res.json()) as HealthReport;
}

async function readSkills(): Promise<SkillReport[]> {
  const skills = await discoverSkills();
  return skills.map((skill) => ({
    name: skill.name,
    pluginProvider: skill.pluginProvider,
  }));
}

async function readPlugins(): Promise<PluginReport[]> {
  return getPluginProviders().map((plugin) => ({
    name: plugin.manifest.name,
  }));
}

function statusFromCheckpoint(
  summary: AgentTurnSessionSummary,
  nowMs = Date.now(),
): DashboardSessionReport["status"] {
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

function surfaceFromConversationId(conversationId: string): DashboardSurface {
  if (parseSlackThreadId(conversationId)) return "slack";
  if (conversationId.startsWith("scheduler:")) return "scheduler";
  if (conversationId.startsWith("api:")) return "api";
  return "internal";
}

function surfaceFromSummary(
  summary: AgentTurnSessionSummary,
): DashboardSurface {
  return summary.surface ?? surfaceFromConversationId(summary.conversationId);
}

function titleFromSummary(summary: AgentTurnSessionSummary): string {
  if (summary.state === "awaiting_resume" && summary.resumeReason) {
    return `Awaiting ${summary.resumeReason} resume`;
  }
  return `Turn ${summary.sessionId}`;
}

function requesterIdentityReport(
  requester: AgentTurnRequester | undefined,
): DashboardRequesterIdentity | undefined {
  if (!requester) return undefined;
  const identity: DashboardRequesterIdentity = {
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

function turnUsageReport(
  usage: AgentTurnUsage | undefined,
): DashboardTurnUsage | undefined {
  if (!usage) return undefined;
  const report: DashboardTurnUsage = {
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

function sessionReportFromSummary(
  summary: AgentTurnSessionSummary,
  nowMs = Date.now(),
): DashboardSessionReport {
  const slackThread = parseSlackThreadId(summary.conversationId);
  const privacy = resolveConversationPrivacy({
    conversationId: summary.conversationId,
  });
  const slackConversation = resolveSlackConversationContextFromThreadId({
    threadId: summary.conversationId,
    channelName: summary.channelName,
  });
  const privateLabel =
    privacy !== "public"
      ? slackConversation
        ? formatSlackConversationRedactedLabel(slackConversation)
        : PRIVATE_CONVERSATION_LABEL
      : undefined;
  const conversationTitle = privateLabel ?? summary.conversationTitle;
  const channelName = privateLabel ?? summary.channelName;
  const sentryConversationUrl = buildSentryConversationUrl(
    summary.conversationId,
  );
  const sentryTraceUrl = summary.traceId
    ? buildSentryTraceUrl(summary.traceId)
    : undefined;
  const requesterIdentity = requesterIdentityReport(summary.requester);
  const cumulativeUsage = turnUsageReport(summary.cumulativeUsage);
  return {
    conversationId: summary.conversationId,
    ...(conversationTitle ? { conversationTitle } : {}),
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
    surface: surfaceFromSummary(summary),
    title: titleFromSummary(summary),
    ...(requesterIdentity ? { requesterIdentity } : {}),
    ...(slackThread ? { channel: slackThread.channelId } : {}),
    ...(channelName ? { channelName } : {}),
    ...(sentryConversationUrl ? { sentryConversationUrl } : {}),
    ...(summary.traceId ? { traceId: summary.traceId } : {}),
    ...(sentryTraceUrl ? { sentryTraceUrl } : {}),
  };
}

function reportTime(value: string): number | undefined {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
}

function usageTokenTotal(
  usage: DashboardTurnUsage | undefined,
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

type TurnContribution = {
  durationMs: number;
  tokens?: number;
  turn: DashboardSessionReport;
};

function turnDurationSnapshot(
  turn: DashboardSessionReport,
): number | undefined {
  return typeof turn.cumulativeDurationMs === "number" &&
    Number.isFinite(turn.cumulativeDurationMs)
    ? Math.max(0, Math.floor(turn.cumulativeDurationMs))
    : undefined;
}

function turnContributions(
  turns: DashboardSessionReport[],
): TurnContribution[] {
  let previousDuration = 0;
  let previousTokens = 0;
  return turns.map((turn) => {
    const duration = turnDurationSnapshot(turn);
    const tokens = usageTokenTotal(turn.cumulativeUsage);
    const contribution: TurnContribution = {
      durationMs:
        duration === undefined ? 0 : Math.max(0, duration - previousDuration),
      turn,
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

function contributionDurationTotal(contributions: TurnContribution[]): number {
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
  contributions: TurnContribution[],
): number | undefined {
  return contributions.reduce(
    (sum, contribution) => addTokenTotal(sum, contribution.tokens),
    undefined as number | undefined,
  );
}

function requesterLabel(
  requester: DashboardRequesterIdentity | undefined,
): string | undefined {
  const email = requester?.email?.trim() || undefined;
  const fullName = requester?.fullName?.trim() || undefined;
  const slackUserName = requester?.slackUserName?.trim() || undefined;
  return email ?? fullName ?? slackUserName ?? requester?.slackUserId;
}

function slackStatsLocationLabel(
  input: Pick<DashboardSessionReport, "channel" | "channelName">,
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

function locationLabel(turn: DashboardSessionReport): string {
  return (
    slackStatsLocationLabel(turn) ??
    (turn.surface === "scheduler"
      ? "Scheduler"
      : turn.surface === "api"
        ? "API"
        : turn.surface === "internal"
          ? "Internal"
          : "Unknown")
  );
}

function emptyStatsItem(label: string): DashboardConversationStatsItem {
  return {
    active: 0,
    conversations: 0,
    durationMs: 0,
    failed: 0,
    hung: 0,
    label,
    turns: 0,
  };
}

function addItemTokens(
  item: DashboardConversationStatsItem,
  tokens: number | undefined,
): void {
  if (tokens !== undefined) {
    item.tokens = (item.tokens ?? 0) + tokens;
  }
}

function statusSignals(turns: DashboardSessionReport[]) {
  return {
    active: turns.some((turn) => turn.status === "active"),
    failed: turns.some((turn) => turn.status === "failed"),
    hung: turns.some((turn) => turn.status === "hung"),
  };
}

function statsItems(map: Map<string, DashboardConversationStatsItem>) {
  return [...map.values()].sort(
    (left, right) =>
      right.conversations - left.conversations ||
      right.durationMs - left.durationMs ||
      left.label.localeCompare(right.label),
  );
}

function newestTurn(turns: DashboardSessionReport[]): DashboardSessionReport {
  return [...turns].sort(
    (left, right) =>
      (reportTime(right.lastSeenAt) ?? 0) -
        (reportTime(left.lastSeenAt) ?? 0) || right.id.localeCompare(left.id),
  )[0]!;
}

function recentConversationGroups(args: {
  nowMs: number;
  sessions: DashboardSessionReport[];
}): DashboardSessionReport[][] {
  const startMs = args.nowMs - RECENT_CONVERSATION_STATS_WINDOW_MS;
  const groups = new Map<string, DashboardSessionReport[]>();
  for (const session of args.sessions) {
    groups.set(session.conversationId, [
      ...(groups.get(session.conversationId) ?? []),
      session,
    ]);
  }

  return [...groups.values()]
    .map((turns) =>
      [...turns].sort(
        (left, right) =>
          (reportTime(left.startedAt) ?? 0) -
            (reportTime(right.startedAt) ?? 0) ||
          left.id.localeCompare(right.id),
      ),
    )
    .filter((turns) => {
      const activityAt = reportTime(newestTurn(turns).lastSeenAt);
      return (
        activityAt !== undefined &&
        activityAt >= startMs &&
        activityAt <= args.nowMs
      );
    });
}

function conversationDurationMs(turns: DashboardSessionReport[]): number {
  if (!turns.some((turn) => turnDurationSnapshot(turn) !== undefined)) {
    return 0;
  }
  return contributionDurationTotal(turnContributions(turns));
}

function buildConversationStatsReport(args: {
  generatedAt: string;
  nowMs: number;
  sampleLimit: number;
  sampleSize: number;
  sessions: DashboardSessionReport[];
  truncated: boolean;
}): DashboardConversationStatsReport {
  const conversations = recentConversationGroups(args);
  const requesters = new Map<string, DashboardConversationStatsItem>();
  const locations = new Map<string, DashboardConversationStatsItem>();
  let durationMs = 0;
  let tokens: number | undefined;
  let active = 0;
  let failed = 0;
  let hung = 0;

  for (const turns of conversations) {
    const contributions = turnContributions(turns);
    const conversationSignals = statusSignals(turns);
    const conversationTokens = contributionTokenTotal(contributions);
    durationMs += contributionDurationTotal(contributions);
    tokens = addTokenTotal(tokens, conversationTokens);
    active += conversationSignals.active ? 1 : 0;
    failed += conversationSignals.failed ? 1 : 0;
    hung += conversationSignals.hung ? 1 : 0;

    const requesterTurns = new Map<string, TurnContribution[]>();
    for (const contribution of contributions) {
      const requester =
        requesterLabel(contribution.turn.requesterIdentity) ?? "Unknown";
      requesterTurns.set(requester, [
        ...(requesterTurns.get(requester) ?? []),
        contribution,
      ]);
    }

    for (const [requester, requesterContributions] of requesterTurns) {
      const item = requesters.get(requester) ?? emptyStatsItem(requester);
      const signals = statusSignals(
        requesterContributions.map((contribution) => contribution.turn),
      );
      item.conversations += 1;
      item.turns += requesterContributions.length;
      item.durationMs += contributionDurationTotal(requesterContributions);
      item.active += signals.active ? 1 : 0;
      item.failed += signals.failed ? 1 : 0;
      item.hung += signals.hung ? 1 : 0;
      addItemTokens(item, contributionTokenTotal(requesterContributions));
      requesters.set(requester, item);
    }

    const location = locationLabel(newestTurn(turns));
    const locationItem = locations.get(location) ?? emptyStatsItem(location);
    locationItem.conversations += 1;
    locationItem.turns += turns.length;
    locationItem.durationMs += conversationDurationMs(turns);
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
    source: "turn_session_records",
    ...(tokens !== undefined ? { tokens } : {}),
    truncated: args.truncated,
    turns: conversations.reduce((sum, turns) => sum + turns.length, 0),
    windowEnd: new Date(args.nowMs).toISOString(),
    windowStart: new Date(
      args.nowMs - RECENT_CONVERSATION_STATS_WINDOW_MS,
    ).toISOString(),
  };
}

async function completeSampledConversationSummaries(args: {
  summaries: AgentTurnSessionSummary[];
  truncated: boolean;
}): Promise<AgentTurnSessionSummary[]> {
  if (!args.truncated) {
    return args.summaries;
  }

  const conversationIds = [
    ...new Set(args.summaries.map((summary) => summary.conversationId)),
  ];
  const groups = await Promise.all(
    conversationIds.map((conversationId) =>
      listAgentTurnSessionSummariesForConversation(conversationId),
    ),
  );
  const summariesByTurn = new Map<string, AgentTurnSessionSummary>();
  for (const group of groups) {
    for (const summary of group) {
      summariesByTurn.set(
        `${summary.conversationId}:${summary.sessionId}`,
        summary,
      );
    }
  }

  return [...summariesByTurn.values()].sort(
    (left, right) => right.updatedAtMs - left.updatedAtMs,
  );
}

function canExposeConversationTranscript(
  summary: AgentTurnSessionSummary,
): boolean {
  return canExposeConversationPayload({
    conversationId: summary.conversationId,
  });
}

function textPart(text: string): DashboardTranscriptPart {
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

function normalizeTranscriptPart(part: unknown): DashboardTranscriptPart {
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
): DashboardTranscriptPart {
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
): DashboardTranscriptMessage {
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

function transcriptRole(role: unknown): DashboardTranscriptRole {
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

function redactTranscriptPart(
  part: DashboardTranscriptPart,
): DashboardTranscriptPart {
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
  message: DashboardTranscriptMessage,
): DashboardTranscriptMessage {
  return {
    role: message.role,
    ...(typeof message.timestamp === "number"
      ? { timestamp: message.timestamp }
      : {}),
    parts: message.parts.map(redactTranscriptPart),
  };
}

function isConversationMessageRole(role: DashboardTranscriptRole): boolean {
  return role === "user" || role === "assistant";
}

function hasTextPart(message: DashboardTranscriptMessage): boolean {
  return message.parts.some((part) => {
    if (part.type !== "text") return false;
    if (part.redacted) return true;
    return typeof part.text === "string" && part.text.trim().length > 0;
  });
}

function isConversationMessage(message: DashboardTranscriptMessage): boolean {
  if (!isConversationMessageRole(message.role)) return false;
  if (message.role === "assistant") return hasTextPart(message);
  return message.parts.length > 0;
}

function countConversationMessages(
  transcript: DashboardTranscriptMessage[],
): number {
  return transcript.filter(isConversationMessage).length;
}

/** Build the synthetic system-prompt message shown only at a run boundary. */
function systemPromptMessage(): DashboardTranscriptMessage {
  return {
    role: "system",
    parts: [{ type: "text", text: buildSystemPrompt() }],
  };
}

interface ScopedTurnMessages {
  messages: PiMessage[];
  startsAtRunBoundary: boolean;
}

function turnScopedMessages(messages: PiMessage[]): ScopedTurnMessages {
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
  transcript: DashboardTranscriptMessage[],
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

async function readSessions(): Promise<DashboardSessionFeed> {
  const nowMs = Date.now();
  const summaries = await listAgentTurnSessionSummaries(
    DASHBOARD_SESSION_FEED_LIMIT,
  );
  return {
    source: "turn_session_records",
    generatedAt: new Date(nowMs).toISOString(),
    sessions: summaries.map((summary) =>
      sessionReportFromSummary(summary, nowMs),
    ),
  };
}

async function readConversationStats(): Promise<DashboardConversationStatsReport> {
  const nowMs = Date.now();
  const generatedAt = new Date(nowMs).toISOString();
  const summaries = await listAgentTurnSessionSummaries(
    DASHBOARD_CONVERSATION_STATS_LIMIT + 1,
  );
  const truncated = summaries.length >= DASHBOARD_CONVERSATION_STATS_LIMIT;
  const sampledSummaries = summaries.slice(
    0,
    DASHBOARD_CONVERSATION_STATS_LIMIT,
  );
  const reportSummaries = await completeSampledConversationSummaries({
    summaries: sampledSummaries,
    truncated,
  });
  return buildConversationStatsReport({
    generatedAt,
    nowMs,
    sampleLimit: DASHBOARD_CONVERSATION_STATS_LIMIT,
    sampleSize: sampledSummaries.length,
    sessions: reportSummaries.map((summary) =>
      sessionReportFromSummary(summary, nowMs),
    ),
    truncated,
  });
}

async function readPluginOperationalReports(): Promise<PluginOperationalReportFeed> {
  const nowMs = Date.now();
  return {
    source: "trusted_plugins",
    generatedAt: new Date(nowMs).toISOString(),
    reports: await getAgentPluginOperationalReports(nowMs),
  };
}

async function readConversation(
  conversationId: string,
): Promise<DashboardConversationReport> {
  const summaries = (
    await listAgentTurnSessionSummariesForConversation(conversationId)
  ).sort(
    (left, right) =>
      left.startedAtMs - right.startedAtMs ||
      left.updatedAtMs - right.updatedAtMs ||
      left.sessionId.localeCompare(right.sessionId),
  );

  const turns = await Promise.all(
    summaries.map(async (summary): Promise<DashboardTurnReport> => {
      const sessionRecord = await getAgentTurnSessionRecord(
        summary.conversationId,
        summary.sessionId,
      );
      const scopedMessages = sessionRecord?.piMessages
        ? turnScopedMessages(sessionRecord.piMessages)
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
            normalizedTranscript.length > 0
              ? [systemPromptMessage()]
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
      return {
        ...sessionReportFromSummary(summary),
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
    }),
  );

  return {
    conversationId,
    generatedAt: new Date().toISOString(),
    turns,
  };
}

/** Create the read-only reporting boundary used by authenticated dashboard routes. */
export function createJuniorReporting(): JuniorReporting & {
  getConversationStats(): Promise<DashboardConversationStatsReport>;
  getPluginOperationalReports(): Promise<PluginOperationalReportFeed>;
} {
  return {
    getHealth: readHealth,
    async getRuntimeInfo() {
      const [plugins, skills] = await Promise.all([
        readPlugins(),
        readSkills(),
      ]);

      return {
        cwd: process.cwd(),
        homeDir: homeDir(),
        descriptionText: readDescriptionText(),
        providers: plugins.map((plugin) => plugin.name),
        skills,
        packagedContent: getPluginPackageContent(),
      };
    },
    getPlugins: readPlugins,
    getSkills: readSkills,
    getSessions: readSessions,
    getConversationStats: readConversationStats,
    getPluginOperationalReports: readPluginOperationalReports,
    getConversation: readConversation,
  };
}
