import type {
  ConversationEvent,
  ConversationModelMessage,
} from "@/chat/conversations/history";
import {
  conversationReportEventSchema,
  type ConversationReportEvent,
  type ConversationReportEventData,
} from "./schema";

interface SubagentReference {
  childConversationId: string;
  subagentKind: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function modelActivities(
  message: ConversationModelMessage,
): Array<"thinking" | "tool_call" | "tool_result"> {
  const record = message as Record<string, unknown>;
  const activities = new Set<"thinking" | "tool_call" | "tool_result">();
  if (record.role === "toolResult") activities.add("tool_result");

  const content = record.content;
  if (!Array.isArray(content)) return [...activities];
  for (const part of content) {
    if (!isRecord(part)) continue;
    if (part.type === "thinking") activities.add("thinking");
    if (part.type === "toolCall") activities.add("tool_call");
    if (part.type === "toolResult") activities.add("tool_result");
  }
  return [...activities];
}

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
    case "message": {
      const activities = modelActivities(data.message);
      return activities.length > 0
        ? { type: "model_activity", activities }
        : undefined;
    }
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
  const subagents = new Map<string, SubagentReference>();
  const projected: ConversationReportEvent[] = [];

  for (const event of args.events) {
    let data: ConversationReportEventData | undefined;
    if (event.data.type === "subagent_started") {
      const reference: SubagentReference = {
        childConversationId: event.data.childConversationId,
        subagentKind: event.data.subagentKind,
      };
      subagents.set(event.data.subagentInvocationId, reference);
      data = { type: "subagent_started", ...reference };
    } else if (event.data.type === "subagent_ended") {
      const reference = subagents.get(event.data.subagentInvocationId);
      if (reference) {
        data = {
          type: "subagent_ended",
          ...reference,
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
