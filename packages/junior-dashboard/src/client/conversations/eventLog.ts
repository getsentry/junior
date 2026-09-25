import type { ConversationReportEventData } from "@sentry/junior/api/schema";

import { toolCallPreview } from "./toolCallPreview";

/** Summarize an event without merging it with earlier or later events. */
export function eventLogSummary(data: ConversationReportEventData): string {
  switch (data.type) {
    case "message":
      return `${data.role} · ${data.redacted ? "Content hidden" : data.text || "Empty message"}`;
    case "message_handled":
      return data.messageId;
    case "assistant_message":
      return data.parts
        .map((part) => (part.redacted ? "Content hidden" : part.text))
        .join(" · ");
    case "tool_calls":
      return data.calls
        .map((call) => {
          const preview = toolCallPreview(call.name, call.input);
          return `${call.name} · ${call.status}${preview ? ` · ${preview}` : ""}`;
        })
        .join(" / ");
    case "turn_lifecycle":
      return data.state === "failed"
        ? `${data.state} · ${data.failureCode}${data.failureReason ? ` · ${data.failureReason}` : ""}`
        : `${data.state} · ${data.turnId}`;
    case "turn_routed":
      return `${data.modelProfile} · ${data.modelId} · ${data.reasoningLevel}`;
    case "turn_context":
      return `${data.pluginName} · ${data.kind} · v${data.version}`;
    case "guardian_action_reviewed":
      return `${data.decision} · ${data.toolName} · ${data.riskLevel} risk`;
    case "structured_event":
      return `${data.namespace}.${data.name} · ${data.presentation.title}`;
    case "attachments_delivered":
      return data.attachments
        .map((attachment) => attachment.filename)
        .join(", ");
    case "compaction":
      return data.summary ?? "Agent history compacted";
    case "handoff":
      return `${data.modelProfile} · ${data.modelId}`;
    case "subagent":
      return `${data.subagentKind} · ${data.status} · ${data.childConversationId}`;
  }
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
    (data.type === "subagent" && data.status === "aborted")
  ) {
    return "text-amber-200";
  }
  return "text-dashboard-text-subtle";
}
