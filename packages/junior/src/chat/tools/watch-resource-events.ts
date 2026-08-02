import { z } from "zod";
import {
  eventNamespaceSchema,
  normalizeEventIdentifier,
  pluginSupportsEvent,
  registeredEventTypeSchema,
  registeredResourceTypeSchema,
  type ResourceEventCatalog,
} from "@/chat/resource-events/catalog";
import { createResourceEventSubscription } from "@/chat/resource-events/store";
import {
  requireResourceWatchConversation,
  STOP_WATCHING_TOOL_NAME,
} from "@/chat/resource-events/tool-support";
import { juniorToolResultSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import type { ToolRuntimeContext } from "@/chat/tools/types";

const DEFAULT_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function inputSchema(catalog: ResourceEventCatalog) {
  return z
    .object({
      identifier: z
        .string()
        .trim()
        .min(1)
        .describe("Plugin-defined resource identifier."),
      namespace: eventNamespaceSchema(catalog).describe(
        "Enabled plugin namespace for this resource.",
      ),
      resourceType: registeredResourceTypeSchema(catalog).describe(
        "Plugin-defined resource type.",
      ),
      label: z
        .string()
        .trim()
        .min(1)
        .max(500)
        .describe("Human-readable resource label."),
      events: z
        .array(registeredEventTypeSchema(catalog))
        .min(1)
        .describe(
          "High-signal event names to deliver to this conversation when they occur.",
        ),
      intent: z
        .string()
        .trim()
        .min(1)
        .max(4000)
        .describe(
          "Concise reason this conversation wants these events, used when an event arrives.",
        ),
      ttlMs: z.coerce
        .number()
        .describe(
          "How long to keep the subscription active. Defaults to 14 days and must not exceed 30 days.",
        )
        .optional(),
    })
    .strict()
    .superRefine((subscription, context) => {
      subscription.events.forEach((eventType, index) => {
        if (
          !pluginSupportsEvent(
            catalog,
            subscription.namespace,
            subscription.resourceType,
            eventType,
          )
        ) {
          context.addIssue({
            code: "custom",
            message: `Resource type "${subscription.namespace}:${subscription.resourceType}" does not support event "${eventType}".`,
            path: ["events", index],
          });
        }
      });
    });
}

type Input = z.output<ReturnType<typeof inputSchema>>;

const stopWatchingActionSchema = z
  .object({
    execution_tool: z.literal("executeTool"),
    execution_example: z
      .object({
        tool_name: z.literal(STOP_WATCHING_TOOL_NAME),
        arguments: z.object({ id: z.string().min(1) }).strict(),
      })
      .strict(),
  })
  .strict();

const resultDataSchema = z
  .object({
    id: z.string().min(1),
    subscription_status: z.enum(["active", "cancelled", "completed"]),
    identifier: z.string().min(1),
    events: z.array(z.string().min(1)).min(1),
    expiresAtMs: z.number().finite(),
    stop_watching: stopWatchingActionSchema,
  })
  .strict();

const outputSchema = juniorToolResultSchema
  .extend({
    ok: z.literal(true),
    status: z.literal("success"),
    data: resultDataSchema,
    id: resultDataSchema.shape.id,
    subscription_status: resultDataSchema.shape.subscription_status,
    identifier: resultDataSchema.shape.identifier,
    events: resultDataSchema.shape.events,
    expiresAtMs: resultDataSchema.shape.expiresAtMs,
    stop_watching: stopWatchingActionSchema,
  })
  .strict();

function cleanStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function ttlMs(input: Input): number {
  if (input.ttlMs === undefined) return DEFAULT_TTL_MS;
  if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0) {
    throw new ToolInputError("ttlMs must be a positive finite number");
  }
  if (input.ttlMs > MAX_TTL_MS) {
    throw new ToolInputError("Resource watches cannot exceed 30 days");
  }
  return input.ttlMs;
}

/** Create the tool that temporarily watches resource events in one conversation. */
export function createWatchResourceEventsTool(
  context: ToolRuntimeContext,
  catalog: ResourceEventCatalog,
) {
  return zodTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
      readOnlyHint: false,
    },
    description:
      "Watch one plugin resource in the current Slack thread for a limited time; matching events return to this conversation as updates. Use for watch, notify, or tell-me-when requests. This does not create a scheduled polling task. Prefer a subscribable tool result when available.",
    inputSchema: inputSchema(catalog),
    outputSchema,
    async execute(input: Input) {
      const conversationId = requireResourceWatchConversation(context);
      const events = cleanStrings(input.events);
      for (const eventType of events) {
        if (
          !pluginSupportsEvent(
            catalog,
            input.namespace,
            input.resourceType,
            eventType,
          )
        ) {
          throw new ToolInputError(
            `Resource type "${input.namespace}:${input.resourceType}" does not support event "${eventType}".`,
          );
        }
      }
      const intent = input.intent.trim();
      if (!intent) throw new ToolInputError("intent is required");
      const nowMs = Date.now();
      const subscription = await createResourceEventSubscription({
        conversationId,
        destination: context.destination,
        events,
        expiresAtMs: nowMs + ttlMs(input),
        intent,
        label: input.label.trim(),
        namespace: input.namespace.trim(),
        identifier: normalizeEventIdentifier(
          catalog,
          input.namespace,
          input.identifier,
        ),
        resourceType: input.resourceType.trim(),
      });
      const details = {
        id: subscription.id,
        subscription_status: subscription.status,
        identifier: subscription.identifier,
        events: subscription.events,
        expiresAtMs: subscription.expiresAtMs,
        stop_watching: {
          execution_tool: "executeTool" as const,
          execution_example: {
            tool_name: STOP_WATCHING_TOOL_NAME as "stopWatchingResources",
            arguments: { id: subscription.id },
          },
        },
      };
      return {
        ok: true as const,
        status: "success" as const,
        data: details,
        ...details,
      };
    },
  });
}
