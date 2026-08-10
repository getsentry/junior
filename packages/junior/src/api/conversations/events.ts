import type { ConversationEvent } from "@/chat/conversations/history";
import { renderJuniorNativeConversationEvent } from "@/chat/conversations/structured-events";
import { renderPluginConversationEvent } from "@/chat/plugins/conversation-events";
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
  "assistant_message",
  "tool_result",
  "tool_execution_started",
  "guardian_action_reviewed",
  "turn_started",
  "turn_context",
  "structured_event",
  "turn_routed",
  "turn_completed",
  "turn_failed",
  "compaction",
  "handoff",
  "subagent_started",
  "subagent_ended",
] as const;

const reportingAssistantMessageSchema = z
  .object({
    type: z.literal("assistant_message"),
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
    type: z.literal("tool_result"),
    toolCallId: z.string().min(1),
    toolName: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
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

const reportingReasoningPartSchema = z
  .object({
    type: z.literal("thinking"),
    thinking: z.string(),
    redacted: z.literal(true).optional(),
  })
  .passthrough();

const reportingMediaPartSchema = z
  .object({
    type: z.enum(["image", "audio"]),
    mimeType: z.string().min(1).optional(),
  })
  .passthrough();

const reportingMessageAuthorSchema = z
  .object({
    fullName: z.string().min(1).optional(),
    userId: z.string().min(1).optional(),
    userName: z.string().min(1).optional(),
  })
  .passthrough();

type ReportingModelContentPart =
  | { type: "text"; text: string }
  | { type: "image" | "audio"; mimeType?: string };

type ToolStart = {
  createdAtMs: number;
  name: string;
  seq: number;
};

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

function reportMessageActorIdentity(
  data: Extract<ConversationEvent["data"], { type: "message" }>,
): Extract<ConversationReportEventData, { type: "message" }>["actorIdentity"] {
  if (data.role !== "user") return undefined;
  const author = reportingMessageAuthorSchema.safeParse(data.meta?.author);
  if (!author.success) return undefined;
  const actorIdentity = {
    ...(author.data.fullName ? { fullName: author.data.fullName } : {}),
    ...(author.data.userId ? { slackUserId: author.data.userId } : {}),
    ...(author.data.userName ? { slackUserName: author.data.userName } : {}),
  };
  return Object.keys(actorIdentity).length > 0 ? actorIdentity : undefined;
}

/** Project native assistant tool calls through the existing reporting shape. */
function reportToolCalls(args: {
  canExposePayload: boolean;
  createdAtMs: number;
  message: unknown;
  seq: number;
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
        status: "running" as const,
        startedAt: new Date(args.createdAtMs).toISOString(),
        startedSeq: args.seq,
        ...(args.canExposePayload && call.data.arguments !== undefined
          ? { input: call.data.arguments }
          : {}),
      },
    ];
  });
  return calls.length > 0 ? { type: "tool_calls", calls } : undefined;
}

/** Project assistant reasoning with tool ids retained only for display order. */
function reportAssistantMessage(args: {
  canExposePayload: boolean;
  createdAtMs: number;
  message: unknown;
  seq: number;
}): ConversationReportEventData | undefined {
  const message = reportingAssistantMessageSchema.safeParse(args.message);
  if (!message.success) return undefined;

  const hasReasoning = message.data.content.some((part) => {
    const reasoning = reportingReasoningPartSchema.safeParse(part);
    return (
      reasoning.success &&
      reasoning.data.redacted !== true &&
      reasoning.data.thinking.trim().length > 0
    );
  });
  if (!hasReasoning) return reportToolCalls(args);

  const reasoningParts: Extract<
    ConversationReportEventData,
    { type: "assistant_message" }
  >["parts"] = [];
  const assistantParts: NonNullable<
    Extract<ConversationReportEventData, { type: "tool_calls" }>["assistant"]
  >["parts"] = [];
  for (const part of message.data.content) {
    const reasoning = reportingReasoningPartSchema.safeParse(part);
    if (reasoning.success) {
      if (
        reasoning.data.redacted !== true &&
        reasoning.data.thinking.trim().length > 0
      ) {
        const projected = {
          type: "reasoning" as const,
          ...(args.canExposePayload
            ? { text: reasoning.data.thinking }
            : { redacted: true as const }),
        };
        reasoningParts.push(projected);
        assistantParts.push(projected);
      }
      continue;
    }

    const call = reportingToolCallPartSchema.safeParse(part);
    if (call.success) {
      assistantParts.push({
        type: "tool_call" as const,
        toolCallId: call.data.id,
      });
    }
  }
  const toolCalls = reportToolCalls(args);
  if (toolCalls?.type === "tool_calls") {
    return { ...toolCalls, assistant: { parts: assistantParts } };
  }
  return reasoningParts.length > 0
    ? { type: "assistant_message", parts: reasoningParts }
    : undefined;
}

/** Project a native tool result without exposing host-only result details. */
function reportToolResult(args: {
  canExposePayload: boolean;
  message: unknown;
  start?: ToolStart;
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
  const name = message.data.toolName ?? message.data.name ?? args.start?.name;
  if (!name) return undefined;
  return {
    type: "tool_calls",
    calls: [
      {
        toolCallId: message.data.toolCallId,
        name,
        status: outcome,
        ...(args.start
          ? {
              startedAt: new Date(args.start.createdAtMs).toISOString(),
              startedSeq: args.start.seq,
            }
          : {}),
        ...(args.canExposePayload && output !== undefined ? { output } : {}),
      },
    ],
  };
}

/** Return tool result ids that may need start metadata from outside a page. */
export function conversationReportToolResultIds(
  events: ConversationEvent[],
): string[] {
  return [
    ...new Set(
      events.flatMap((event) => {
        const result = reportingToolResultMessageSchema.safeParse(event.data);
        return result.success ? [result.data.toolCallId] : [];
      }),
    ),
  ];
}

function reportEventData(args: {
  canExposePayload: boolean;
  data: ConversationEvent["data"];
}): ConversationReportEventData | undefined {
  const { data } = args;
  if (data.type === "structured_event") {
    if (!args.canExposePayload) return undefined;
    const presentation =
      data.namespace === "junior"
        ? renderJuniorNativeConversationEvent(data)
        : renderPluginConversationEvent(data);
    if (!presentation) return undefined;
    return {
      type: "structured_event",
      namespace: data.namespace,
      name: data.name,
      version: data.version,
      ...(data.turnId ? { turnId: data.turnId } : {}),
      presentation,
    };
  }
  switch (data.type) {
    case "message": {
      const actorIdentity = args.canExposePayload
        ? reportMessageActorIdentity(data)
        : undefined;
      return {
        type: "message",
        messageId: data.messageId,
        role: data.role,
        ...(data.meta?.source === "web" ? { source: "web" as const } : {}),
        ...(actorIdentity ? { actorIdentity } : {}),
        ...(typeof data.meta?.eventType === "string"
          ? { eventType: data.meta.eventType }
          : {}),
        ...(args.canExposePayload
          ? { text: data.text }
          : { redacted: true as const }),
      };
    }
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
    case "turn_context":
      if (!args.canExposePayload) {
        return undefined;
      }
      return {
        type: "turn_context",
        turnId: data.turnId,
        pluginName: data.pluginName,
        kind: data.kind,
        version: data.version,
        content: data.content,
      };
    case "turn_routed":
      return {
        type: "turn_routed",
        turnId: data.turnId,
        modelProfile: data.modelProfile,
        modelId: data.modelId,
        ...(data.costUsd !== undefined ? { costUsd: data.costUsd } : {}),
        reasoningLevel: data.reasoningLevel,
        ...(data.confidence !== undefined
          ? { confidence: data.confidence }
          : {}),
        source: data.source,
      };
    case "guardian_action_reviewed":
      return {
        type: "guardian_action_reviewed",
        turnId: data.turnId,
        toolCallId: data.toolCallId,
        toolName: data.toolName,
        decision: data.decision,
        riskLevel: data.riskLevel,
        userAuthorization: data.userAuthorization,
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
      return {
        type: "compaction",
        modelProfile: data.modelProfile,
        modelId: data.modelId,
        ...(args.canExposePayload && data.summary
          ? { summary: data.summary }
          : {}),
        ...(data.details ? { details: data.details } : {}),
      };
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
export function projectConversationReportEventPage(args: {
  canExposePayload: boolean;
  events: ConversationEvent[];
  subagentStartEvents?: ConversationEvent[];
  toolStartEvents?: ConversationEvent[];
}): ConversationReportEvent[] {
  const subagentStarts = new Map<
    string,
    {
      createdAtMs: number;
      data: Extract<ConversationEvent["data"], { type: "subagent_started" }>;
      seq: number;
    }
  >();
  for (const event of args.subagentStartEvents ?? []) {
    if (event.data.type === "subagent_started") {
      subagentStarts.set(event.data.subagentInvocationId, {
        createdAtMs: event.createdAtMs,
        data: event.data,
        seq: event.seq,
      });
    }
  }
  const toolStarts = new Map<string, ToolStart>();
  for (const event of args.toolStartEvents ?? []) {
    if (event.data.type === "tool_execution_started") {
      const current = toolStarts.get(event.data.toolCallId);
      if (!current || event.seq < current.seq) {
        toolStarts.set(event.data.toolCallId, {
          createdAtMs: event.createdAtMs,
          name: event.data.toolName,
          seq: event.seq,
        });
      }
    }
  }
  const projected: ConversationReportEvent[] = [];

  for (const event of args.events) {
    let data: ConversationReportEventData | undefined;
    if (
      event.data.type === "assistant_message" ||
      event.data.type === "tool_result"
    ) {
      const reportArgs = {
        canExposePayload: args.canExposePayload,
        createdAtMs: event.createdAtMs,
        message: event.data,
        seq: event.seq,
      };
      const result = reportingToolResultMessageSchema.safeParse(event.data);
      const start = result.success
        ? toolStarts.get(result.data.toolCallId)
        : undefined;
      data =
        reportAssistantMessage(reportArgs) ??
        reportToolResult({
          canExposePayload: args.canExposePayload,
          message: event.data,
          ...(start && start.seq < event.seq ? { start } : {}),
        });
    } else if (event.data.type === "tool_execution_started") {
      toolStarts.set(event.data.toolCallId, {
        createdAtMs: event.createdAtMs,
        name: event.data.toolName,
        seq: event.seq,
      });
      data = {
        type: "tool_calls",
        calls: [
          {
            toolCallId: event.data.toolCallId,
            name: event.data.toolName,
            status: "running",
            startedAt: new Date(event.createdAtMs).toISOString(),
            startedSeq: event.seq,
          },
        ],
      };
    } else if (event.data.type === "subagent_started") {
      subagentStarts.set(event.data.subagentInvocationId, {
        createdAtMs: event.createdAtMs,
        data: event.data,
        seq: event.seq,
      });
      data = {
        type: "subagent",
        startedSeq: event.seq,
        startedAt: new Date(event.createdAtMs).toISOString(),
        childConversationId: event.data.childConversationId,
        subagentKind: event.data.subagentKind,
        status: "running",
        ...(event.data.parentToolCallId
          ? { parentToolCallId: event.data.parentToolCallId }
          : {}),
      };
    } else if (event.data.type === "subagent_ended") {
      const started = subagentStarts.get(event.data.subagentInvocationId);
      if (started && started.seq < event.seq) {
        data = {
          type: "subagent",
          startedSeq: started.seq,
          startedAt: new Date(started.createdAtMs).toISOString(),
          childConversationId: started.data.childConversationId,
          subagentKind: started.data.subagentKind,
          ...(started.data.parentToolCallId
            ? { parentToolCallId: started.data.parentToolCallId }
            : {}),
          status:
            event.data.outcome === "success" ? "completed" : event.data.outcome,
        };
        subagentStarts.delete(event.data.subagentInvocationId);
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
        ...(args.canExposePayload && event.data.summary
          ? { summary: event.data.summary }
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
