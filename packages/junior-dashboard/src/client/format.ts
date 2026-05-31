import { bundledLanguages, type BundledLanguage } from "shiki/bundle/web";

import type {
  CodeBlock,
  Conversation,
  ConversationTurn,
  MarkupNode,
  RequesterIdentity,
  Session,
  SessionFilter,
  TurnUsage,
  VisualStatus,
} from "./types";

let dashboardTimeZone = "America/Los_Angeles";

/** Set the dashboard display timezone returned by the authenticated config API. */
export function setDashboardTimeZone(timeZone: string): void {
  dashboardTimeZone = timeZone;
}

function displayTimeZone(): string {
  return dashboardTimeZone;
}

function isActiveSession(session: Session): boolean {
  return session.status === "active" || session.status === "running";
}

/** Identify turn summaries that should appear in failed conversation filters. */
export function isFailedSession(session: Session): boolean {
  return session.status === "failed";
}

function isHungSession(session: Session): boolean {
  return session.status === "hung";
}

function isActiveConversation(conversation: Conversation): boolean {
  return conversation.turns.some(
    (turn) => visualStatusForSession(turn) === "active",
  );
}

function isFailedConversation(conversation: Conversation): boolean {
  return conversation.turns.some(isFailedSession);
}

function isHungConversation(conversation: Conversation): boolean {
  return conversation.turns.some(isHungSession);
}

function parseTime(value: string | undefined): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
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
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
}

/** Format transcript event timestamps independently from turn start offsets. */
export function formatMessageTimestamp(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value))
    return "no timestamp";
  return new Date(value).toLocaleTimeString(undefined, {
    timeZone: displayTimeZone(),
  });
}

/** Format a transcript event as an offset from the current turn start. */
export function formatMessageOffset(
  turn: ConversationTurn,
  value: number | undefined,
): string | undefined {
  const start = parseTime(turn.startedAt);
  if (
    start == null ||
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < start
  ) {
    return undefined;
  }
  return `+${formatMs(value - start)}`;
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

function transcriptSource(turn: ConversationTurn) {
  return turn.transcriptAvailable
    ? turn.transcript
    : (turn.transcriptMetadata ?? []);
}

/** Count visible or redacted message records for a turn. */
export function turnMessageCount(turn: ConversationTurn): number {
  return turn.transcriptMessageCount ?? transcriptSource(turn).length;
}

/** Count tool calls from visible transcripts or safe redacted metadata. */
export function turnToolCallCount(turn: ConversationTurn): number {
  return transcriptSource(turn).reduce((count, message) => {
    return (
      count + message.parts.filter((part) => part.type === "tool_call").length
    );
  }, 0);
}

function totalUsageTokens(usage: TurnUsage | undefined): number | undefined {
  if (!usage) return undefined;
  if (
    typeof usage.totalTokens === "number" &&
    Number.isFinite(usage.totalTokens)
  ) {
    return usage.totalTokens;
  }
  return [
    usage.inputTokens,
    usage.outputTokens,
    usage.cachedInputTokens,
    usage.cacheCreationTokens,
  ].reduce<number | undefined>((sum, value) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return sum;
    return (sum ?? 0) + Math.max(0, Math.floor(value));
  }, undefined);
}

/** Format known token counters without estimating per-message usage. */
export function formatTokenTotal(usage: TurnUsage | undefined): string {
  const total = totalUsageTokens(usage);
  return total === undefined ? "" : `${formatNumber(total)} tokens`;
}

/** Format known token counters with available input/output detail. */
export function formatUsage(usage: TurnUsage | undefined): string {
  const total = totalUsageTokens(usage);
  if (total === undefined) return "";
  const pieces = [
    usage?.inputTokens !== undefined
      ? `${formatNumber(usage.inputTokens)} in`
      : undefined,
    usage?.outputTokens !== undefined
      ? `${formatNumber(usage.outputTokens)} out`
      : undefined,
    usage?.cachedInputTokens !== undefined
      ? `${formatNumber(usage.cachedInputTokens)} cached`
      : undefined,
    usage?.cacheCreationTokens !== undefined
      ? `${formatNumber(usage.cacheCreationTokens)} cache-write`
      : undefined,
  ].filter(Boolean);
  return pieces.length > 0
    ? `${formatNumber(total)} tokens (${pieces.join(" / ")})`
    : `${formatNumber(total)} tokens`;
}

/** Format a conversation span from first turn start to latest activity. */
export function formatConversationDuration(conversation: Conversation): string {
  const start = parseTime(conversation.startedAt);
  const end = parseTime(conversation.lastSeenAt) ?? Date.now();
  if (start == null || end < start) return "none";
  const seconds = Math.max(1, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}

/** Resolve the owning conversation id for a turn/session summary. */
export function conversationIdForSession(session: Session): string {
  return session.conversationId || session.id;
}

function compareTimeDesc(a: string | undefined, b: string | undefined): number {
  return (parseTime(b) ?? 0) - (parseTime(a) ?? 0);
}

function compareTimeAsc(a: string | undefined, b: string | undefined): number {
  return (parseTime(a) ?? 0) - (parseTime(b) ?? 0);
}

function getConversationTitle(conversation: Conversation): string {
  if (conversation.surface === "slack") {
    return (
      slackLocationLabel(conversation, { includeId: false }) ??
      conversation.title
    );
  }
  return conversation.title;
}

/** Choose the safe display title already prepared by the reporting API. */
export function conversationDisplayTitle(
  conversation: Conversation | undefined,
): string {
  if (!conversation) return "Conversation";
  return conversation.conversationTitle ?? getConversationTitle(conversation);
}

/** Prefer stable requester identifiers while keeping Slack ids as a last resort. */
export function requesterLabel(
  requester: RequesterIdentity | undefined,
  fallback: string | undefined,
): string | undefined {
  return (
    requester?.email ??
    requester?.slackUserName ??
    requester?.fullName ??
    fallback ??
    requester?.slackUserId
  );
}

/** Format the owner and permalink id line shared by conversation rows and headers. */
export function conversationIdentityMeta(
  conversation: Conversation | undefined,
  conversationId: string | undefined,
): string {
  const id = conversationId ?? "missing conversation id";
  const owner = requesterLabel(
    conversation?.requesterIdentity,
    conversation?.requester,
  );
  return owner ? `${owner} · ${id}` : id;
}

/** Convert Slack channel ids and names into user-facing location labels. */
export function slackLocationLabel(
  input: Pick<
    Session,
    "channel" | "channelName" | "requester" | "requesterIdentity"
  >,
  options: { includeId?: boolean } = {},
): string | undefined {
  const channelId = input.channel;
  if (!channelId) return undefined;

  const includeId = options.includeId ?? true;
  const name = input.channelName?.replace(/^#/, "");
  const idSuffix = includeId ? ` (${channelId})` : "";
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

/** Collapse raw turn states into the dashboard's visual status language. */
export function visualStatusForSession(session: Session): VisualStatus {
  if (isHungSession(session)) return "hung";
  if (isFailedSession(session)) return "failed";
  if (isActiveSession(session)) return "active";
  return "idle";
}

/** Derive conversation status from its turn summaries. */
export function visualStatusForConversation(
  conversation: Conversation,
): VisualStatus {
  if (isHungConversation(conversation)) return "hung";
  if (isActiveConversation(conversation)) return "active";
  if (isFailedConversation(conversation)) return "failed";
  return "idle";
}

/** Explain why a transcript body is absent without exposing private content. */
export function unavailableTranscriptLabel(turn: ConversationTurn): string {
  if (turn.transcriptRedacted) {
    return "Transcript hidden because this conversation is not public.";
  }
  const status = visualStatusForSession(turn);
  if (status === "active") {
    return "Transcript pending for this active turn.";
  }
  if (status === "hung") {
    return "Transcript pending for this hung turn.";
  }
  return "Transcript unavailable for this turn.";
}

/** Build the canonical permalink route for a conversation id. */
export function conversationPath(conversationId: string): string {
  return `/conversations/${encodeURIComponent(conversationId)}`;
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

/** Decide whether a fenced block can use the interactive markup renderer. */
export function canRenderStructuredMarkup(language: BundledLanguage): boolean {
  return language === "xml" || language === "html";
}

/** Parse markdown into renderable code blocks while preserving plain text blocks. */
export function parseMarkdownBlocks(text: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  const fence = /```([A-Za-z0-9_-]+)?\n([\s\S]*?)```/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(text))) {
    const prose = text.slice(cursor, match.index).trim();
    if (prose) {
      const language = detectLanguage(prose);
      blocks.push({ code: formatCodeBlock(prose, language), language });
    }
    const language = normalizeLanguage(match[1]);
    blocks.push({
      code: formatCodeBlock(match[2] ?? "", language),
      language,
    });
    cursor = match.index + match[0].length;
  }
  const rest = text.slice(cursor).trim();
  if (rest) {
    const language = detectLanguage(rest);
    blocks.push({ code: formatCodeBlock(rest, language), language });
  }
  if (blocks.length > 0) return blocks;
  const language = detectLanguage(text);
  return [{ code: formatCodeBlock(text, language), language }];
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

/** Group recent turn summaries into conversation rows. */
export function buildConversations(sessions: Session[]): Conversation[] {
  const byId = new Map<string, Session[]>();
  for (const session of sessions) {
    const id = conversationIdForSession(session);
    byId.set(id, [...(byId.get(id) ?? []), session]);
  }

  return [...byId.entries()]
    .map(([id, turns]) => {
      const sortedTurns = [...turns].sort((a, b) =>
        compareTimeAsc(a.startedAt, b.startedAt),
      );
      const newest = [...turns].sort((a, b) =>
        compareTimeDesc(
          a.lastSeenAt ?? a.startedAt,
          b.lastSeenAt ?? b.startedAt,
        ),
      )[0]!;
      const oldest = sortedTurns.reduce((current, next) =>
        (parseTime(next.startedAt) ?? Number.MAX_SAFE_INTEGER) <
        (parseTime(current.startedAt) ?? Number.MAX_SAFE_INTEGER)
          ? next
          : current,
      );
      const status = sortedTurns.some(isHungSession)
        ? "hung"
        : sortedTurns.some(isActiveSession)
          ? "active"
          : sortedTurns.some(isFailedSession)
            ? "failed"
            : newest.status;
      const requesterTurn =
        sortedTurns.find((turn) => turn.requesterIdentity) ??
        sortedTurns.find((turn) => turn.requester);

      return {
        channel: newest.channel,
        channelName: sortedTurns.find((turn) => turn.channelName)?.channelName,
        conversationTitle: sortedTurns.find((turn) => turn.conversationTitle)
          ?.conversationTitle,
        id,
        lastSeenAt: newest.lastSeenAt,
        requester: requesterLabel(
          requesterTurn?.requesterIdentity,
          requesterTurn?.requester,
        ),
        requesterIdentity: requesterTurn?.requesterIdentity,
        sentryConversationUrl: newest.sentryConversationUrl,
        sentryTraceUrl: newest.sentryTraceUrl,
        startedAt: oldest.startedAt,
        status,
        surface: newest.surface,
        title: newest.title || id,
        traceId: newest.traceId,
        turns: sortedTurns,
      };
    })
    .sort((a, b) => compareTimeDesc(a.lastSeenAt, b.lastSeenAt));
}

/** Apply the dashboard conversation filter to grouped conversation rows. */
export function filterConversations(
  conversations: Conversation[],
  filter: SessionFilter,
): Conversation[] {
  if (filter === "all") return conversations;
  if (filter === "active") return conversations.filter(isActiveConversation);
  if (filter === "hung") return conversations.filter(isHungConversation);
  if (filter === "failed") return conversations.filter(isFailedConversation);
  return conversations;
}

/** Normalize URL filter params to the supported dashboard filter set. */
export function getFilter(value: string | null): SessionFilter {
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
