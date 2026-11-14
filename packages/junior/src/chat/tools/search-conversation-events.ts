import * as z from "zod";
import {
  KNOWN_CONVERSATION_EVENT_TYPES,
  type ConversationEvent,
  type KnownConversationEventType,
} from "@/chat/conversations/history";
import {
  assertCanReadConversationEvents,
  stripReplacementHistory,
} from "@/chat/conversations/event-access";
import { CONVERSATIONS_TOOL_SOURCE } from "@/chat/conversations/tool-source";
import { getConversationEventStore } from "@/chat/db";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool, zodToolDefinition } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import type { ToolRuntimeContext } from "@/chat/tools/types";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const MAX_EVENT_DATA_BYTES = 4_000;
const MAX_IDENTITY_CHARS = 256;
const textEncoder = new TextEncoder();

const knownEventTypeSchema = z.enum(KNOWN_CONVERSATION_EVENT_TYPES);

const projectedEventSchema = z
  .object({
    seq: z
      .number()
      .int()
      .nonnegative()
      .describe("Stable event position for pagination."),
    history_version: z
      .number()
      .int()
      .nonnegative()
      .describe("Agent history generation after replacement."),
    created_at: z.iso.datetime().describe("When the event was recorded."),
    idempotency_key: z
      .string()
      .min(1)
      .optional()
      .describe("Retry-stable event identity, when assigned."),
    data: z
      .record(z.string(), z.unknown())
      .describe(
        "Bounded event data. Read an omitted payload with readConversationEvent.",
      ),
  })
  .strict();

const searchConversationEventsOutputSchema = juniorToolOutputSchema.extend({
  conversation_id: z.string().min(1),
  events: z.array(projectedEventSchema),
  has_older: z.boolean().describe("Whether matching older events exist."),
  has_newer: z.boolean().describe("Whether matching newer events exist."),
});

export const searchConversationEventsToolDefinition = zodToolDefinition({
  description:
    "Search the durable event log for one conversation, including messages, agent history, tool results, and compactions. Defaults to the current conversation. Outside the current conversation tree, only retained public conversations are accessible.",
  exposure: "deferred",
  source: CONVERSATIONS_TOOL_SOURCE,
  annotations: {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
    readOnlyHint: true,
  },
  inputSchema: z
    .object({
      conversation_id: z
        .string()
        .trim()
        .min(1)
        .nullable()
        .describe(
          "Conversation ID to search. Omit or null for the current conversation.",
        )
        .optional(),
      after_seq: z
        .number()
        .int()
        .nonnegative()
        .nullable()
        .describe("Exclusive event sequence lower bound; returns ascending.")
        .optional(),
      before_seq: z
        .number()
        .int()
        .nonnegative()
        .nullable()
        .describe("Exclusive event sequence upper bound.")
        .optional(),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_LIMIT)
        .nullable()
        .describe(`Maximum events. Default ${DEFAULT_LIMIT}; max ${MAX_LIMIT}.`)
        .optional(),
      types: z
        .array(knownEventTypeSchema)
        .min(1)
        .nullable()
        .describe("Event types to include; omit for all types.")
        .optional(),
    })
    .strict(),
  outputSchema: searchConversationEventsOutputSchema,
});

/** Create a deferred tool that searches one conversation's durable event log. */
export function createSearchConversationEventsTool(
  context: ToolRuntimeContext,
) {
  return zodTool({
    ...searchConversationEventsToolDefinition,
    execute: async (input) => {
      const currentConversationId = context.conversationId;
      const conversationId =
        input.conversation_id?.trim() || currentConversationId;
      const afterSeq = input.after_seq ?? undefined;
      const beforeSeq = input.before_seq ?? undefined;
      const limit = input.limit ?? DEFAULT_LIMIT;
      const types = input.types ?? undefined;
      if (
        afterSeq !== undefined &&
        beforeSeq !== undefined &&
        afterSeq >= beforeSeq
      ) {
        throw new ToolInputError(
          "after_seq must be less than before_seq when both are provided",
        );
      }

      await assertCanReadConversationEvents(context, conversationId);

      const page = await getConversationEventStore().query(conversationId, {
        limit,
        ...(afterSeq === undefined ? undefined : { afterSeq }),
        ...(beforeSeq === undefined ? undefined : { beforeSeq }),
        ...(types === undefined ? undefined : { types }),
      });
      return {
        conversation_id: conversationId,
        events: page.events.map(projectEvent),
        has_older: page.hasOlder,
        has_newer: page.hasNewer,
      };
    },
  });
}

function projectEvent(event: ConversationEvent) {
  const data = boundEventData(
    omitRunTiming(stripReplacementHistory(event.data)),
  );
  return {
    seq: event.seq,
    history_version: event.historyVersion,
    created_at: new Date(event.createdAtMs).toISOString(),
    ...(event.idempotencyKey
      ? { idempotency_key: event.idempotencyKey }
      : undefined),
    data,
  };
}

/**
 * Leave out the `durationMs` that Pi stamps on saved history items. It is
 * wall-clock run timing, not Conversation content, and it differs on every
 * run.
 */
function omitRunTiming(
  data: ConversationEvent["data"] | Record<string, unknown>,
) {
  if (data.type !== "assistant_message" && data.type !== "tool_result") {
    return data;
  }
  const { durationMs: _durationMs, ...rest } = data;
  return rest;
}

function boundEventData(
  data: ConversationEvent["data"] | Record<string, unknown>,
) {
  const payloadJsonBytes = jsonByteLength(data);
  if (payloadJsonBytes <= MAX_EVENT_DATA_BYTES) {
    return data;
  }

  return {
    ...eventIdentity(data),
    payload_omitted: true,
    payload_json_bytes: payloadJsonBytes,
  };
}

function jsonByteLength(value: unknown): number {
  return textEncoder.encode(JSON.stringify(value)).byteLength;
}

function eventIdentity(data: Record<string, unknown>) {
  const identityKeys = [
    "type",
    "originalType",
    "messageId",
    "role",
    "turnId",
    "toolCallId",
    "toolName",
    "subagentInvocationId",
    "subagentKind",
    "childConversationId",
    "outcome",
    "failureCode",
    "provider",
    "kind",
    "modelId",
  ] as const;

  return Object.fromEntries(
    identityKeys.flatMap((key) => {
      const value = data[key];
      return typeof value === "string"
        ? [[key, value.slice(0, MAX_IDENTITY_CHARS)]]
        : [];
    }),
  );
}

export type { KnownConversationEventType };
