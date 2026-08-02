import { z } from "zod";

export const RESOURCE_EVENT_SUMMARY_MAX_LENGTH = 4_000;
export const RESOURCE_EVENT_TEXT_MAX_LENGTH = 8_000;

/** Canonical dotted event type published and selected across plugins. */
export const resourceEventTypeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/)
  .describe(
    "Canonical dotted event type, such as issue.closed or pull_request.review.changes_requested.",
  );

export const resourceTypeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/)
  .describe(
    "Canonical plugin-defined resource type, such as issue or pull_request.",
  );

export const pluginResourceEventTypeSchema = z
  .object({
    type: resourceTypeSchema,
    supportedEvents: z.array(resourceEventTypeSchema).min(1),
    suggestedEvents: z.array(resourceEventTypeSchema).optional(),
  })
  .strict()
  .superRefine((resourceType, context) => {
    const supported = new Set<string>();
    resourceType.supportedEvents.forEach((eventType, index) => {
      if (supported.has(eventType)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate supported resource event type "${eventType}".`,
          path: ["supportedEvents", index],
        });
      }
      supported.add(eventType);
    });
    const suggested = new Set<string>();
    resourceType.suggestedEvents?.forEach((eventType, index) => {
      if (suggested.has(eventType)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate suggested resource event type "${eventType}".`,
          path: ["suggestedEvents", index],
        });
      }
      if (!supported.has(eventType)) {
        context.addIssue({
          code: "custom",
          message: `Suggested resource event type "${eventType}" is not supported.`,
          path: ["suggestedEvents", index],
        });
      }
      suggested.add(eventType);
    });
  });

export const pluginResourceEventsSchema = z
  .object({
    resourceTypes: z.array(pluginResourceEventTypeSchema).min(1),
    isEnabled: z.function({ input: [], output: z.boolean() }).optional(),
    normalizeIdentifier: z
      .function({ input: [z.string()], output: z.string() })
      .optional(),
  })
  .strict()
  .superRefine((registration, context) => {
    const seen = new Set<string>();
    registration.resourceTypes.forEach((resourceType, index) => {
      if (seen.has(resourceType.type)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate resource type "${resourceType.type}".`,
          path: ["resourceTypes", index, "type"],
        });
      }
      seen.add(resourceType.type);
    });
  });

export type PluginResourceEventType = z.output<
  typeof pluginResourceEventTypeSchema
>;
export type PluginResourceEvents = z.output<typeof pluginResourceEventsSchema>;

/** Apply a plugin's identifier convention at resource-event boundaries. */
export function normalizeResourceEventIdentifier(
  registration: Pick<PluginResourceEvents, "normalizeIdentifier"> | undefined,
  identifier: string,
): string {
  const trimmed = identifier.trim();
  const normalized = (
    registration?.normalizeIdentifier?.(trimmed) ?? trimmed
  ).trim();
  if (!normalized) {
    throw new Error("Resource event identifier must not normalize to empty");
  }
  return normalized;
}

export const subscribableResourceSchema = z
  .object({
    identifier: z.string().min(1),
    label: z.string().min(1),
    namespace: z.string().min(1),
    suggestedEvents: z.array(resourceEventTypeSchema).optional(),
    supportedEvents: z.array(resourceEventTypeSchema),
    type: resourceTypeSchema,
  })
  .strict();

export type SubscribableResource = z.output<typeof subscribableResourceSchema>;

export const resourceEventInputSchema = z
  .object({
    eventKey: z.string().min(1),
    eventType: resourceEventTypeSchema,
    identifier: z.string().min(1),
    occurredAtMs: z.number().finite(),
    terminal: z.boolean().optional(),
    trustedSummary: z
      .string()
      .min(1)
      .transform((value) => value.slice(0, RESOURCE_EVENT_SUMMARY_MAX_LENGTH)),
    untrustedText: z
      .string()
      .transform((value) => value.slice(0, RESOURCE_EVENT_TEXT_MAX_LENGTH))
      .optional(),
  })
  .strict();

export type ResourceEventInput = z.output<typeof resourceEventInputSchema>;

export const resourceEventSchema = resourceEventInputSchema.extend({
  namespace: z.string().min(1),
});

export type ResourceEvent = z.output<typeof resourceEventSchema>;

export interface ResourceEventPublisher {
  /** Publish one normalized event under the owning plugin's namespace. */
  publish(event: ResourceEventInput): Promise<void>;
}
