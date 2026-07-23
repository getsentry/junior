import type { ConversationEvent } from "@/chat/conversations/history";
import { z } from "zod";
import {
  conversationReportEventSchema,
  type ConversationReportEvent,
  type ConversationReportEventData,
} from "../schema/conversation";

/** Canonical event types that can contribute to the reporting projection. */
export const conversationReportSourceEventTypes = [
  "message",
  "message_handled",
  "agent_step",
  "tool_execution_started",
  "turn_started",
  "turn_completed",
  "turn_failed",
  "compaction",
  "handoff",
  "subagent_started",
  "subagent_ended",
] as const;

const reportingAssistantMessageSchema = z
  .object({
    role: z.literal("assistant"),
    content: z.array(z.unknown()),
  })
  .passthrough();

const reportingToolCallPartSchema = z
  .object({
    type: z.literal("toolCall"),
    id: z.string().min(1),
    name: z.string().min(1),
    arguments: z.unknown(),
  })
  .passthrough();

const reportingToolResultMessageSchema = z
  .object({
    role: z.literal("toolResult"),
    toolCallId: z.string().min(1),
    content: z.array(z.unknown()),
    details: z.unknown().optional(),
    isError: z.boolean().optional(),
  })
  .passthrough();

const reportingToolResultDetailsSchema = z
  .object({
    ok: z.boolean().optional(),
    status: z.string().optional(),
  })
  .passthrough();

const reportingTextPartSchema = z
  .object({ type: z.literal("text"), text: z.string() })
  .passthrough();

const reportingMediaPartSchema = z
  .object({
    type: z.enum(["image", "audio"]),
    mimeType: z.string().min(1).optional(),
  })
  .passthrough();

type ReportingModelContentPart =
  | { type: "text"; text: string }
  | { type: "image" | "audio"; mimeType?: string };

/** Retain model-visible text and media descriptors, dropping all opaque fields. */
function sanitizeModelContentPart(
  value: unknown,
): ReportingModelContentPart | undefined {
  const text = reportingTextPartSchema.safeParse(value);
  if (text.success) return { type: "text", text: text.data.text };

  const media = reportingMediaPartSchema.safeParse(value);
  if (!media.success) return undefined;
  return {
    type: media.data.type,
    ...(media.data.mimeType ? { mimeType: media.data.mimeType } : {}),
  };
}

/** Convert allowlisted Pi content parts into the reporting result value. */
function modelVisibleToolOutput(content: unknown[]): unknown {
  const sanitized = content
    .map(sanitizeModelContentPart)
    .filter((part) => part !== undefined);
  if (sanitized.length === 0) return undefined;
  if (sanitized.length !== 1) return sanitized;

  const only = sanitized[0]!;
  return only.type === "text" ? only.text : only;
}

/** Project canonical Pi tool calls into the narrow reporting contract. */
function reportToolCalls(args: {
  canExposePayload: boolean;
  message: unknown;
}): ConversationReportEventData | undefined {
  const message = reportingAssistantMessageSchema.safeParse(args.message);
  if (!message.success) return undefined;

  const calls = message.data.content.flatMap((part) => {
    const call = reportingToolCallPartSchema.safeParse(part);
    if (!call.success) return [];
    return [
      {
        toolCallId: call.data.id,
        name: call.data.name,
        ...(args.canExposePayload && call.data.arguments !== undefined
          ? { input: call.data.arguments }
          : {}),
      },
    ];
  });
  return calls.length > 0 ? { type: "tool_calls", calls } : undefined;
}

/** Project a Pi tool result without exposing host-only result details. */
function reportToolResult(args: {
  canExposePayload: boolean;
  message: unknown;
}): ConversationReportEventData | undefined {
  const message = reportingToolResultMessageSchema.safeParse(args.message);
  if (!message.success) return undefined;

  const details = reportingToolResultDetailsSchema.safeParse(
    message.data.details,
  );
  const outcome =
    message.data.isError === true ||
    (details.success &&
      (details.data.ok === false || details.data.status === "error"))
      ? "error"
      : "completed";
  const output = modelVisibleToolOutput(message.data.content);
  return {
    type: "tool_result",
    toolCallId: message.data.toolCallId,
    outcome,
    ...(args.canExposePayload && output !== undefined ? { output } : {}),
  };
}

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
        ...(typeof data.meta?.eventType === "string"
          ? { eventType: data.meta.eventType }
          : {}),
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
  const projected: ConversationReportEvent[] = [];

  for (const event of args.events) {
    let data: ConversationReportEventData | undefined;
    if (event.data.type === "agent_step") {
      const reportArgs = {
        canExposePayload: args.canExposePayload,
        message: event.data.message,
      };
      data = reportToolCalls(reportArgs) ?? reportToolResult(reportArgs);
    } else if (event.data.type === "tool_execution_started") {
      data = {
        type: "tool_started",
        toolCallId: event.data.toolCallId,
        name: event.data.toolName,
      };
    } else if (event.data.type === "subagent_started") {
      subagentStarts.set(event.data.subagentInvocationId, event.seq);
      data = {
        type: "subagent_started",
        childConversationId: event.data.childConversationId,
        subagentKind: event.data.subagentKind,
        ...(event.data.parentToolCallId
          ? { parentToolCallId: event.data.parentToolCallId }
          : {}),
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
      data = {
        type: "handoff",
        modelProfile: event.data.modelProfile,
        modelId: event.data.modelId,
        ...(event.data.reasoningLevel
          ? { reasoningLevel: event.data.reasoningLevel }
          : {}),
        ...(event.data.triggeringToolCallId
          ? { triggeringToolCallId: event.data.triggeringToolCallId }
          : {}),
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
