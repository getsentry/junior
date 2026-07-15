import type { ConversationEvent } from "@/chat/conversations/history";
import {
  conversationReportEventSchema,
  type ConversationReportEvent,
  type ConversationReportEventData,
} from "./schema";

function reportEventData(args: {
  canExposePayload: boolean;
  data: ConversationEvent["data"];
}): ConversationReportEventData | undefined {
  const { data } = args;
  switch (data.type) {
    case "visible_message_recorded":
      return {
        type: "visible_message",
        messageId: data.messageId,
        role: data.role,
        ...(args.canExposePayload
          ? { text: data.text }
          : { redacted: true as const }),
      };
    case "visible_message_replied":
      return {
        type: "visible_message_replied",
        messageId: data.messageId,
      };
    case "message":
      return undefined;
    case "tool_execution_started":
      return { type: "tool_started", name: data.toolName };
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
      };
    case "context_epoch_started":
      if (data.reason === "compaction") return { type: "context_compacted" };
      if (data.reason === "handoff") return { type: "model_handoff" };
      return undefined;
    case "delivery_intended":
      return {
        type: "delivery",
        deliveryId: data.deliveryId,
        state: "intended",
      };
    case "delivery_accepted":
      return {
        type: "delivery",
        deliveryId: data.deliveryId,
        state: "accepted",
      };
    case "delivery_failed":
      return {
        type: "delivery",
        deliveryId: data.deliveryId,
        state: "failed",
      };
    default:
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
  const projected: ConversationReportEvent[] = [];

  for (const event of args.events) {
    let data: ConversationReportEventData | undefined;
    if (event.data.type === "subagent_started") {
      subagentStarts.set(event.data.subagentInvocationId, event.seq);
      data = {
        type: "subagent_started",
        childConversationId: event.data.childConversationId,
        subagentKind: event.data.subagentKind,
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
