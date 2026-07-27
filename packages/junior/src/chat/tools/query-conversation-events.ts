import { z } from "zod";
import {
  canExposeConversationPayload,
  type ConversationPrivacy,
} from "@/chat/conversation-privacy";
import {
  KNOWN_CONVERSATION_EVENT_TYPES,
  type ConversationEvent,
  type ConversationEventPage,
  type ConversationEventStore,
  type KnownConversationEventType,
} from "@/chat/conversations/history";
import type { ConversationStore } from "@/chat/conversations/store";
import { juniorToolResultSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import type { ToolRuntimeContext } from "@/chat/tools/types";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const CONVERSATION_EVENTS_TOOL_SOURCE = {
  id: "conversation-events",
  description:
    "Inspect Junior's durable conversation event log for debugging runtime behavior.",
};

const knownEventTypeSchema = z.enum(KNOWN_CONVERSATION_EVENT_TYPES);

const queryConversationEventsOutputSchema = juniorToolResultSchema.extend({
  conversation_id: z.string().min(1),
  count: z.number().int().nonnegative(),
  events: z.array(z.unknown()),
  has_older: z.boolean(),
  has_newer: z.boolean(),
  include_replacement_history: z.boolean(),
  types: z.array(knownEventTypeSchema).optional(),
});

interface QueryConversationEventsToolDeps {
  conversationStore?: ConversationStore;
  eventStore?: ConversationEventStore;
}

/** Resolve injectable stores, loading the process DB only when needed. */
async function resolveStores(deps: QueryConversationEventsToolDeps): Promise<{
  conversationStore: ConversationStore;
  eventStore: ConversationEventStore;
}> {
  if (deps.conversationStore && deps.eventStore) {
    return {
      conversationStore: deps.conversationStore,
      eventStore: deps.eventStore,
    };
  }
  const { getConversationEventStore, getConversationStore } = await import(
    "@/chat/db"
  );
  return {
    conversationStore: deps.conversationStore ?? getConversationStore(),
    eventStore: deps.eventStore ?? getConversationEventStore(),
  };
}

interface QueryAccessScope {
  currentConversationId: string;
  currentRootConversationId?: string;
  provider?: string;
  providerTenantId?: string;
}

/** Create a deferred tool that returns a bounded raw conversation event page. */
export function createQueryConversationEventsTool(
  context: ToolRuntimeContext,
  deps: QueryConversationEventsToolDeps = {},
) {
  return zodTool({
    description:
      "Query Junior's durable raw conversation events for a conversation ID. Use when debugging Junior behavior from stored turns, tool calls, handoffs, or compaction. Catalog-only by default. Returns events for the current conversation tree, or for another retained public conversation in the same Slack workspace. Defaults to the newest matching page.",
    exposure: "deferred",
    source: CONVERSATION_EVENTS_TOOL_SOURCE,
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: z
      .object({
        conversation_id: z
          .string()
          .trim()
          .min(1)
          .describe(
            "Conversation ID to inspect, such as slack:{channelId}:{threadTs} or a child conversation id.",
          ),
        after_seq: z
          .number()
          .int()
          .nonnegative()
          .nullable()
          .describe(
            "Exclusive lower bound on event seq. When set, returns the next newer page in ascending order.",
          )
          .optional(),
        before_seq: z
          .number()
          .int()
          .nonnegative()
          .nullable()
          .describe(
            "Exclusive upper bound on event seq. Combine with defaults or after_seq to page older or bounded ranges.",
          )
          .optional(),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_LIMIT)
          .nullable()
          .describe(
            `Maximum events to return. Defaults to ${DEFAULT_LIMIT}; max ${MAX_LIMIT}.`,
          )
          .optional(),
        types: z
          .array(knownEventTypeSchema)
          .min(1)
          .nullable()
          .describe(
            "Optional event-type filter. Omit to return every durable event type.",
          )
          .optional(),
        include_replacement_history: z
          .boolean()
          .nullable()
          .describe(
            "Include full replacementHistory on compaction/handoff events. Defaults to false because those payloads are large.",
          )
          .optional(),
      })
      .strict(),
    outputSchema: queryConversationEventsOutputSchema,
    execute: async (input) => {
      const currentConversationId = context.conversationId?.trim();
      if (!currentConversationId) {
        throw new ToolInputError(
          "queryConversationEvents requires an active conversation",
        );
      }

      const conversationId = input.conversation_id;
      const afterSeq = input.after_seq ?? undefined;
      const beforeSeq = input.before_seq ?? undefined;
      const limit = input.limit ?? DEFAULT_LIMIT;
      const types = input.types ?? undefined;
      const includeReplacementHistory =
        input.include_replacement_history === true;

      if (
        afterSeq !== undefined &&
        beforeSeq !== undefined &&
        afterSeq >= beforeSeq
      ) {
        throw new ToolInputError(
          "after_seq must be less than before_seq when both are provided",
        );
      }

      const { conversationStore, eventStore } = await resolveStores(deps);
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
      // Child conversations inherit the root destination privacy boundary.
      const targetRootConversationId = await resolveRootConversationId(
        conversationStore,
        conversationId,
        target.lineage?.parentConversationId,
      );
      const targetRoot =
        targetRootConversationId === conversationId
          ? target
          : await conversationStore.get({
              conversationId: targetRootConversationId,
            });
      assertCanQueryConversationEvents({
        accessScope,
        targetConversationId: conversationId,
        targetRootConversationId,
        targetVisibility: targetRoot?.visibility ?? target.visibility,
        targetDestination: targetRoot?.destination ?? target.destination,
      });

      const page = await eventStore.query(conversationId, {
        limit,
        ...(afterSeq === undefined ? {} : { afterSeq }),
        ...(beforeSeq === undefined ? {} : { beforeSeq }),
        ...(types === undefined ? {} : { types }),
      });
      const events = projectEventsForTool(page, includeReplacementHistory);

      return {
        ok: true,
        status: "success" as const,
        conversation_id: conversationId,
        count: events.length,
        events,
        has_older: page.hasOlder,
        has_newer: page.hasNewer,
        include_replacement_history: includeReplacementHistory,
        ...(types ? { types: [...types] } : {}),
      };
    },
  });
}

async function resolveAccessScope(
  conversationStore: ConversationStore,
  context: ToolRuntimeContext,
  currentConversationId: string,
): Promise<QueryAccessScope> {
  const current = await conversationStore.get({
    conversationId: currentConversationId,
  });
  const currentRootConversationId = current
    ? await resolveRootConversationId(
        conversationStore,
        currentConversationId,
        current.lineage?.parentConversationId,
      )
    : currentConversationId;

  if (context.source.platform === "slack") {
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
    if (!parent.lineage?.parentConversationId) {
      return parent.conversationId;
    }
    cursor = parent.lineage.parentConversationId;
  }
  return conversationId;
}

function assertCanQueryConversationEvents(args: {
  accessScope: QueryAccessScope;
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

  const publicPayloadAllowed = canExposeConversationPayload({
    conversationId: targetRootConversationId ?? targetConversationId,
    ...(targetVisibility ? { visibility: targetVisibility } : {}),
    ...(targetDestination?.platform === "slack"
      ? { channelId: targetDestination.channelId }
      : {}),
  });
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
  includeReplacementHistory: boolean,
): Array<Record<string, unknown>> {
  return page.events.map((event) => projectEvent(event, includeReplacementHistory));
}

function projectEvent(
  event: ConversationEvent,
  includeReplacementHistory: boolean,
): Record<string, unknown> {
  const data = includeReplacementHistory
    ? event.data
    : stripReplacementHistory(event.data);
  return {
    seq: event.seq,
    history_version: event.historyVersion,
    schema_version: event.schemaVersion,
    created_at: new Date(event.createdAtMs).toISOString(),
    ...(event.idempotencyKey ? { idempotency_key: event.idempotencyKey } : {}),
    data,
  };
}

function stripReplacementHistory(
  data: ConversationEvent["data"],
): ConversationEvent["data"] | Record<string, unknown> {
  if (
    data.type === "compaction" ||
    data.type === "handoff" ||
    data.type === "rollback"
  ) {
    const { replacementHistory: _replacementHistory, ...rest } = data as {
      replacementHistory?: unknown;
    } & Record<string, unknown>;
    return {
      ...rest,
      replacement_history_omitted: true,
      replacement_history_count: Array.isArray(
        (data as { replacementHistory?: unknown }).replacementHistory,
      )
        ? ((data as { replacementHistory: unknown[] }).replacementHistory
            .length)
        : 0,
    };
  }
  return data;
}

/** Exported for unit tests that need the known type list without DB access. */
export const QUERY_CONVERSATION_EVENTS_DEFAULT_LIMIT = DEFAULT_LIMIT;
export const QUERY_CONVERSATION_EVENTS_MAX_LIMIT = MAX_LIMIT;
export type { KnownConversationEventType };
