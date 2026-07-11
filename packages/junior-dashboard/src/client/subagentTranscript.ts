import type { ConversationSubagentTranscriptReport } from "@sentry/junior/api/schema";
import type { ConversationTranscript } from "./types";

/** Project a child-agent report through the shared transcript renderer. */
export function subagentConversationTranscript(
  conversationId: string,
  report: ConversationSubagentTranscriptReport,
): ConversationTranscript {
  const status =
    report.status === "running"
      ? "active"
      : report.status === "error" || report.status === "aborted"
        ? "failed"
        : "completed";

  return {
    conversationId,
    assistantLabel: report.subagentKind,
    cumulativeDurationMs: subagentDurationMs(report) ?? 0,
    displayTitle: report.subagentKind,
    lastProgressAt: report.endedAt ?? report.createdAt,
    lastSeenAt: report.endedAt ?? report.createdAt,
    startedAt: report.createdAt,
    status,
    surface: "internal",
    transcript: report.transcript,
    transcriptAvailable: report.transcriptAvailable,
    ...(report.transcriptMessageCount !== undefined
      ? { transcriptMessageCount: report.transcriptMessageCount }
      : {}),
    ...(report.transcriptRedacted
      ? { transcriptRedacted: report.transcriptRedacted }
      : {}),
    ...(report.transcriptRedactionReason
      ? { transcriptRedactionReason: report.transcriptRedactionReason }
      : {}),
  };
}

/** Calculate a completed child-agent duration when timestamps are valid. */
export function subagentDurationMs(
  report: Pick<ConversationSubagentTranscriptReport, "createdAt" | "endedAt">,
): number | undefined {
  if (!report.endedAt) return undefined;
  const startedAt = Date.parse(report.createdAt);
  const endedAt = Date.parse(report.endedAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) {
    return undefined;
  }
  return endedAt >= startedAt ? endedAt - startedAt : undefined;
}
