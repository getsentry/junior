import type { ConversationReportEvent } from "@sentry/junior/api/schema";

import type { ConversationTranscript } from "../types";
import { isMemoryCaptureEvent } from "./conversationMemory";
import type { TranscriptViewMode } from "./transcriptRenderModel";

/** Build a version that changes only when a visible Junior message appears. */
export function transcriptJuniorMessageVersion(
  conversation: ConversationTranscript | undefined,
): string {
  if (!conversation) return "empty";
  for (let index = conversation.events.length - 1; index >= 0; index -= 1) {
    const event = conversation.events[index]!;
    const data = event.data;
    if (data.type === "message" && data.role === "assistant") {
      return [
        event.seq,
        event.createdAt,
        data.messageId,
        data.redacted ? "redacted" : (data.text?.length ?? 0),
      ].join(":");
    }
    if (data.type === "assistant_message" && data.parts.length > 0) {
      const lastPart = data.parts.at(-1);
      return [
        event.seq,
        event.createdAt,
        data.parts.length,
        lastPart?.redacted ? "redacted" : (lastPart?.text?.length ?? 0),
      ].join(":");
    }
  }
  return "empty";
}

/** Build a compact visible-tail key so metadata-only polls do not look new. */
export function transcriptBottomVersion(
  conversation: ConversationTranscript | undefined,
  view: TranscriptViewMode = "rich",
): string {
  if (!conversation) return "empty";

  // Only the visible tail matters. Earlier pages must not count as new activity.
  // The event log shows all events; the transcript omits some metadata events.
  let last: ConversationReportEvent | undefined;
  for (let index = conversation.events.length - 1; index >= 0; index -= 1) {
    const event = conversation.events[index]!;
    if (view === "rich" && !changesVisibleTranscript(event)) continue;
    last = event;
    break;
  }

  return [
    conversation.conversationId,
    conversation.status,
    last?.seq ?? "",
    last?.createdAt ?? "",
    eventTailVersion(last),
  ].join("|");
}

/**
 * Build a version that changes only when the rich transcript gets a row that
 * is not in a collapsed activity group, or when the Turn ends. A collapsed
 * group shows only its label, so its events are not news for the reader.
 */
export function transcriptNoticeVersion(
  conversation: ConversationTranscript | undefined,
): string {
  if (!conversation) return "empty";
  let last: ConversationReportEvent | undefined;
  for (let index = conversation.events.length - 1; index >= 0; index -= 1) {
    const event = conversation.events[index]!;
    if (!showsOutsideActivity(event)) continue;
    last = event;
    break;
  }
  return [
    conversation.conversationId,
    conversation.status,
    last?.seq ?? "",
    eventTailVersion(last),
  ].join("|");
}

// Keep in step with isCollapsibleActivityEntry and quietTurnEntryKeys.
function showsOutsideActivity(event: ConversationReportEvent): boolean {
  const data = event.data;
  if (data.type === "turn_lifecycle") return data.state === "failed";
  if (data.type === "message") return !data.quiet;
  if (data.type === "structured_event") return isMemoryCaptureEvent(data);
  return data.type === "subagent" || data.type === "attachments_delivered";
}

function changesVisibleTranscript(event: ConversationReportEvent): boolean {
  const data = event.data;
  if (data.type === "turn_lifecycle") return data.state === "failed";
  return (
    data.type === "message" ||
    (data.type === "assistant_message" && data.parts.length > 0) ||
    data.type === "tool_calls" ||
    data.type === "subagent" ||
    data.type === "structured_event" ||
    data.type === "attachments_delivered" ||
    data.type === "compaction"
  );
}

function eventTailVersion(event: ConversationReportEvent | undefined): string {
  if (!event) return "";
  const data = event.data;
  switch (data.type) {
    case "message":
      return [
        data.type,
        data.role,
        data.messageId,
        data.redacted ? "redacted" : (data.text?.length ?? 0),
        data.eventType ?? "",
      ].join(":");
    case "assistant_message": {
      const parts = data.parts;
      const lastPart = parts.at(-1);
      return [
        data.type,
        parts.length,
        lastPart?.redacted ? "redacted" : (lastPart?.text?.length ?? 0),
      ].join(":");
    }
    case "tool_calls": {
      const call = data.calls.at(-1);
      return [
        data.type,
        data.calls.length,
        call?.toolCallId ?? "",
        call?.name ?? "",
        call?.status ?? "",
        call?.output === undefined ? "" : "output",
      ].join(":");
    }
    case "subagent":
      return [
        data.type,
        data.childConversationId,
        data.status,
        data.subagentKind,
        data.parentToolCallId ?? "",
      ].join(":");
    case "turn_lifecycle":
      return [
        data.type,
        data.turnId,
        data.state,
        "failureCode" in data ? data.failureCode : "",
        "failureReason" in data ? (data.failureReason ?? "") : "",
      ].join(":");
    case "structured_event":
      return [
        data.type,
        data.namespace,
        data.name,
        data.version,
        data.presentation.title,
        data.presentation.preview?.length ?? 0,
      ].join(":");
    case "message_handled":
      return [data.type, data.messageId].join(":");
    case "attachments_delivered":
      return [
        data.type,
        data.attachments.length,
        ...data.attachments.map(
          (attachment) =>
            `${attachment.id}:${attachment.filename}:${attachment.bytes}`,
        ),
      ].join(":");
    case "compaction":
      return [data.type, data.summary?.length ?? 0, event.createdAt].join(":");
    case "guardian_action_reviewed":
      return [data.type, data.turnId, data.toolCallId, data.decision].join(":");
    case "turn_context":
      return [
        data.type,
        data.turnId,
        data.pluginName,
        data.kind,
        data.version,
      ].join(":");
    default:
      return `${(data as { type?: string }).type ?? "unknown"}:${event.seq}`;
  }
}
