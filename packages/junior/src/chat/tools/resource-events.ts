import { z } from "zod";
import { juniorToolResultSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import type { ToolRegistry } from "@/chat/tools/definition";
import type { ToolRuntimeContext } from "@/chat/tools/types";
import {
  cancelSubscriptions,
  createResourceEventSubscription,
  listResourceEventSubscriptions,
} from "@/chat/resource-events/store";

const DEFAULT_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const STOP_WATCHING_TOOL_NAME = "stopWatchingResources";
const RESOURCE_WATCH_TOOL_SOURCE = {
  id: "resource-watches",
  description: "Inspect or stop resource watches for the current conversation.",
};

const subscribeInputSchema = z.object({
  resourceRef: z
    .string()
    .describe("Opaque resource ref copied from a subscribable tool result."),
  provider: z.string().describe("Provider that owns the resource ref."),
  resourceType: z
    .string()
    .describe("Provider-defined resource type from the subscribable hint."),
  label: z
    .string()
    .describe("Human-readable resource label from the subscribable hint."),
  events: z
    .array(z.string())
    .min(1)
    .describe(
      "High-signal event names to deliver to this conversation when they occur.",
    ),
  intent: z
    .string()
    .describe(
      "Concise reason this conversation wants these events, used when an event arrives.",
    ),
  ttlMs: z.coerce
    .number()
    .describe(
      "How long to keep the subscription active. Defaults to 14 days and is capped at 30 days.",
    )
    .optional(),
});

type SubscribeInput = z.output<typeof subscribeInputSchema>;

function requireConversationContext(context: ToolRuntimeContext): string {
  if (!context.conversationId) {
    throw new Error("Resource event subscriptions require a conversation");
  }
  if (context.destination.platform !== "slack") {
    throw new Error(
      "Resource event subscriptions currently require Slack delivery",
    );
  }
  if (!isSlackThreadConversationId(context.conversationId)) {
    throw new Error(
      "Resource event subscriptions require a Slack thread conversation",
    );
  }
  return context.conversationId;
}

/** Return whether the current runtime can safely manage conversation subscriptions. */
function canUseResourceEventSubscriptionTools(
  context: ToolRuntimeContext,
): boolean {
  return (
    context.destination.platform === "slack" &&
    Boolean(
      context.conversationId &&
      isSlackThreadConversationId(context.conversationId),
    )
  );
}

function isSlackThreadConversationId(conversationId: string): boolean {
  const parts = conversationId.split(":");
  return (
    parts.length === 3 &&
    parts[0] === "slack" &&
    Boolean(parts[1]) &&
    Boolean(parts[2])
  );
}

function cleanStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function ttlMs(input: SubscribeInput): number {
  if (input.ttlMs === undefined) {
    return DEFAULT_TTL_MS;
  }
  if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0) {
    throw new Error("ttlMs must be a positive finite number");
  }
  return Math.min(input.ttlMs, MAX_TTL_MS);
}

/** Create the tool that subscribes the current conversation to resource events. */
function createSubscribeToResourceEventsTool(context: ToolRuntimeContext) {
  return zodTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
      readOnlyHint: false,
    },
    description:
      "Subscribe the current conversation to high-signal events for a resource returned by a subscribable tool result. Matching events are queued as normal conversation messages; they do not interrupt active work.",
    inputSchema: subscribeInputSchema,
    outputSchema: juniorToolResultSchema,
    async execute(input: SubscribeInput) {
      const conversationId = requireConversationContext(context);
      const events = cleanStrings(input.events);
      const intent = input.intent.trim();
      if (!intent) {
        throw new Error("intent is required");
      }
      const nowMs = Date.now();
      const subscription = await createResourceEventSubscription({
        conversationId,
        destination: context.destination,
        events,
        expiresAtMs: nowMs + ttlMs(input),
        intent,
        label: input.label.trim(),
        provider: input.provider.trim(),
        resourceRef: input.resourceRef.trim(),
        resourceType: input.resourceType.trim(),
      });
      const details = {
        id: subscription.id,
        subscription_status: subscription.status,
        resourceRef: subscription.resourceRef,
        events: subscription.events,
        expiresAtMs: subscription.expiresAtMs,
        stop_watching: {
          execution_tool: "executeTool",
          execution_example: {
            tool_name: STOP_WATCHING_TOOL_NAME,
            arguments: {},
          },
        },
      };
      return {
        ok: true,
        status: "success" as const,
        data: details,
        ...details,
      };
    },
  });
}

/** Create the tool that lists active resource subscriptions for this conversation. */
function createListResourceEventSubscriptionsTool(context: ToolRuntimeContext) {
  return zodTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: true,
    },
    description:
      "List active resource event subscriptions for the current conversation.",
    exposure: "deferred",
    source: RESOURCE_WATCH_TOOL_SOURCE,
    inputSchema: z.object({}),
    outputSchema: juniorToolResultSchema,
    async execute() {
      const conversationId = requireConversationContext(context);
      const subscriptions = await listResourceEventSubscriptions({
        conversationId,
      });
      const details = {
        subscriptions: subscriptions.map((subscription) => ({
          id: subscription.id,
          label: subscription.label,
          resourceRef: subscription.resourceRef,
          provider: subscription.provider,
          resourceType: subscription.resourceType,
          events: subscription.events,
          intent: subscription.intent,
          expiresAtMs: subscription.expiresAtMs,
        })),
      };
      return {
        ok: true,
        status: "success" as const,
        data: details,
        ...details,
      };
    },
  });
}

/** Create the tool that stops resource watches for this conversation. */
function createStopWatchingResourcesTool(context: ToolRuntimeContext) {
  return zodTool({
    annotations: {
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: false,
    },
    description:
      "Stop every resource watch for the current conversation. Infer the user's intent from context instead of requiring a special command, and call this tool before confirming that watching stopped.",
    exposure: "deferred",
    source: RESOURCE_WATCH_TOOL_SOURCE,
    inputSchema: z.object({}),
    outputSchema: juniorToolResultSchema,
    async execute() {
      const conversationId = requireConversationContext(context);
      await cancelSubscriptions({ conversationId });
      const details = {
        watching_status: "stopped",
      };
      return {
        ok: true,
        status: "success" as const,
        data: details,
        ...details,
      };
    },
  });
}

/** Build the complete resource-watch tool set allowed by this runtime context. */
export function createResourceEventTools(
  context: ToolRuntimeContext,
): ToolRegistry {
  if (!canUseResourceEventSubscriptionTools(context)) {
    return {};
  }

  return {
    subscribeToResourceEvents: createSubscribeToResourceEventsTool(context),
    listResourceEventSubscriptions:
      createListResourceEventSubscriptionsTool(context),
    [STOP_WATCHING_TOOL_NAME]: createStopWatchingResourcesTool(context),
  };
}
