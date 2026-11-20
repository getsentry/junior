import type {
  ConversationReportEvent,
  ConversationReportEventData,
} from "@sentry/junior/api/schema";

import { toolCallPreview } from "./toolCallPreview";
import {
  formatCompactNumber,
  formatCostBreakdown,
  summarizeCost,
} from "../format";

/** Show call usage once and never repeat it on tool results. */
export function eventLogUsage(event: ConversationReportEvent): string {
  const usage = event.modelCall?.usage;
  const cost = summarizeCost(usage);
  const fields = [
    cost ? `${formatCostBreakdown(cost)} call` : undefined,
    ...(
      [
        ["inputTokens", "in"],
        ["outputTokens", "out"],
        ["cachedInputTokens", "cache read"],
        ["cacheCreationTokens", "cache write"],
        ["reasoningTokens", "reasoning"],
        ["totalTokens", "total"],
      ] as const
    ).map(([key, label]) =>
      usage?.[key] !== undefined
        ? `${formatCompactNumber(usage[key])} ${label}`
        : undefined,
    ),
  ];
  return fields.filter((field) => field !== undefined).join(" · ");
}

type EventData<T extends ConversationReportEventData["type"]> = Extract<
  ConversationReportEventData,
  { type: T }
>;
type EventSummaries = {
  [T in ConversationReportEventData["type"]]: (data: EventData<T>) => string;
};

const EVENT_SUMMARIES = {
  message: (data) =>
    `${data.role} · ${data.redacted ? "Content hidden" : data.text || "Empty message"}`,
  message_handled: (data) => data.messageId,
  assistant_message: (data) =>
    data.parts
      .map((part) => (part.redacted ? "Content hidden" : part.text))
      .join(" · ") || "Model call recorded",
  tool_calls: (data) =>
    data.calls
      .map((call) => {
        const preview = toolCallPreview(call.name, call.input);
        return `${call.name} · ${call.status}${preview ? ` · ${preview}` : ""}`;
      })
      .join(" / "),
  turn_lifecycle: (data) =>
    data.state === "failed"
      ? `${data.state} · ${data.failureCode}${data.failureReason ? ` · ${data.failureReason}` : ""}`
      : `${data.state} · ${data.turnId}`,
  turn_context: (data) =>
    `${data.pluginName} · ${data.kind} · v${data.version}`,
  guardian_action_reviewed: (data) =>
    `${data.decision} · ${data.toolName} · ${data.riskLevel} risk`,
  structured_event: (data) =>
    `${data.namespace}.${data.name} · ${data.presentation.title}`,
  attachments_delivered: (data) =>
    data.attachments.map((attachment) => attachment.filename).join(", "),
  reply_posted: (data) => `${data.plugin} · ${data.url ?? data.text}`,
  compaction: (data) => data.summary ?? "Agent history compacted",
  subagent: (data) =>
    `${data.agentName ?? data.subagentKind} · ${data.status} · ${data.childConversationId}`,
} satisfies EventSummaries;

/** Summarize an event without merging it with earlier or later events. */
export function eventLogSummary<T extends ConversationReportEventData["type"]>(
  data: EventData<T>,
): string {
  const summarize: EventSummaries[T] = EVENT_SUMMARIES[data.type];
  return summarize(data);
}

/** Use status color only for failures and decisions that need attention. */
export function eventLogTone(data: ConversationReportEventData): string {
  if (
    (data.type === "turn_lifecycle" && data.state === "failed") ||
    (data.type === "tool_calls" &&
      data.calls.some((call) => call.status === "error")) ||
    (data.type === "subagent" && data.status === "error") ||
    (data.type === "guardian_action_reviewed" && data.decision === "deny")
  ) {
    return "text-rose-300";
  }
  if (
    (data.type === "guardian_action_reviewed" && data.decision === "ask") ||
    (data.type === "turn_lifecycle" && data.state === "blocked") ||
    (data.type === "subagent" &&
      (data.status === "aborted" || data.status === "blocked"))
  ) {
    return "text-amber-200";
  }
  return "text-dashboard-text-subtle";
}

/** One event log entry with its display text. */
export type EventLogRow = {
  event: ConversationReportEvent;
  summary: string;
  metadata: string;
};

/** Build the display text for each event log entry. */
export function eventLogRows(
  events: readonly ConversationReportEvent[],
): EventLogRow[] {
  return events.map((event) => {
    return {
      event,
      summary: eventLogSummary(event.data).replace(/\s+/g, " ").slice(0, 300),
      metadata: [event.model?.modelId, eventLogUsage(event)]
        .filter(Boolean)
        .join(" · "),
    };
  });
}

/**
 * Keep the rows that match a trimmed, lowercase search query. The match
 * includes the full event payload, so large payloads are serialized here.
 */
export function filterEventLogRows(
  rows: EventLogRow[],
  normalizedQuery: string,
): EventLogRow[] {
  if (!normalizedQuery) return rows;
  return rows.filter(({ event, summary, metadata }) =>
    `${summary} ${metadata} ${JSON.stringify(event)}`
      .toLowerCase()
      .includes(normalizedQuery),
  );
}

/** Find the visible rows before and after the selected event. */
export function adjacentEventLogSeqs(
  rows: readonly EventLogRow[],
  seq: number | undefined,
): { previous?: number | undefined; next?: number | undefined } {
  const index = rows.findIndex((row) => row.event.seq === seq);
  if (index === -1) return {};
  return {
    previous: rows[index - 1]?.event.seq,
    next: rows[index + 1]?.event.seq,
  };
}
