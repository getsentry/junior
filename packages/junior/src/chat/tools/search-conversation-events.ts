import { z } from "zod";
import {
  canExposeConversationPayload,
  type ConversationPrivacy,
} from "@/chat/conversation-privacy";
import {
  KNOWN_CONVERSATION_EVENT_TYPES,
  type ConversationEvent,
  type ConversationEventPage,
  type KnownConversationEventType,
} from "@/chat/conversations/history";
import type { ConversationStore } from "@/chat/conversations/store";
import { CONVERSATIONS_TOOL_SOURCE } from "@/chat/conversations/tool-source";
import { getConversationEventStore, getConversationStore } from "@/chat/db";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import type { ToolRuntimeContext } from "@/chat/tools/types";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const MAX_EVENT_DATA_BYTES = 4_000;
const MAX_EVENTS_JSON_BYTES = 20_000;
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
    data: z.record(z.string(), z.unknown()).describe("Bounded event data."),
  })
  .strict();

const searchConversationEventsOutputSchema = juniorToolOutputSchema.extend({
  conversation_id: z.string().min(1),
  events: z.array(projectedEventSchema),
  has_older: z.boolean().describe("Whether matching older events exist."),
  has_newer: z.boolean().describe("Whether matching newer events exist."),
  omitted_event_count: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Events omitted by the response byte limit."),
});

interface ConversationEventAccessScope {
  currentConversationId: string;
  currentRootConversationId?: string;
  provider?: string;
  providerTenantId?: string;
}

/** Create a deferred tool that searches one conversation's durable event log. */
export function createSearchConversationEventsTool(
  context: ToolRuntimeContext,
) {
  return zodTool({
    description:
      "Search the durable event log for one conversation, including messages, agent history, tool results, handoffs, and compactions. Defaults to the current conversation. Outside the current conversation tree, only retained public conversations in the current Slack workspace are accessible.",
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
          .describe(
            `Maximum events. Default ${DEFAULT_LIMIT}; max ${MAX_LIMIT}.`,
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

      const conversationStore = getConversationStore();
      const target = await conversationStore.get({ conversationId });
      if (!target) {
        throw new ToolInputError(`Conversation not found: ${conversationId}`);
      }
      if (target.transcriptPurgedAtMs !== undefined) {
        throw new ToolInputError(
          `Conversation transcript was purged: ${conversationId}`,
        );
      }

      const accessScope = await resolveAccessScope(
        conversationStore,
        context,
        currentConversationId,
      );
      // A Conversation with a parent uses the root privacy boundary.
      const targetRootConversationId = await resolveRootConversationId(
        conversationStore,
        conversationId,
        target.parentConversationId,
      );
      const targetRoot =
        targetRootConversationId === conversationId
          ? target
          : await conversationStore.get({
              conversationId: targetRootConversationId,
            });
      assertCanSearchConversationEvents({
        accessScope,
        targetConversationId: conversationId,
        targetRootConversationId,
        targetVisibility: targetRoot?.visibility ?? target.visibility,
        targetDestination: targetRoot?.destination ?? target.destination,
      });

      const page = await getConversationEventStore().query(conversationId, {
        limit,
        ...(afterSeq === undefined ? undefined : { afterSeq }),
        ...(beforeSeq === undefined ? undefined : { beforeSeq }),
        ...(types === undefined ? undefined : { types }),
      });
      const newestFirst = afterSeq === undefined;
      const projected = projectEventsForTool(page, { newestFirst });

      return {
        conversation_id: conversationId,
        events: projected.events,
        has_older:
          page.hasOlder || (newestFirst && projected.omittedEventCount > 0),
        has_newer:
          page.hasNewer || (!newestFirst && projected.omittedEventCount > 0),
        truncated: projected.omittedEventCount > 0,
        ...(projected.omittedEventCount > 0
          ? { omitted_event_count: projected.omittedEventCount }
          : undefined),
      };
    },
  });
}

async function resolveAccessScope(
  conversationStore: ConversationStore,
  context: ToolRuntimeContext,
  currentConversationId: string,
): Promise<ConversationEventAccessScope> {
  const current = await conversationStore.get({
    conversationId: currentConversationId,
  });
  const currentRootConversationId = current
    ? await resolveRootConversationId(
        conversationStore,
        currentConversationId,
        current.parentConversationId,
      )
    : currentConversationId;

  if (context.source.kind === "slack") {
    return {
      currentConversationId,
      currentRootConversationId,
      provider: "slack",
      providerTenantId: context.source.teamId,
    };
  }

  if (
    context.destination.platform === "slack" &&
    "teamId" in context.destination
  ) {
    return {
      currentConversationId,
      currentRootConversationId,
      provider: "slack",
      providerTenantId: context.destination.teamId,
    };
  }

  return {
    currentConversationId,
    currentRootConversationId,
  };
}

async function resolveRootConversationId(
  conversationStore: ConversationStore,
  conversationId: string,
  parentConversationId: string | undefined,
): Promise<string> {
  if (!parentConversationId) {
    return conversationId;
  }

  let cursor: string | undefined = parentConversationId;
  const seen = new Set<string>([conversationId]);
  while (cursor) {
    if (seen.has(cursor)) {
      // Fail closed on cycles; callers treat missing root as unauthorized.
      return conversationId;
    }
    seen.add(cursor);
    const parent = await conversationStore.get({ conversationId: cursor });
    if (!parent) {
      return conversationId;
    }
    if (!parent.parentConversationId) {
      return parent.conversationId;
    }
    cursor = parent.parentConversationId;
  }
  return conversationId;
}

function assertCanSearchConversationEvents(args: {
  accessScope: ConversationEventAccessScope;
  targetConversationId: string;
  targetRootConversationId?: string;
  targetVisibility?: ConversationPrivacy;
  targetDestination?: {
    platform: string;
    teamId?: string;
    channelId?: string;
    conversationId?: string;
  };
}): void {
  const {
    accessScope,
    targetConversationId,
    targetRootConversationId,
    targetVisibility,
    targetDestination,
  } = args;

  if (
    targetConversationId === accessScope.currentConversationId ||
    (targetRootConversationId !== undefined &&
      targetRootConversationId === accessScope.currentRootConversationId)
  ) {
    return;
  }

  const publicPayloadAllowed = canExposeConversationPayload(
    targetVisibility ? { visibility: targetVisibility } : {},
  );
  if (!publicPayloadAllowed) {
    throw new ToolInputError(
      `Conversation events are not accessible: ${targetConversationId}`,
    );
  }

  if (
    accessScope.provider === "slack" &&
    targetDestination?.platform === "slack" &&
    accessScope.providerTenantId &&
    targetDestination.teamId === accessScope.providerTenantId
  ) {
    return;
  }

  throw new ToolInputError(
    `Conversation events are not accessible: ${targetConversationId}`,
  );
}

function projectEventsForTool(
  page: ConversationEventPage,
  options: { newestFirst: boolean },
) {
  const projected = page.events.map(projectEvent);
  const events = [];
  let jsonBytes = 2;
  const candidates = options.newestFirst ? [...projected].reverse() : projected;

  for (const event of candidates) {
    const eventBytes = jsonByteLength(event);
    const separatorBytes = events.length === 0 ? 0 : 1;
    if (jsonBytes + separatorBytes + eventBytes > MAX_EVENTS_JSON_BYTES) {
      break;
    }
    events.push(event);
    jsonBytes += separatorBytes + eventBytes;
  }

  if (options.newestFirst) {
    events.reverse();
  }
  return {
    events,
    omittedEventCount: projected.length - events.length,
  };
}

function projectEvent(event: ConversationEvent) {
  const data = boundEventData(stripReplacementHistory(event.data));
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
    "modelProfile",
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

function stripReplacementHistory(
  data: ConversationEvent["data"],
): ConversationEvent["data"] | Record<string, unknown> {
  if (data.type === "unknown") {
    return {
      ...data,
      payload: stripReplacementHistoryField(data.payload),
    };
  }
  if (data.type === "compaction" || data.type === "handoff") {
    return stripReplacementHistoryField(data) as Record<string, unknown>;
  }
  return data;
}

function stripReplacementHistoryField(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const { replacementHistory, ...rest } = value as Record<string, unknown>;
  if (replacementHistory === undefined) {
    return value;
  }
  return {
    ...rest,
    replacement_history_count: Array.isArray(replacementHistory)
      ? replacementHistory.length
      : 0,
  };
}

export type { KnownConversationEventType };
