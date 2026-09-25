import { z } from "zod";

export const EVENT_SUMMARY_MAX_LENGTH = 4_000;
export const EVENT_TEXT_MAX_LENGTH = 8_000;
export const EVENT_DATA_MAX_KEYS = 32;
export const EVENT_DATA_MAX_JSON_BYTES = 4_000;
export const EVENT_GUIDANCE_MAX_LENGTH = 1_000;

/** Small trusted data from the plugin. The agent should not look these up again. */
export const eventDataSchema = z
  .record(z.string(), z.unknown())
  .superRefine((value, context) => {
    const keys = Object.keys(value);
    if (keys.length > EVENT_DATA_MAX_KEYS) {
      context.addIssue({
        code: "custom",
        message: `Event data may include at most ${EVENT_DATA_MAX_KEYS} keys.`,
      });
    }
    const jsonBytes = new TextEncoder().encode(
      JSON.stringify(value),
    ).byteLength;
    if (jsonBytes > EVENT_DATA_MAX_JSON_BYTES) {
      context.addIssue({
        code: "custom",
        message: `Event data may be at most ${EVENT_DATA_MAX_JSON_BYTES} JSON bytes.`,
      });
    }
  });

/** Canonical dotted event type published and selected across plugins. */
export const eventTypeSchema = z
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

const EVENT_MATCH_FIELD_NAME = /^[a-z][a-zA-Z0-9]*$/;

/** One exact value a watch or event automation may require on trusted event data. */
export const eventMatchFieldSchema = z
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
        message: 'Event match field enum requires kind "string".',
        path: ["enum"],
      });
    }
  });

export const eventMatchFieldsSchema = z
  .record(z.string().regex(EVENT_MATCH_FIELD_NAME), eventMatchFieldSchema)
  .superRefine((fields, context) => {
    if (Object.keys(fields).length > EVENT_DATA_MAX_KEYS) {
      context.addIssue({
        code: "custom",
        message: `Event match keys may include at most ${EVENT_DATA_MAX_KEYS} keys.`,
      });
    }
  });

/** Exact trusted values required before a watch or event automation runs. */
export const eventMatchSchema = z
  .record(
    z.string().regex(EVENT_MATCH_FIELD_NAME),
    z.union([
      z.boolean(),
      z.number().finite(),
      z.string().min(1),
      z.array(z.union([z.number().finite(), z.string().min(1)])).min(1),
    ]),
  )
  .superRefine((match, context) => {
    if (Object.keys(match).length > EVENT_DATA_MAX_KEYS) {
      context.addIssue({
        code: "custom",
        message: `Event match may include at most ${EVENT_DATA_MAX_KEYS} keys.`,
      });
    }
    for (const [key, value] of Object.entries(match)) {
      if (!Array.isArray(value)) continue;
      if (value.some((entry) => typeof entry === "boolean")) {
        context.addIssue({
          code: "custom",
          message: `Event match field "${key}" cannot use a boolean list.`,
          path: [key],
        });
      }
    }
  });

export type EventMatch = z.output<typeof eventMatchSchema>;
export type EventMatchFields = z.output<typeof eventMatchFieldsSchema>;

function stableMatchValue(value: EventMatch[string]): unknown {
  if (!Array.isArray(value)) return value;
  return [...value].sort((left, right) => {
    if (typeof left === "number" && typeof right === "number") {
      return left - right;
    }
    return String(left).localeCompare(String(right));
  });
}

/** Stable JSON for one match object. List order does not matter. */
export function stableEventMatchKey(match: EventMatch | undefined): string {
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
export function eventMatches(
  match: EventMatch | undefined,
  data: EventData | undefined,
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

export const pluginEventTypeSchema = z
  .object({
    type: resourceTypeSchema,
    supportedEvents: z.array(eventTypeSchema).min(1),
    suggestedEvents: z.array(eventTypeSchema).optional(),
    matchFields: eventMatchFieldsSchema.optional(),
    guidance: z
      .record(
        eventTypeSchema,
        z.string().trim().min(1).max(EVENT_GUIDANCE_MAX_LENGTH),
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
          message: `Duplicate supported event type "${eventType}".`,
          path: ["supportedEvents", index],
        });
      }
      supported.add(eventType);
    });
    for (const eventType of Object.keys(resourceType.guidance ?? {})) {
      if (!supported.has(eventType)) {
        context.addIssue({
          code: "custom",
          message: `Guidance event type "${eventType}" is not supported.`,
          path: ["guidance", eventType],
        });
      }
    }
    const suggested = new Set<string>();
    resourceType.suggestedEvents?.forEach((eventType, index) => {
      if (suggested.has(eventType)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate suggested event type "${eventType}".`,
          path: ["suggestedEvents", index],
        });
      }
      if (!supported.has(eventType)) {
        context.addIssue({
          code: "custom",
          message: `Suggested event type "${eventType}" is not supported.`,
          path: ["suggestedEvents", index],
        });
      }
      suggested.add(eventType);
    });
  });

export const pluginEventsSchema = z
  .object({
    resourceTypes: z.array(pluginEventTypeSchema).min(1),
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

export type PluginEventType = z.output<typeof pluginEventTypeSchema>;
export type PluginEvents = z.output<typeof pluginEventsSchema>;

/** Apply a plugin's identifier convention at event boundaries. */
export function normalizeEventIdentifier(
  registration: Pick<PluginEvents, "normalizeIdentifier"> | undefined,
  identifier: string,
): string {
  const trimmed = identifier.trim();
  const normalized = (
    registration?.normalizeIdentifier?.(trimmed) ?? trimmed
  ).trim();
  if (!normalized) {
    throw new Error("Event identifier must not normalize to empty");
  }
  return normalized;
}

export const subscribableResourceSchema = z
  .object({
    identifier: z.string().min(1),
    label: z.string().min(1),
    namespace: z.string().min(1),
    suggestedEvents: z.array(eventTypeSchema).optional(),
    supportedEvents: z.array(eventTypeSchema),
    type: resourceTypeSchema,
  })
  .strict();

export type SubscribableResource = z.output<typeof subscribableResourceSchema>;

/** Result returned after a temporary watch is created. */
export const watchResultSchema = z
  .object({
    events: z.array(eventTypeSchema).min(1),
    id: z.string().min(1),
  })
  .strict();

export type WatchResult = z.output<typeof watchResultSchema>;

export const eventInputSchema = z
  .object({
    eventKey: z.string().min(1),
    eventType: eventTypeSchema,
    identifier: z.string().min(1),
    occurredAtMs: z.number().finite(),
    terminal: z.boolean().optional(),
    trustedSummary: z
      .string()
      .min(1)
      .transform((value) => value.slice(0, EVENT_SUMMARY_MAX_LENGTH)),
    /** Trusted structured facts. Prefer ids and urls over long prose. */
    data: eventDataSchema.optional(),
    untrustedText: z
      .string()
      .transform((value) => value.slice(0, EVENT_TEXT_MAX_LENGTH))
      .optional(),
  })
  .strict();

export type EventData = z.output<typeof eventDataSchema>;
export type EventInput = z.output<typeof eventInputSchema>;

export const eventSchema = eventInputSchema.extend({
  namespace: z.string().min(1),
});

export type Event = z.output<typeof eventSchema>;

export interface EventPublisher {
  /** Return whether an active watch or event automation matches this event. */
  hasMatch?(event: EventInput): Promise<boolean>;
  /** Publish one normalized event under the owning plugin's namespace. */
  publish(event: EventInput): Promise<void>;
  /**
   * Return match keys used by active watches or event automations for these
   * identifiers and event types. Plugins use this to load optional trusted
   * data only when a filter needs it.
   */
  neededMatchKeys?(input: {
    eventTypes: string[];
    identifiers: string[];
  }): Promise<string[]>;
}
