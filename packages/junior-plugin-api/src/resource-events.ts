import { z } from "zod";

export const RESOURCE_EVENT_SUMMARY_MAX_LENGTH = 4_000;
export const RESOURCE_EVENT_TEXT_MAX_LENGTH = 8_000;
export const RESOURCE_EVENT_DATA_MAX_KEYS = 32;
export const RESOURCE_EVENT_DATA_MAX_JSON_BYTES = 4_000;
export const RESOURCE_EVENT_GUIDANCE_MAX_LENGTH = 1_000;

/** Small trusted data from the plugin. The agent should not look these up again. */
export const resourceEventDataSchema = z
  .record(z.string(), z.unknown())
  .superRefine((value, context) => {
    const keys = Object.keys(value);
    if (keys.length > RESOURCE_EVENT_DATA_MAX_KEYS) {
      context.addIssue({
        code: "custom",
        message: `Resource event data may include at most ${RESOURCE_EVENT_DATA_MAX_KEYS} keys.`,
      });
    }
    const jsonBytes = new TextEncoder().encode(
      JSON.stringify(value),
    ).byteLength;
    if (jsonBytes > RESOURCE_EVENT_DATA_MAX_JSON_BYTES) {
      context.addIssue({
        code: "custom",
        message: `Resource event data may be at most ${RESOURCE_EVENT_DATA_MAX_JSON_BYTES} JSON bytes.`,
      });
    }
  });

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

const RESOURCE_EVENT_MATCH_FIELD_NAME = /^[a-z][a-zA-Z0-9]*$/;

/** One exact value a watch or event task may require on trusted event data. */
export const resourceEventMatchFieldSchema = z
  .object({
    kind: z.enum(["boolean", "string", "number"]),
    description: z.string().trim().min(1).max(200),
    enum: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict()
  .superRefine((field, context) => {
    if (field.enum && field.kind !== "string") {
      context.addIssue({
        code: "custom",
        message: 'Resource event match field enum requires kind "string".',
        path: ["enum"],
      });
    }
  });

export const resourceEventMatchFieldsSchema = z
  .record(
    z.string().regex(RESOURCE_EVENT_MATCH_FIELD_NAME),
    resourceEventMatchFieldSchema,
  )
  .superRefine((fields, context) => {
    if (Object.keys(fields).length > RESOURCE_EVENT_DATA_MAX_KEYS) {
      context.addIssue({
        code: "custom",
        message: `Resource event match keys may include at most ${RESOURCE_EVENT_DATA_MAX_KEYS} keys.`,
      });
    }
  });

/** Exact trusted values required before a watch or event task runs. */
export const resourceEventMatchSchema = z
  .record(
    z.string().regex(RESOURCE_EVENT_MATCH_FIELD_NAME),
    z.union([
      z.boolean(),
      z.number().finite(),
      z.string().min(1),
      z.array(z.union([z.number().finite(), z.string().min(1)])).min(1),
    ]),
  )
  .superRefine((match, context) => {
    if (Object.keys(match).length > RESOURCE_EVENT_DATA_MAX_KEYS) {
      context.addIssue({
        code: "custom",
        message: `Resource event match may include at most ${RESOURCE_EVENT_DATA_MAX_KEYS} keys.`,
      });
    }
    for (const [key, value] of Object.entries(match)) {
      if (!Array.isArray(value)) continue;
      if (value.some((entry) => typeof entry === "boolean")) {
        context.addIssue({
          code: "custom",
          message: `Resource event match field "${key}" cannot use a boolean list.`,
          path: [key],
        });
      }
    }
  });

export type ResourceEventMatch = z.output<typeof resourceEventMatchSchema>;
export type ResourceEventMatchFields = z.output<
  typeof resourceEventMatchFieldsSchema
>;

function stableMatchValue(value: ResourceEventMatch[string]): unknown {
  if (!Array.isArray(value)) return value;
  return [...value].sort((left, right) => {
    if (typeof left === "number" && typeof right === "number") {
      return left - right;
    }
    return String(left).localeCompare(String(right));
  });
}

/** Stable JSON for one match object. List order does not matter. */
export function stableResourceEventMatchKey(
  match: ResourceEventMatch | undefined,
): string {
  if (!match || Object.keys(match).length === 0) return "";
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(match)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => [key, stableMatchValue(value)]),
    ),
  );
}

/** Return whether trusted event data matches one exact match object. */
export function resourceEventMatches(
  match: ResourceEventMatch | undefined,
  data: ResourceEventData | undefined,
): boolean {
  if (!match || Object.keys(match).length === 0) return true;
  if (!data) return false;
  for (const [key, expected] of Object.entries(match)) {
    const actual = data[key];
    if (actual === undefined) return false;
    if (Array.isArray(expected)) {
      if (!expected.some((value) => Object.is(value, actual))) return false;
      continue;
    }
    if (!Object.is(expected, actual)) return false;
  }
  return true;
}

export const pluginResourceEventTypeSchema = z
  .object({
    type: resourceTypeSchema,
    supportedEvents: z.array(resourceEventTypeSchema).min(1),
    suggestedEvents: z.array(resourceEventTypeSchema).optional(),
    matchFields: resourceEventMatchFieldsSchema.optional(),
    guidance: z
      .record(
        resourceEventTypeSchema,
        z.string().trim().min(1).max(RESOURCE_EVENT_GUIDANCE_MAX_LENGTH),
      )
      .optional(),
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
    for (const eventType of Object.keys(resourceType.guidance ?? {})) {
      if (!supported.has(eventType)) {
        context.addIssue({
          code: "custom",
          message: `Guidance resource event type "${eventType}" is not supported.`,
          path: ["guidance", eventType],
        });
      }
    }
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

/** Result returned after a temporary resource subscription is created. */
export const resourceEventSubscriptionResultSchema = z
  .object({
    events: z.array(resourceEventTypeSchema).min(1),
    id: z.string().min(1),
  })
  .strict();

export type ResourceEventSubscriptionResult = z.output<
  typeof resourceEventSubscriptionResultSchema
>;

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
    /** Trusted structured facts. Prefer ids and urls over long prose. */
    data: resourceEventDataSchema.optional(),
    untrustedText: z
      .string()
      .transform((value) => value.slice(0, RESOURCE_EVENT_TEXT_MAX_LENGTH))
      .optional(),
  })
  .strict();

export type ResourceEventData = z.output<typeof resourceEventDataSchema>;
export type ResourceEventInput = z.output<typeof resourceEventInputSchema>;

export const resourceEventSchema = resourceEventInputSchema.extend({
  namespace: z.string().min(1),
});

export type ResourceEvent = z.output<typeof resourceEventSchema>;

export interface ResourceEventPublisher {
  /** Return whether an active watch or event task matches this event. */
  hasMatch?(event: ResourceEventInput): Promise<boolean>;
  /** Publish one normalized event under the owning plugin's namespace. */
  publish(event: ResourceEventInput): Promise<void>;
  /**
   * Return match keys used by active watches or event tasks for these
   * identifiers and event types. Plugins use this to load optional trusted
   * data only when a filter needs it.
   */
  neededMatchKeys?(input: {
    eventTypes: string[];
    identifiers: string[];
  }): Promise<string[]>;
}
