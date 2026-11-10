import type { BundledLanguage } from "shiki/bundle/web";
import type {
  ActorIdentity,
  ConversationAuxiliaryCosts,
  ConversationFeedItem,
  ConversationModelUsage,
  ConversationSummaryReport,
  ConversationUsage,
} from "@sentry/junior/api/schema";
import type {
  Conversation,
  ConversationTranscript,
  TranscriptViewMessage,
  TranscriptViewPart,
  VisualStatus,
} from "./types";
import { getDashboardAgentName } from "./agentName";
import { formatDuration } from "./components/Duration";
import { conversationTranscriptMessages } from "./conversations/eventTranscript";

/** Read the viewer's own browser timezone, used for absolute timestamps and charts. */
export function getDashboardTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}

function isActiveSummary(summary: ConversationSummaryReport): boolean {
  return summary.status === "active";
}

/** Identify summaries that should appear in failed conversation filters. */
export function isFailedConversationSummary(
  summary: ConversationSummaryReport,
): boolean {
  return summary.status === "failed";
}

function isActiveConversation(conversation: Conversation): boolean {
  return conversation.status === "active";
}

/** Whether no work runs: the Conversation finished or a person stopped it. */
export function isIdleConversation(conversation: Conversation): boolean {
  return (
    conversation.status === "completed" || conversation.status === "stopped"
  );
}

function isFailedConversation(conversation: Conversation): boolean {
  return conversation.status === "failed";
}

function parseTime(value: string | undefined): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

/** Format absolute dashboard timestamps in the viewer's browser timezone. */
export function formatTime(
  value: string | undefined,
  options?: Intl.DateTimeFormatOptions,
): string {
  const time = parseTime(value);
  if (time == null) return "none";
  return new Date(time).toLocaleString(undefined, {
    ...options,
    timeZone: getDashboardTimeZone(),
  });
}

/** Format conversation activity timestamps as human-relative recency labels. */
export function formatRelativeTime(value: string | undefined): string {
  const time = parseTime(value);
  if (time == null) return "not updated yet";

  const seconds = Math.round((time - Date.now()) / 1000);
  const absoluteSeconds = Math.abs(seconds);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 60 * 60 * 24 * 365],
    ["month", 60 * 60 * 24 * 30],
    ["week", 60 * 60 * 24 * 7],
    ["day", 60 * 60 * 24],
    ["hour", 60 * 60],
    ["minute", 60],
  ];

  for (const [unit, unitSeconds] of units) {
    if (absoluteSeconds >= unitSeconds) {
      return new Intl.RelativeTimeFormat(undefined, {
        numeric: "auto",
      }).format(Math.round(seconds / unitSeconds), unit);
    }
  }

  return "just now";
}

/** Format millisecond durations for compact transcript metadata. */
export function formatMs(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "none";
  const ms = Math.max(0, Math.floor(value));
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const roundedSeconds = Math.round(seconds);
  const minutes = Math.floor(roundedSeconds / 60);
  const remainingSeconds = roundedSeconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

/** Format a serialized payload size for compact transcript metadata. */
export function formatPayloadSize(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  if (serialized === undefined) return undefined;
  const bytes = new TextEncoder().encode(serialized).byteLength;
  if (bytes < 1_000) return `${bytes}b`;
  return `${Math.round(bytes / 1_000)}kb`;
}

/** Format the elapsed duration between two transcript event timestamps. */
export function formatElapsedDuration(
  startedAt: number | undefined,
  endedAt: number | undefined,
): string | undefined {
  if (
    typeof startedAt !== "number" ||
    typeof endedAt !== "number" ||
    endedAt < startedAt
  ) {
    return undefined;
  }
  return formatMs(endedAt - startedAt);
}

/** Format a persisted conversation runtime when duration data exists. */
export function formatRuntime(durationMs: number | undefined): string {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs)) return "";
  const runtime = Math.max(0, Math.floor(durationMs));
  return runtime === 0 ? "" : formatDuration(runtime);
}

/** Format transcript event timestamps independently from conversation start. */
export function formatMessageTimestamp(
  value: number | undefined,
  includeDate = false,
): string {
  if (typeof value !== "number" || !Number.isFinite(value))
    return "no timestamp";
  const date = new Date(value);
  return includeDate
    ? date.toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "medium",
        timeZone: getDashboardTimeZone(),
      })
    : date.toLocaleTimeString(undefined, {
        timeZone: getDashboardTimeZone(),
      });
}

/** Format a transcript timestamp relative to the current time. */
export function formatRelativeMessageTimestamp(
  value: number | undefined,
): string {
  if (typeof value !== "number" || !Number.isFinite(value))
    return "no timestamp";
  const seconds = Math.round((value - Date.now()) / 1000);
  const absoluteSeconds = Math.abs(seconds);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 60 * 60 * 24 * 365],
    ["month", 60 * 60 * 24 * 30],
    ["week", 60 * 60 * 24 * 7],
    ["day", 60 * 60 * 24],
    ["hour", 60 * 60],
  ];
  const [unit, unitSeconds] =
    units.find(([, threshold]) => absoluteSeconds >= threshold) ??
    units.at(-1)!;
  return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(
    Math.round(seconds / unitSeconds),
    unit,
  );
}

/** Format canonical local and UTC values for a transcript timestamp. */
export function formatTranscriptTimestampDetails(value: number): {
  local: string;
  utc: string;
} {
  const date = new Date(value);
  const options: Intl.DateTimeFormatOptions = {
    dateStyle: "medium",
    timeStyle: "long",
  };
  return {
    local: date.toLocaleString(undefined, {
      ...options,
      timeZone: getDashboardTimeZone(),
    }),
    utc: date.toLocaleString(undefined, { ...options, timeZone: "UTC" }),
  };
}

function formatNumber(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "0";
  const number = Math.max(0, Math.floor(value));
  if (number < 1000) return String(number);

  const units: Array<[string, number]> = [
    ["t", 1_000_000_000_000],
    ["b", 1_000_000_000],
    ["m", 1_000_000],
    ["k", 1_000],
  ];
  const [suffix, divisor] =
    units.find(([, threshold]) => number >= threshold) ?? units[1]!;
  const scaled = number / divisor;
  const formatted =
    scaled >= 100 || Number.isInteger(scaled)
      ? Math.round(scaled).toString()
      : scaled >= 10
        ? Math.round(scaled).toString()
        : (Math.floor(scaled * 10) / 10).toFixed(1).replace(/\.0$/, "");
  return `${formatted}${suffix}`;
}

function getFiniteTokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : undefined;
}

function getUsageComponentTotal(usage: ConversationUsage): number | undefined {
  return [
    usage.inputTokens,
    usage.outputTokens,
    usage.cachedInputTokens,
    usage.cacheCreationTokens,
  ].reduce<number | undefined>((sum, value) => {
    const count = getFiniteTokenCount(value);
    if (count === undefined) return sum;
    return (sum ?? 0) + count;
  }, undefined);
}

function transcriptSource(conversation: ConversationTranscript) {
  return conversationTranscriptMessages(conversation);
}

/** Normalized role category for transcript messages. */
export type TranscriptRoleKind =
  | "assistant"
  | "other"
  | "system"
  | "tool"
  | "user";

/** Normalize a raw transcript role string to a canonical kind. */
export function transcriptRoleKind(role: string): TranscriptRoleKind {
  const normalized = role.toLowerCase();
  if (normalized === "assistant") return "assistant";
  if (normalized === "user") return "user";
  if (normalized === "system") return "system";
  if (normalized.includes("tool")) return "tool";
  return "other";
}

function hasTextPart(
  message: Pick<TranscriptViewMessage, "parts" | "role">,
): boolean {
  return message.parts.some((part) => {
    if (part.type !== "text") return false;
    if (part.redacted) return true;
    return typeof part.text === "string" && part.text.trim().length > 0;
  });
}

function isConversationMessage(
  message: Pick<TranscriptViewMessage, "parts" | "role">,
): boolean {
  const kind = transcriptRoleKind(message.role);
  if (kind !== "user" && kind !== "assistant") return false;
  if (kind === "assistant") return hasTextPart(message);
  return message.parts.length > 0;
}

/** Count visible or redacted message records for a conversation. */
export function conversationMessageCount(
  conversation: ConversationTranscript,
): number {
  return transcriptSource(conversation).filter(isConversationMessage).length;
}

export type ToolCallSummaryItem = {
  count: number;
  name: string;
};

export type ToolCallSummary = {
  items: ToolCallSummaryItem[];
  total: number;
};

/** Summarize normalized tool calls by stable call id. */
export function summarizeToolCalls(
  conversation: ConversationTranscript,
  limit = 5,
): ToolCallSummary {
  const byName = new Map<string, ToolCallSummaryItem>();
  const seen = new Set<string>();
  let total = 0;

  for (const event of conversation.events) {
    if (event.data.type !== "tool_calls") continue;
    for (const call of event.data.calls) {
      if (seen.has(call.toolCallId)) continue;
      seen.add(call.toolCallId);
      const item = byName.get(call.name) ?? {
        count: 0,
        name: call.name,
      };
      item.count += 1;
      byName.set(call.name, item);
      total += 1;
    }
  }

  const items = [...byName.values()]
    .sort(
      (left, right) =>
        right.count - left.count || left.name.localeCompare(right.name),
    )
    .slice(0, limit);

  return { items, total };
}

export type MessageSummaryItem = {
  author: string;
  bytes: number;
};

export type MessageSummary = {
  items: MessageSummaryItem[];
  total: number;
};

/**
 * Return the person who wrote one transcript user message. Child agent input
 * has no person. Other messages fall back to the conversation actor.
 */
export function transcriptMessageActor(
  conversation: ConversationTranscript,
  message: TranscriptViewMessage,
): ActorIdentity | undefined {
  if (transcriptRoleKind(message.role) !== "user") return undefined;
  if (message.agentInvocationId) return undefined;
  const author = message.actorIdentityId
    ? conversation.authors?.[message.actorIdentityId]
    : undefined;
  if (author) return author;
  if (actorLabel(message.actorIdentity)) return message.actorIdentity;
  if (actorLabel(conversation.actorIdentity)) return conversation.actorIdentity;
  return undefined;
}

/** Return the best available actor label for one transcript message. */
export function transcriptMessageActorLabel(
  conversation: ConversationTranscript,
  message: TranscriptViewMessage,
): string {
  const kind = transcriptRoleKind(message.role);
  if (kind === "assistant") return getDashboardAgentName();
  if (kind === "user") {
    // The parent agent wrote this input, and the Turn it starts reports back
    // to the parent. The conversation actor started the child but did not
    // write it, so do not fall back to that actor here.
    if (message.agentInvocationId) return "Parent agent";
    // Show the person's name, not their email. A web send carries both, and
    // its durable Message carries only the name.
    const actor = transcriptMessageActor(conversation, message);
    return actor?.fullName?.trim() || (actorLabel(actor) ?? "User");
  }
  if (kind === "system") return "System";
  if (kind === "tool") return "Tool";
  return message.role || "Unknown";
}

function transcriptPartBytes(part: TranscriptViewPart): number {
  return part.type === "text" && part.text
    ? new TextEncoder().encode(part.text).byteLength
    : 0;
}

/** Summarize conversational messages by author and serialized size. */
export function summarizeMessages(
  conversation: ConversationTranscript,
): MessageSummary {
  const items: MessageSummaryItem[] = [];

  for (const message of transcriptSource(conversation)) {
    if (!isConversationMessage(message)) continue;
    items.push({
      author: transcriptMessageActorLabel(conversation, message),
      bytes: message.parts.reduce(
        (sum, part) => sum + transcriptPartBytes(part),
        0,
      ),
    });
  }

  return { items, total: items.length };
}

/** Count actor-initiated exchanges rather than individual transcript messages. */
export function summarizeTurns(
  conversation: ConversationTranscript,
): MessageSummary | undefined {
  const messages = transcriptSource(conversation);
  const userMessages = messages.filter(
    (message) =>
      transcriptRoleKind(message.role) === "user" &&
      isConversationMessage(message),
  );
  if (userMessages.length > 0) {
    return {
      items: userMessages.map((message) => ({
        author: transcriptMessageActorLabel(conversation, message),
        bytes: message.parts.reduce(
          (sum, part) => sum + transcriptPartBytes(part),
          0,
        ),
      })),
      total: userMessages.length,
    };
  }

  return undefined;
}

/** Format raw counts with the dashboard's compact number rules. */
export function formatCompactNumber(value: number | undefined): string {
  return formatNumber(value);
}

/**
 * Format a chart-bucket average for the dashed average guide.
 * Keeps one decimal below 10 so fractional daily means do not collapse to "0".
 */
export function formatActivityChartAverage(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return "0";
  }
  if (value < 10) {
    return (Math.round(value * 10) / 10).toFixed(1).replace(/\.0$/, "");
  }
  return formatCompactNumber(value);
}

export type TokenUsageSummary = {
  cachedInputTokens?: number;
  cacheCreationTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  providerTotalTokens?: number;
  reasoningTokens?: number;
  totalTokens: number;
};

export type CostUsageSummary = {
  cacheRead?: number;
  cacheWrite?: number;
  input?: number;
  output?: number;
  total: number;
};

/** Summarize token usage without double-counting provider total fields. */
export function summarizeUsage(
  usage: ConversationUsage | undefined,
): TokenUsageSummary | undefined {
  if (!usage) return undefined;
  const summary: TokenUsageSummary = { totalTokens: 0 };

  summary.reasoningTokens = getFiniteTokenCount(usage.reasoningTokens);
  const componentTotal = getUsageComponentTotal(usage);
  if (componentTotal !== undefined) {
    summary.totalTokens = componentTotal;
    summary.inputTokens = getFiniteTokenCount(usage.inputTokens);
    summary.outputTokens = getFiniteTokenCount(usage.outputTokens);
    summary.cachedInputTokens = getFiniteTokenCount(usage.cachedInputTokens);
    summary.cacheCreationTokens = getFiniteTokenCount(
      usage.cacheCreationTokens,
    );
  } else {
    const providerTotal = getFiniteTokenCount(usage.totalTokens);
    if (providerTotal !== undefined) {
      summary.totalTokens = providerTotal;
      summary.providerTotalTokens = providerTotal;
    }
  }

  return summary.totalTokens > 0 ? summary : undefined;
}

/** Sum model token components for a conversation detail. */
export function summarizeModelUsage(
  modelUsage: ConversationModelUsage[] | undefined,
): TokenUsageSummary | undefined {
  if (!modelUsage?.length) return undefined;
  const summary: TokenUsageSummary = { totalTokens: 0 };
  for (const item of modelUsage) {
    const model = summarizeUsage(item.usage);
    if (!model) continue;
    summary.totalTokens += model.totalTokens;
    for (const field of [
      "inputTokens",
      "outputTokens",
      "cachedInputTokens",
      "cacheCreationTokens",
      "reasoningTokens",
    ] as const) {
      const value = model[field];
      if (value !== undefined) summary[field] = (summary[field] ?? 0) + value;
    }
  }
  return summary.totalTokens > 0 ? summary : undefined;
}

/** Format total token usage for compact metadata. */
export function formatTokenSummary(
  summary: TokenUsageSummary | undefined,
): string {
  return summary ? `${formatNumber(summary.totalTokens)} tokens` : "";
}

/** Format the persisted cumulative token count for a conversation. */
export function formatUsageTotal(usage: ConversationUsage | undefined): string {
  return formatTokenSummary(summarizeUsage(usage));
}

function getFiniteCost(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function addCost(left: number, right: number): number {
  return Math.round((left + right) * 1e12) / 1e12;
}

/** Summarize persisted cumulative Pi model cost for a conversation. */
export function summarizeCost(
  usage: ConversationUsage | undefined,
): CostUsageSummary | undefined {
  if (!usage?.cost) return undefined;
  const summary: CostUsageSummary = { total: 0 };
  const cost = usage.cost;
  const total = getFiniteCost(cost.total);
  const components = {
    input: getFiniteCost(cost.input),
    output: getFiniteCost(cost.output),
    cacheRead: getFiniteCost(cost.cacheRead),
    cacheWrite: getFiniteCost(cost.cacheWrite),
  };
  const componentTotal = Object.values(components).reduce<number>(
    (sum, value) => sum + (value ?? 0),
    0,
  );
  summary.total = addCost(summary.total, total ?? componentTotal);
  summary.input = components.input;
  summary.output = components.output;
  summary.cacheRead = components.cacheRead;
  summary.cacheWrite = components.cacheWrite;
  return total !== undefined || componentTotal > 0 ? summary : undefined;
}

/** Sum the model costs shown in a Conversation's breakdown. */
export function summarizeModelCost(
  modelUsage: ConversationModelUsage[] | undefined,
): CostUsageSummary | undefined {
  let total: number | undefined;
  for (const item of modelUsage ?? []) {
    const summary = summarizeCost(item.usage);
    if (summary) total = addCost(total ?? 0, summary.total);
  }
  return total === undefined ? undefined : { total };
}

/** Format estimated model cost in USD for consistent dashboard display. */
export function formatCostSummary(
  summary: CostUsageSummary | undefined,
): string {
  if (!summary) return "";
  const maximumFractionDigits =
    summary.total > 0 && summary.total < 0.01 ? 4 : 2;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits,
  }).format(summary.total);
}

/** Format tooltip cost detail without hiding sub-cent contributions. */
export function formatCostBreakdown(
  summary: CostUsageSummary | undefined,
): string {
  if (!summary) return "";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(summary.total);
}

/** Format persisted cumulative estimated model cost for a conversation. */
export function formatCostTotal(usage: ConversationUsage | undefined): string {
  return formatCostSummary(summarizeCost(usage));
}

/** Combine agent model cost with additive auxiliary operation cost. */
export function totalConversationCost(
  summary: CostUsageSummary | undefined,
  auxiliaryCosts: ConversationAuxiliaryCosts | undefined,
): CostUsageSummary | undefined {
  if (!summary && !auxiliaryCosts) return undefined;
  return {
    ...summary,
    total: addCost(summary?.total ?? 0, auxiliaryCosts?.costUsd ?? 0),
  };
}

/** Format the inclusive cost of agent and auxiliary conversation work. */
export function formatConversationCostTotal(
  usage: ConversationUsage | undefined,
  auxiliaryCosts: ConversationAuxiliaryCosts | undefined,
): string {
  return formatCostSummary(
    totalConversationCost(summarizeCost(usage), auxiliaryCosts),
  );
}

/** Format the execution time accumulated across a conversation's runs. */
export function formatTranscriptDuration(
  conversation: Pick<ConversationTranscript, "cumulativeDurationMs">,
): string {
  return formatRuntime(conversation.cumulativeDurationMs) || "none";
}

/** Format the execution time accumulated across a conversation's runs. */
export function formatConversationDuration(conversation: Conversation): string {
  return formatRuntime(conversation.cumulativeDurationMs) || "none";
}

/** Return the persisted cumulative conversation runtime. */
export function conversationRuntimeMs(
  conversation: Pick<Conversation, "cumulativeDurationMs">,
): number | undefined {
  return Number.isFinite(conversation.cumulativeDurationMs)
    ? Math.max(0, Math.floor(conversation.cumulativeDurationMs))
    : undefined;
}

function compareTimeDesc(a: string | undefined, b: string | undefined): number {
  return (parseTime(b) ?? 0) - (parseTime(a) ?? 0);
}

/**
 * Return the title of a loaded Conversation. A Thread has its own title. A
 * Task uses its agent label from the agent tree, because it has no title.
 */
export function conversationDetailTitle(
  detail:
    | Pick<ConversationTranscript, "agentTree" | "displayTitle" | "kind">
    | undefined,
): string | undefined {
  const title = detail?.displayTitle?.trim() || undefined;
  const label = detail?.agentTree?.at(-1)?.label;
  return detail?.kind === "thread" ? (title ?? label) : (label ?? title);
}

/** Return the display title prepared by the reporting API. */
export function conversationDisplayTitle(
  conversation: Conversation | undefined,
): string {
  return conversation?.displayTitle ?? "Conversation";
}

/** Prefer stable actor identifiers while keeping Slack ids as a last resort. */
export function actorLabel(
  actor: ActorIdentity | undefined,
): string | undefined {
  const email = actor?.email?.trim() || undefined;
  const fullName = actor?.fullName?.trim() || undefined;
  const slackUserName = actor?.slackUserName?.trim() || undefined;
  return email ?? fullName ?? slackUserName ?? actor?.slackUserId;
}

/** Derive the label of the root Actor, the person who started the conversation. */
export function conversationActorLabel(
  conversation: Conversation | undefined,
): string | undefined {
  return actorLabel(conversation?.actorIdentity);
}

/** Format the root Actor and permalink id line shared by conversation rows and headers. */
export function conversationIdentityMeta(
  conversation: Conversation | undefined,
  conversationId: string | undefined,
): string {
  const id = conversationId ?? conversation?.id;
  const actor = conversationActorLabel(conversation);
  if (!id) return actor ?? "";
  return actor ? `${actor} · ${id}` : id;
}

/** Convert Slack channel ids and names into user-facing location labels. */
export function slackLocationLabel(
  input: Pick<
    ConversationSummaryReport,
    "channel" | "channelName" | "channelNameRedacted"
  >,
  options: { includeId?: boolean } = {},
): string | undefined {
  const channelId = input.channel;
  if (!channelId) return undefined;

  const includeId = options.includeId ?? true;
  const idSuffix = includeId ? ` (${channelId})` : "";
  if (input.channelNameRedacted && input.channelName) {
    return `${input.channelName}${idSuffix}`;
  }
  const name = input.channelName?.replace(/^#/, "");
  if (channelId.startsWith("D")) {
    return `Direct Message${idSuffix}`;
  }

  if (channelId.startsWith("C")) {
    return name ? `#${name}${idSuffix}` : `Public Channel${idSuffix}`;
  }

  if (channelId.startsWith("G")) {
    if (name?.startsWith("mpdm-")) return `Group DM${idSuffix}`;
    return `Private Channel${idSuffix}`;
  }

  return name ? `${name}${idSuffix}` : channelId;
}

/** Collapse raw summary states into the dashboard's visual status language. */
export function visualStatusForSummary(
  summary: ConversationSummaryReport,
): VisualStatus {
  if (isFailedConversationSummary(summary)) return "failed";
  if (isActiveSummary(summary)) return "active";
  if (summary.status === "stopped") return "stopped";
  return "idle";
}

/** Derive the dashboard status from a conversation record. */
export function visualStatusForConversation(
  conversation: Conversation,
): VisualStatus {
  if (isActiveConversation(conversation)) return "active";
  if (isFailedConversation(conversation)) return "failed";
  if (conversation.status === "stopped") return "stopped";
  return "idle";
}

/** Explain why a transcript body is absent without exposing private content. */
export function unavailableTranscriptLabel(
  conversation: ConversationTranscript,
): string {
  if (conversation.eventHistory.status === "redacted") {
    return "Transcript hidden because this conversation is not public.";
  }
  if (conversation.eventHistory.status === "expired") {
    return "Transcript expired for this conversation.";
  }
  const status = visualStatusForSummary(conversation);
  if (status === "active") {
    return "Transcript pending while this conversation is active.";
  }
  return "Transcript unavailable for this conversation.";
}

/** Build the canonical actor profile route for a trusted email address. */
export function peoplePath(email: string): string {
  return `/people/${encodeURIComponent(email)}`;
}

/** Build the dashboard route for one memory's details. */
export function memoryPath(memoryId: string): string {
  return `/memories/${encodeURIComponent(memoryId)}`;
}

/** Build the canonical detail route for a persisted public location. */
export function locationPath(locationId: string): string {
  return `/system/locations/${encodeURIComponent(locationId)}`;
}

/** Build the Workspace list route that opens one Workspace's details. */
export function workspacePath(workspaceId: string): string {
  return `/system/workspaces/${encodeURIComponent(workspaceId)}`;
}

/** Automation page tabs. Overview is the bare Automation path. */
export type AutomationTab = "overview" | "runs" | "versions" | "edit";

/** Build the route for one Automation page tab, or its edit mode. */
export function automationPath(
  automationId: string,
  tab: AutomationTab = "overview",
): string {
  const base = `/automations/${encodeURIComponent(automationId)}`;
  return tab === "overview" ? base : `${base}/${tab}`;
}

function prettyJson(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return undefined;
  }
}

function prettyJsonl(text: string): string | undefined {
  const lines = text
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  if (lines.length < 2) return undefined;

  const formatted: string[] = [];
  for (const line of lines) {
    const json = prettyJson(line);
    if (!json) return undefined;
    formatted.push(json);
  }
  return formatted.join("\n");
}

/** Pretty-print JSON or JSONL text, or return undefined for other text. */
export function prettyJsonData(text: string): string | undefined {
  return prettyJson(text) ?? prettyJsonl(text);
}

/**
 * Detect the language for LLM text output prose: json if the text is valid
 * JSON or JSONL, markdown otherwise. Never auto-detects XML, HTML, TypeScript,
 * or shell — those heuristics are unreliable for rendered assistant output.
 */
export function detectOutputLanguage(text: string): BundledLanguage {
  const trimmed = text.trim();
  if (!trimmed) return "markdown";
  try {
    JSON.parse(trimmed);
    return "json";
  } catch {
    // continue
  }
  if (prettyJsonl(trimmed)) return "json";
  return "markdown";
}

/** Convert SQL conversation summaries into dashboard rows. */
export function buildConversations(
  summaries: ConversationFeedItem[],
): Conversation[] {
  return summaries
    .map((summary) => ({
      activityPreview: summary.activityPreview,
      brief: summary.brief,
      annotations: summary.annotations,
      sidebarAnnotations: summary.sidebarAnnotations,
      archivedAt: summary.archivedAt,
      pinnedAt: summary.pinnedAt,
      pinPosition: summary.pinPosition,
      unread: summary.unread,
      auxiliaryCosts: summary.auxiliaryCosts,
      channel: summary.channel,
      channelName: summary.channelName,
      channelNameRedacted: summary.channelNameRedacted,
      childAgentTotals: summary.childAgentTotals,
      cumulativeDurationMs: summary.cumulativeDurationMs,
      cumulativeUsage: summary.cumulativeUsage,
      displayTitle: summary.displayTitle,
      id: summary.conversationId,
      lastMessageAt: summary.lastMessageAt,
      lastProgressAt: summary.lastProgressAt,
      lastSeenAt: summary.lastSeenAt,
      locationId: summary.locationId,
      locationUrl: summary.locationUrl,
      actorIdentity: summary.actorIdentity,
      participants: summary.participants,
      sentryTraceUrl: summary.sentryTraceUrl,
      startedAt: summary.startedAt,
      status: summary.status,
      surface: summary.surface,
      traceId: summary.traceId,
      isPriority: summary.isPriority,
      kind: summary.kind,
      parentConversationId: summary.parentConversationId,
      threads: summary.threads && buildConversations(summary.threads),
      visibility: summary.visibility,
    }))
    .sort((a, b) => compareTimeDesc(a.lastSeenAt, b.lastSeenAt));
}

/** Build a conversation row from a detail report so permalinks do not depend on the feed. */
export function conversationFromDetail(
  detail: ConversationTranscript | undefined,
): Conversation | undefined {
  if (!detail) return undefined;
  // The feed carries a glance at the Brief, not the whole Brief.
  const { brief, ...summary } = detail;
  const conversation = buildConversations([
    brief
      ? {
          ...summary,
          brief: {
            intent: brief.content.intent,
            status: brief.content.outcome.status,
            summary: brief.content.summary,
          },
        }
      : summary,
  ])[0];
  return conversation
    ? { ...conversation, displayTitle: detail.displayTitle }
    : undefined;
}

/** Serialize transcript part payloads for raw view and syntax highlighting. */
export function stringifyPartValue(value: unknown): string {
  if (value == null || value === "") return "";
  if (typeof value === "string") return prettyJsonData(value) ?? value;
  return JSON.stringify(value, null, 2) ?? "";
}
