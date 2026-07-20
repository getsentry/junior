import type { ConversationEvent } from "@/chat/conversations/history";
import {
  conversationReportEventSchema,
  type ConversationReportEvent,
  type ConversationReportEventData,
} from "./schema";

/** Canonical event types that can contribute to the reporting projection. */
export const conversationReportSourceEventTypes = [
  "message",
  "message_handled",
  "tool_execution_started",
  "turn_started",
  "turn_completed",
  "turn_failed",
  "compaction",
  "handoff",
  "subagent_started",
  "subagent_ended",
] as const;

function reportEventData(args: {
  canExposePayload: boolean;
  data: ConversationEvent["data"];
}): ConversationReportEventData | undefined {
  const { data } = args;
  switch (data.type) {
    case "message":
      return {
        type: "message",
        messageId: data.messageId,
        role: data.role,
        ...(args.canExposePayload
          ? { text: data.text }
          : { redacted: true as const }),
      };
    case "message_handled":
      return {
        type: "message_handled",
        messageId: data.messageId,
      };
    case "turn_started":
      return {
        type: "turn_lifecycle",
        turnId: data.turnId,
        state: "started",
      };
    case "turn_completed":
      return {
        type: "turn_lifecycle",
        turnId: data.turnId,
        state: data.outcome === "success" ? "succeeded" : "no_reply",
      };
    case "turn_failed":
      return {
        type: "turn_lifecycle",
        turnId: data.turnId,
        state: "failed",
        failureKind:
          data.failureCode === "delivery_failed" ? "delivery" : "agent",
      };
    case "compaction":
      return { type: "compaction" };
    default:
      // Unsupported and host-only facts do not affect this observational view.
      return undefined;
  }
}

/**
 * Project canonical events into the ordered reporting boundary.
 *
 * `canExposePayload` must come from the authorized conversation-detail policy;
 * this projection never derives visibility or authorization from event data.
 */
export function projectConversationReportEvents(args: {
  canExposePayload: boolean;
  events: ConversationEvent[];
}): ConversationReportEvent[] {
  const subagentStarts = new Map<string, number>();
  const toolStarts = new Map<string, number>();
  const projected: ConversationReportEvent[] = [];

  for (const event of args.events) {
    let data: ConversationReportEventData | undefined;
    if (event.data.type === "tool_execution_started") {
      toolStarts.set(event.data.toolCallId, event.seq);
      data = { type: "tool_started", name: event.data.toolName };
    } else if (event.data.type === "subagent_started") {
      subagentStarts.set(event.data.subagentInvocationId, event.seq);
      const toolStartedSeq = event.data.parentToolCallId
        ? toolStarts.get(event.data.parentToolCallId)
        : undefined;
      data = {
        type: "subagent_started",
        childConversationId: event.data.childConversationId,
        subagentKind: event.data.subagentKind,
        ...(toolStartedSeq === undefined ? {} : { toolStartedSeq }),
      };
    } else if (event.data.type === "subagent_ended") {
      const startedSeq = subagentStarts.get(event.data.subagentInvocationId);
      if (startedSeq !== undefined) {
        data = {
          type: "subagent_ended",
          startedSeq,
          outcome: event.data.outcome,
        };
      }
    } else if (event.data.type === "handoff") {
      const toolStartedSeq = toolStarts.get(event.data.triggeringToolCallId);
      data = {
        type: "handoff",
        ...(toolStartedSeq === undefined ? {} : { toolStartedSeq }),
      };
    } else {
      data = reportEventData({
        canExposePayload: args.canExposePayload,
        data: event.data,
      });
    }
    if (!data) continue;

    projected.push(
      conversationReportEventSchema.parse({
        seq: event.seq,
        createdAt: new Date(event.createdAtMs).toISOString(),
        data,
      }),
    );
  }

  return projected;
}
