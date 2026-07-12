import { bundledLanguages, type BundledLanguage } from "shiki/bundle/web";
import type {
  ActorIdentity,
  ConversationSummaryReport,
  ConversationUsage,
} from "@sentry/junior/api/schema";
import type { ConversationDetailReport } from "@sentry/junior/api/schema";

import type {
  CodeBlock,
  Conversation,
  ConversationTranscript,
  ConversationFilter,
  MarkupNode,
  TranscriptViewMessage,
  TranscriptViewPart,
  VisualStatus,
} from "./types";
import { sameToolInvocation } from "./toolInvocations";
import { conversationTranscriptMessages } from "./transcriptActivity";

let dashboardTimeZone = "America/Los_Angeles";
const RECENT_CONVERSATION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Set the dashboard display timezone returned by the authenticated config API. */
export function setDashboardTimeZone(timeZone: string): void {
  dashboardTimeZone = timeZone;
}

function displayTimeZone(): string {
  return dashboardTimeZone;
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

function isHungSummary(summary: ConversationSummaryReport): boolean {
  return summary.status === "hung";
}

function isActiveConversation(conversation: Conversation): boolean {
  return conversation.status === "active";
}

function isFailedConversation(conversation: Conversation): boolean {
  return conversation.status === "failed";
}

function isHungConversation(conversation: Conversation): boolean {
  return conversation.status === "hung";
}

function parseTime(value: string | undefined): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

/** Return the recent reporting window shared by command-center aggregates. */
export function recentConversationRange(nowMs = Date.now()) {
  return {
    endMs: nowMs,
    startMs: nowMs - RECENT_CONVERSATION_WINDOW_MS,
  };
}

/** Keep command-center conversations inside the shared recent activity window. */
export function filterRecentConversations(
  conversations: Conversation[],
  nowMs = Date.now(),
): Conversation[] {
  const range = recentConversationRange(nowMs);
  return conversations.filter((conversation) => {
    const activityAt = parseTime(conversation.lastSeenAt);
    return (
      activityAt !== null &&
      activityAt >= range.startMs &&
      activityAt <= range.endMs
    );
  });
}

/** Format absolute dashboard timestamps with a stable empty fallback. */
export function formatTime(value: string | undefined): string {
  const time = parseTime(value);
  if (time == null) return "none";
  return new Date(time).toLocaleString(undefined, {
    timeZone: displayTimeZone(),
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

/** Format chart duration ticks without long labels wrapping on the Y axis. */
export function formatDurationTick(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "none";
  const ms = Math.max(0, Math.floor(value));
  if (Math.round(ms / 1000) >= 10 * 60) {
    return `${Math.round(ms / (60 * 1000))}m`;
  }
  return formatMs(ms);
}

/** Format a persisted conversation runtime when duration data exists. */
export function formatRuntime(durationMs: number | undefined): string {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs)) return "";
  const runtime = Math.max(0, Math.floor(durationMs));
  return runtime === 0 ? "" : formatMs(runtime);
}

/** Format transcript event timestamps independently from conversation start. */
export function formatMessageTimestamp(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value))
    return "no timestamp";
  return new Date(value).toLocaleTimeString(undefined, {
    timeZone: displayTimeZone(),
  });
}

function formatNumber(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "0";
  const number = Math.max(0, Math.floor(value));
  if (number < 1000) return String(number);

  const units: Array<[string, number]> = [
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

/** Format byte counts in lowercase compact units for transcript metadata. */
export function formatBytes(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "0b";
  const bytes = Math.max(0, Math.floor(value));
  if (bytes < 1024) return `${bytes}b`;

  const units: Array<[string, number]> = [
    ["mb", 1024 * 1024],
    ["kb", 1024],
  ];
  const [suffix, divisor] =
    units.find(([, threshold]) => bytes >= threshold) ?? units[1]!;
  const scaled = bytes / divisor;
  const precision = scaled >= 10 || Number.isInteger(scaled) ? 0 : 1;
  return `${scaled.toFixed(precision).replace(/\.0$/, "")}${suffix}`;
}

function transcriptSource(conversation: ConversationTranscript) {
  return conversationTranscriptMessages(conversation);
}

function rawTranscriptSource(conversation: ConversationTranscript) {
  return conversation.transcriptAvailable
    ? conversation.transcript
    : (conversation.transcriptMetadata ?? []);
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
  const source = rawTranscriptSource(conversation);
  if (source.length > 0) {
    return source.filter(isConversationMessage).length;
  }
  return conversation.transcriptMessageCount ?? 0;
}

export type ToolCallSummaryItem = {
  count: number;
  name: string;
  totalDurationMs?: number;
};

export type ToolCallSummary = {
  items: ToolCallSummaryItem[];
  total: number;
};

type PendingToolCall = {
  id?: string;
  name: string;
  timestamp?: number;
};

function toolCallName(part: TranscriptViewPart): string {
  return part.name ?? part.id ?? "unknown";
}

function findPendingToolCallIndex(
  calls: PendingToolCall[],
  result: TranscriptViewPart,
): number {
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    if (sameToolInvocation(calls[index]!, result)) {
      return index;
    }
  }
  return -1;
}

/** Summarize tool calls and matched result durations from transcript metadata. */
export function summarizeToolCalls(
  conversation: ConversationTranscript,
  limit = 5,
): ToolCallSummary {
  const byName = new Map<string, ToolCallSummaryItem>();
  let total = 0;

  const pending: PendingToolCall[] = [];
  for (const message of transcriptSource(conversation)) {
    for (const part of message.parts) {
      if (part.type === "tool_call") {
        const name = toolCallName(part);
        const item = byName.get(name) ?? { count: 0, name };
        item.count += 1;
        byName.set(name, item);
        pending.push({
          ...(part.id ? { id: part.id } : {}),
          name,
          ...(typeof message.timestamp === "number"
            ? { timestamp: message.timestamp }
            : {}),
        });
        total += 1;
        continue;
      }

      if (part.type !== "tool_result") continue;
      const pendingIndex = findPendingToolCallIndex(pending, part);
      if (pendingIndex < 0) continue;
      const [call] = pending.splice(pendingIndex, 1);
      if (
        !call ||
        typeof call.timestamp !== "number" ||
        typeof message.timestamp !== "number" ||
        message.timestamp < call.timestamp
      ) {
        continue;
      }
      const item = byName.get(call.name);
      if (!item) continue;
      item.totalDurationMs =
        (item.totalDurationMs ?? 0) + (message.timestamp - call.timestamp);
    }
  }

  const items = [...byName.values()]
    .sort(
      (left, right) =>
        right.count - left.count ||
        (right.totalDurationMs ?? 0) - (left.totalDurationMs ?? 0) ||
        left.name.localeCompare(right.name),
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

function transcriptMessageAuthor(
  conversation: ConversationTranscript,
  message: TranscriptViewMessage,
): string {
  const kind = transcriptRoleKind(message.role);
  if (kind === "assistant") return "Junior";
  if (kind === "user") {
    return actorLabel(conversation.actorIdentity) ?? "User";
  }
  if (kind === "system") return "System";
  if (kind === "tool") return "Tool";
  return message.role || "Unknown";
}

function transcriptPartBytes(part: TranscriptViewPart): number {
  if (typeof part.bytes === "number" && Number.isFinite(part.bytes)) {
    return Math.max(0, Math.floor(part.bytes));
  }
  if (
    typeof part.inputSizeBytes === "number" &&
    Number.isFinite(part.inputSizeBytes)
  ) {
    return Math.max(0, Math.floor(part.inputSizeBytes));
  }
  if (
    typeof part.outputSizeBytes === "number" &&
    Number.isFinite(part.outputSizeBytes)
  ) {
    return Math.max(0, Math.floor(part.outputSizeBytes));
  }
  return new TextEncoder().encode(
    stringifyPartValue(part.text ?? part.input ?? part.output ?? part),
  ).byteLength;
}

/** Summarize conversational messages by author and serialized size. */
export function summarizeMessages(
  conversation: ConversationTranscript,
): MessageSummary {
  const items: MessageSummaryItem[] = [];

  for (const message of transcriptSource(conversation)) {
    if (!isConversationMessage(message)) continue;
    items.push({
      author: transcriptMessageAuthor(conversation, message),
      bytes: message.parts.reduce(
        (sum, part) => sum + transcriptPartBytes(part),
        0,
      ),
    });
  }

  return { items, total: items.length };
}

/** Format raw counts with the dashboard's compact number rules. */
export function formatCompactNumber(value: number | undefined): string {
  return formatNumber(value);
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

/** Format a summarized token counter for compact metadata. */
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

/** Format estimated model cost in USD with useful sub-cent precision. */
export function formatCostSummary(
  summary: CostUsageSummary | undefined,
): string {
  if (!summary) return "";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(summary.total);
}

/** Format persisted cumulative estimated model cost for a conversation. */
export function formatCostTotal(usage: ConversationUsage | undefined): string {
  return formatCostSummary(summarizeCost(usage));
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

/** Derive the conversation owner label from structured actor identity. */
export function conversationActorLabel(
  conversation: Conversation | undefined,
): string | undefined {
  return actorLabel(conversation?.actorIdentity);
}

/** Return the stable actor key used by dashboard list filters. */
export function conversationActorKey(
  conversation: Conversation | undefined,
): string | undefined {
  return (
    conversation?.actorIdentity?.email?.trim() ||
    conversationActorLabel(conversation)
  );
}

/** Format the owner and permalink id line shared by conversation rows and headers. */
export function conversationIdentityMeta(
  conversation: Conversation | undefined,
  conversationId: string | undefined,
): string {
  const id = conversationId ?? conversation?.id;
  const owner = conversationActorLabel(conversation);
  if (!id) return owner ?? "";
  return owner ? `${owner} · ${id}` : id;
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
  if (isHungSummary(summary)) return "hung";
  if (isFailedConversationSummary(summary)) return "failed";
  if (isActiveSummary(summary)) return "active";
  return "idle";
}

/** Derive the dashboard status from a conversation record. */
export function visualStatusForConversation(
  conversation: Conversation,
): VisualStatus {
  if (isHungConversation(conversation)) return "hung";
  if (isActiveConversation(conversation)) return "active";
  if (isFailedConversation(conversation)) return "failed";
  return "idle";
}

/** Explain why a transcript body is absent without exposing private content. */
export function unavailableTranscriptLabel(
  conversation: ConversationTranscript,
): string {
  if (conversation.transcriptRedacted) {
    return "Transcript hidden because this conversation is not public.";
  }
  const status = visualStatusForSummary(conversation);
  if (status === "active") {
    return "Transcript pending while this conversation is active.";
  }
  if (status === "hung") {
    return "Transcript pending while this conversation is hung.";
  }
  return "Transcript unavailable for this conversation.";
}

/** Build the canonical permalink route for a conversation id. */
export function conversationPath(conversationId: string): string {
  return `/conversations/${encodeURIComponent(conversationId)}`;
}

/** Build the canonical actor profile route for a trusted email address. */
export function peoplePath(email: string): string {
  return `/people/${encodeURIComponent(email)}`;
}

function normalizeLanguage(language: string | undefined): BundledLanguage {
  const normalized = language?.trim().toLowerCase();
  if (!normalized) return "markdown";
  const aliases: Record<string, BundledLanguage> = {
    console: "shellscript",
    htm: "html",
    js: "javascript",
    jsonl: "json",
    md: "markdown",
    ndjson: "json",
    sh: "shellscript",
    text: "markdown",
    txt: "markdown",
    xml: "xml",
    yml: "yaml",
  };
  const candidate = aliases[normalized] ?? normalized;
  return candidate in bundledLanguages
    ? (candidate as BundledLanguage)
    : "markdown";
}

/** Detect the syntax highlighter language for raw transcript blocks. */
export function detectLanguage(text: string): BundledLanguage {
  const trimmed = text.trim();
  if (!trimmed) return "markdown";
  try {
    JSON.parse(trimmed);
    return "json";
  } catch {
    // continue with heuristics
  }
  if (prettyJsonl(trimmed)) return "json";
  if (/^<[\s\S]+>$/.test(trimmed) && /<\/?[a-zA-Z][^>]*>/.test(trimmed)) {
    return "xml";
  }
  // Mixed prose + block-level XML: detect when a complete open/close element pair
  // appears on its own lines. Handles system prompts and runtime context blocks
  // that start with plain text but contain structured XML sections.
  const blockOpen = trimmed.match(
    /(?:^|\n)[ \t]*<([A-Za-z_][\w:.-]*)(?:[ \t][^<>]*)?>[ \t]*(?=\n|$)/,
  );
  if (blockOpen?.[1]) {
    const tag = blockOpen[1].replace(/[$()*+.?[\\^{|}]/g, "\\$&");
    if (new RegExp(`(?:^|\\n)[ \\t]*</${tag}>[ \\t]*(?=\\n|$)`).test(trimmed)) {
      return "xml";
    }
  }
  if (/```|^#{1,6}\s|\n[-*]\s|\n\d+\.\s|\[[^\]]+\]\([^)]+\)/m.test(trimmed)) {
    return "markdown";
  }
  if (/\b(import|export|const|let|function|interface|type)\b/.test(trimmed)) {
    return "typescript";
  }
  if (/^\s*(\$|pnpm|npm|git|curl|cd|ls|node)\b/m.test(trimmed)) {
    return "shellscript";
  }
  return "markdown";
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

function prettyJsonData(text: string): string | undefined {
  return prettyJson(text) ?? prettyJsonl(text);
}

function formatCodeBlock(code: string, language: BundledLanguage): string {
  return language === "json" ? (prettyJsonData(code) ?? code) : code;
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

/**
 * Decide whether a block can use the interactive markup renderer.
 * Only xml/html language blocks qualify; fenced is tracked as metadata but
 * does not gate eligibility — caller controls whether XML detection runs.
 */
export function canRenderStructuredMarkup(block: CodeBlock): boolean {
  return block.language === "xml" || block.language === "html";
}

/**
 * Parse markdown into renderable code blocks while preserving plain text blocks.
 *
 * `outputOnly` (default `false`): when `true`, prose sections use
 * `detectOutputLanguage` (json or markdown only — no xml/html heuristics).
 * Use `outputOnly: true` for LLM-generated text (assistant messages) to
 * prevent Slack autolinks and HTML snippets from triggering the XML tree
 * renderer. Leave `false` (default) for user/system messages that may
 * contain genuine XML runtime context.
 */
export function parseMarkdownBlocks(
  text: string,
  opts: { outputOnly?: boolean } = {},
): CodeBlock[] {
  const detectProse = opts.outputOnly ? detectOutputLanguage : detectLanguage;
  const blocks: CodeBlock[] = [];
  const fence = /```([A-Za-z0-9_-]+)?\n([\s\S]*?)```/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(text))) {
    const prose = text.slice(cursor, match.index).trim();
    if (prose) {
      const language = detectProse(prose);
      blocks.push({
        code: formatCodeBlock(prose, language),
        fenced: false,
        language,
      });
    }
    const language = normalizeLanguage(match[1]);
    blocks.push({
      code: formatCodeBlock(match[2] ?? "", language),
      fenced: true,
      language,
    });
    cursor = match.index + match[0].length;
  }
  const rest = text.slice(cursor).trim();
  if (rest) {
    const language = detectProse(rest);
    blocks.push({
      code: formatCodeBlock(rest, language),
      fenced: false,
      language,
    });
  }
  if (blocks.length > 0) return blocks;
  const language = detectProse(text);
  return [{ code: formatCodeBlock(text, language), fenced: false, language }];
}

/** Parse XML/HTML-ish fragments for the collapsible transcript renderer. */
export function parseMarkupNodes(
  code: string,
  language: BundledLanguage,
): MarkupNode[] {
  const parser = new DOMParser();
  if (language === "xml") {
    const document = parser.parseFromString(
      `<junior-root>${code}</junior-root>`,
      "text/xml",
    );
    if (!document.querySelector("parsererror")) {
      return Array.from(document.documentElement.childNodes)
        .map(markupNodeFromDom)
        .filter(
          (node) => node.type === "element" || node.text.trim().length > 0,
        );
    }
  }

  const document = parser.parseFromString(code, "text/html");
  return Array.from(document.body.childNodes)
    .map(markupNodeFromDom)
    .filter((node) => node.type === "element" || node.text.trim().length > 0);
}

function markupNodeFromDom(node: ChildNode): MarkupNode {
  if (node.nodeType === Node.ELEMENT_NODE) {
    const element = node as Element;
    return {
      type: "element",
      tagName: element.tagName.toLowerCase(),
      attributes: Array.from(element.attributes).map((attribute) => [
        attribute.name,
        attribute.value,
      ]),
      children: Array.from(element.childNodes)
        .map(markupNodeFromDom)
        .filter(
          (child) => child.type === "element" || child.text.trim().length > 0,
        ),
    };
  }

  return { type: "text", text: node.textContent ?? "" };
}

/** Convert SQL conversation summaries into dashboard rows. */
export function buildConversations(
  summaries: ConversationSummaryReport[],
): Conversation[] {
  return summaries
    .map((summary) => ({
      channel: summary.channel,
      channelName: summary.channelName,
      cumulativeDurationMs: summary.cumulativeDurationMs,
      cumulativeUsage: summary.cumulativeUsage,
      displayTitle: summary.displayTitle,
      id: summary.conversationId,
      lastProgressAt: summary.lastProgressAt,
      lastSeenAt: summary.lastSeenAt,
      actorIdentity: summary.actorIdentity,
      sentryTraceUrl: summary.sentryTraceUrl,
      startedAt: summary.startedAt,
      status: summary.status,
      surface: summary.surface,
      traceId: summary.traceId,
    }))
    .sort((a, b) => compareTimeDesc(a.lastSeenAt, b.lastSeenAt));
}

/** Build a conversation row from a detail report so permalinks do not depend on the feed. */
export function conversationFromDetail(
  detail: ConversationDetailReport | undefined,
): Conversation | undefined {
  if (!detail) return undefined;
  const conversation = buildConversations([detail])[0];
  return conversation
    ? { ...conversation, displayTitle: detail.displayTitle }
    : undefined;
}

/** Apply the dashboard conversation filter to conversation rows. */
export function filterConversations(
  conversations: Conversation[],
  filter: ConversationFilter,
): Conversation[] {
  if (filter === "all") return conversations;
  if (filter === "active") return conversations.filter(isActiveConversation);
  if (filter === "hung") return conversations.filter(isHungConversation);
  if (filter === "failed") return conversations.filter(isFailedConversation);
  return conversations;
}

export type ConversationListFilters = {
  query?: string;
  actor?: string;
  source?: string;
};

export type ConversationListFilterOption = {
  label: string;
  value: string;
};

function uniqueConversationOptions(
  conversations: Conversation[],
  valueForConversation: (conversation: Conversation) => string | undefined,
  labelForConversation: (conversation: Conversation, value: string) => string,
): ConversationListFilterOption[] {
  const options = new Map<string, string>();
  for (const conversation of conversations) {
    const value = valueForConversation(conversation)?.trim();
    if (!value || options.has(value)) continue;
    options.set(value, labelForConversation(conversation, value));
  }
  return [...options.entries()]
    .map(([value, label]) => ({ label, value }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

function conversationSearchHaystack(conversation: Conversation): string {
  const actor = conversation.actorIdentity;
  return [
    conversation.displayTitle,
    conversation.id,
    conversation.channel,
    conversation.channelName,
    conversation.status,
    conversation.surface,
    actor?.email,
    actor?.fullName,
    actor?.slackUserId,
    actor?.slackUserName,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/** Return source filter options present in the loaded conversation rows. */
export function conversationSourceOptions(
  conversations: Conversation[],
): ConversationListFilterOption[] {
  return uniqueConversationOptions(
    conversations,
    (conversation) => conversation.surface,
    (_conversation, value) => value,
  );
}

/** Return actor filter options present in the loaded conversation rows. */
export function conversationActorOptions(
  conversations: Conversation[],
): ConversationListFilterOption[] {
  return uniqueConversationOptions(
    conversations,
    conversationActorKey,
    (conversation, value) =>
      conversation.actorIdentity?.fullName?.trim() ||
      conversation.actorIdentity?.email?.trim() ||
      conversation.actorIdentity?.slackUserName?.trim() ||
      value,
  );
}

/** Apply lightweight client-side search and facet filters to conversations. */
export function filterConversationList(
  conversations: Conversation[],
  filters: ConversationListFilters,
): Conversation[] {
  const query = filters.query?.trim().toLowerCase();
  const source = filters.source?.trim();
  const actor = filters.actor?.trim();

  return conversations.filter((conversation) => {
    if (source && conversation.surface !== source) return false;
    if (actor && conversationActorKey(conversation) !== actor) {
      return false;
    }
    if (query && !conversationSearchHaystack(conversation).includes(query)) {
      return false;
    }
    return true;
  });
}

/** Normalize URL filter params to the supported dashboard filter set. */
export function getFilter(value: string | null): ConversationFilter {
  return value === "active" ||
    value === "hung" ||
    value === "failed" ||
    value === "all"
    ? value
    : "recent";
}

/** Serialize transcript part payloads for raw view and syntax highlighting. */
export function stringifyPartValue(value: unknown): string {
  if (value == null || value === "") return "";
  if (typeof value === "string") return prettyJsonData(value) ?? value;
  return JSON.stringify(value, null, 2) ?? "";
}
