import * as z from "zod";
import type { PluginEmbedder } from "@sentry/junior-plugin-api";
import {
  KNOWN_CONVERSATION_EVENT_TYPES,
  type ConversationEvent,
  type KnownConversationEventType,
} from "@/chat/conversations/history";
import {
  assertCanReadConversationEvents,
  stripReplacementHistory,
} from "@/chat/conversations/event-access";
import { searchConversationEventText } from "@/chat/conversations/event-search";
import { CONVERSATIONS_TOOL_SOURCE } from "@/chat/conversations/tool-source";
import { getConversationEventStore, getDb } from "@/chat/db";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool, zodToolDefinition } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import type { ToolRuntimeContext } from "@/chat/tools/types";

/** Events that a search returns when the call sets no limit. */
export const DEFAULT_EVENT_SEARCH_LIMIT = 25;
const MAX_LIMIT = 100;
const MAX_EVENT_DATA_BYTES = 4_000;
const MAX_IDENTITY_CHARS = 256;
const MAX_QUERY_CHARS = 200;
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
        "Bounded event data. With a query, only its identity fields. Read an omitted payload with readConversationEvent.",
      ),
    excerpt: z
      .string()
      .optional()
      .describe("Event text around the best query match."),
  })
  .strict();

const searchConversationEventsOutputSchema = juniorToolOutputSchema.extend({
  conversation_id: z.string().min(1),
  events: z
    .array(projectedEventSchema)
    .describe("Best match first for a query, else in seq order."),
  has_older: z
    .boolean()
    .optional()
    .describe("Whether matching older events exist. Omitted for a query."),
  has_newer: z
    .boolean()
    .optional()
    .describe("Whether matching newer events exist. Omitted for a query."),
});

export const searchConversationEventsToolDefinition = zodToolDefinition({
  description:
    "Search the durable event log for one conversation, including messages, agent history, tool results, and compactions, across every history version. Finds events by words or meaning, or pages them in seq order. Defaults to the current conversation. Outside the current conversation tree, only retained public conversations are accessible.",
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
      query: z
        .string()
        .trim()
        .min(1)
        .max(MAX_QUERY_CHARS)
        .nullable()
        .describe(
          "Words or meaning to find in messages, agent history, and tool calls and results, such as a path, URL, id, or name. Any word may match. Omit or null to page in seq order.",
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
        .describe(
          `Maximum events. Default ${DEFAULT_EVENT_SEARCH_LIMIT}; max ${MAX_LIMIT}.`,
        )
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
  options: {
    /** Embeds a query to also match events by meaning. */
    embedder?: PluginEmbedder;
  } = {},
) {
  return zodTool({
    ...searchConversationEventsToolDefinition,
    execute: async (input) => {
      const currentConversationId = context.conversationId;
      const conversationId =
        input.conversation_id?.trim() || currentConversationId;
      const afterSeq = input.after_seq ?? undefined;
      const beforeSeq = input.before_seq ?? undefined;
      const limit = input.limit ?? DEFAULT_EVENT_SEARCH_LIMIT;
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

      const query = input.query ?? undefined;
      if (query) {
        const matches = await searchConversationEventText(getDb(), {
          conversationId,
          limit,
          query,
          ...(afterSeq === undefined ? undefined : { afterSeq }),
          ...(beforeSeq === undefined ? undefined : { beforeSeq }),
          ...(types === undefined ? undefined : { types }),
          ...(options.embedder ? { embedder: options.embedder } : undefined),
        });
        return {
          conversation_id: conversationId,
          events: matches.map((match) => ({
            ...projectEvent(match.event, { omitPayload: true }),
            excerpt: match.excerpt,
          })),
        };
      }

      const page = await getConversationEventStore().query(conversationId, {
        limit,
        ...(afterSeq === undefined ? undefined : { afterSeq }),
        ...(beforeSeq === undefined ? undefined : { beforeSeq }),
        ...(types === undefined ? undefined : { types }),
      });
      return {
        conversation_id: conversationId,
        events: page.events.map((event) => projectEvent(event)),
        has_older: page.hasOlder,
        has_newer: page.hasNewer,
      };
    },
  });
}

function projectEvent(
  event: ConversationEvent,
  options: { omitPayload?: boolean } = {},
) {
  const data = boundEventData(stripReplacementHistory(event.data), options);
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

function boundEventData(
  data: ConversationEvent["data"] | Record<string, unknown>,
  options: { omitPayload?: boolean },
) {
  const payloadJsonBytes = jsonByteLength(data);
  if (!options.omitPayload && payloadJsonBytes <= MAX_EVENT_DATA_BYTES) {
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
