import { z } from "zod";
import { zodTool } from "@/chat/tool-support/zod-tool";
import type { ToolRuntimeContext } from "@/chat/tools/types";
import {
  cancelResourceEventSubscription,
  createResourceEventSubscription,
  listResourceEventSubscriptions,
} from "@/chat/resource-events/store";

const DEFAULT_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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

const cancelInputSchema = z.object({
  subscriptionId: z
    .string()
    .describe(
      "Subscription id returned by subscribeToResourceEvents or listResourceEventSubscriptions.",
    ),
});

type SubscribeInput = z.output<typeof subscribeInputSchema>;
type CancelInput = z.output<typeof cancelInputSchema>;

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
export function canUseResourceEventSubscriptionTools(
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
export function createSubscribeToResourceEventsTool(
  context: ToolRuntimeContext,
) {
  return zodTool({
    description:
      "Subscribe the current conversation to high-signal events for a resource returned by a subscribable tool result. Matching events are queued as normal conversation messages; they do not interrupt active work.",
    inputSchema: subscribeInputSchema,
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
      return {
        id: subscription.id,
        status: subscription.status,
        resourceRef: subscription.resourceRef,
        events: subscription.events,
        expiresAtMs: subscription.expiresAtMs,
      };
    },
  });
}

/** Create the tool that lists active resource subscriptions for this conversation. */
export function createListResourceEventSubscriptionsTool(
  context: ToolRuntimeContext,
) {
  return zodTool({
    description:
      "List active resource event subscriptions for the current conversation.",
    inputSchema: z.object({}),
    async execute() {
      const conversationId = requireConversationContext(context);
      const subscriptions = await listResourceEventSubscriptions({
        conversationId,
      });
      return {
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
    },
  });
}

/** Create the tool that cancels a current-conversation resource subscription. */
export function createCancelResourceEventSubscriptionTool(
  context: ToolRuntimeContext,
) {
  return zodTool({
    description:
      "Cancel a resource event subscription for the current conversation.",
    inputSchema: cancelInputSchema,
    async execute(input: CancelInput) {
      const conversationId = requireConversationContext(context);
      const subscription = await cancelResourceEventSubscription({
        conversationId,
        id: input.subscriptionId,
      });
      if (!subscription) {
        throw new Error("Resource event subscription was not found");
      }
      return {
        id: subscription.id,
        status: subscription.status,
      };
    },
  });
}
