import { z } from "zod";
import { objectTypeSchema } from "./object-presentation";

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
    /**
     * The event value is a list of `kind` values. A match value matches when
     * the list includes it.
     */
    list: z.literal(true).optional(),
    /**
     * The events that set this field. Leave it out when every event of the
     * resource type sets it. A filter on this field never matches other
     * events, so a trigger that selects them is rejected.
     */
    events: z.array(eventTypeSchema).min(1).optional(),
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
    if (field.list && field.kind === "boolean") {
      context.addIssue({
        code: "custom",
        message: 'Event match field list cannot use kind "boolean".',
        path: ["list"],
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

function sameValues(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  return (
    left?.length === right?.length &&
    (left ?? []).every((value) => right?.includes(value))
  );
}

/**
 * Merge the match fields of resource types that share one parent resource
 * type, such as a repository. A field in more than one map keeps the first
 * description and gets the union of the `events` lists. Fields with the same
 * key must have the same kind, enum, and list values, and each copy must list
 * its events. Otherwise this throws, because one field cannot describe two
 * different values.
 */
export function mergeEventMatchFields(
  ...maps: readonly EventMatchFields[]
): EventMatchFields {
  const merged: EventMatchFields = {};
  for (const fields of maps) {
    for (const [key, field] of Object.entries(fields)) {
      const current = merged[key];
      if (!current) {
        merged[key] = field;
        continue;
      }
      if (
        current.kind !== field.kind ||
        current.list !== field.list ||
        !sameValues(current.enum, field.enum)
      ) {
        throw new Error(
          `Match field "${key}" has a different kind, enum, or list in two maps.`,
        );
      }
      if (!current.events || !field.events) {
        throw new Error(
          `Match field "${key}" is in two maps, so each copy must list its events.`,
        );
      }
      merged[key] = {
        ...current,
        events: [...new Set([...current.events, ...field.events])],
      };
    }
  }
  return eventMatchFieldsSchema.parse(merged);
}

/**
 * Merge the match fields of every resource type of one source, for a trigger
 * with no identifier. Such a trigger can get the events of every resource
 * type. A field with no `events` list is set on every event of its own
 * resource type, so it gets that list before the merge. This throws like
 * `mergeEventMatchFields` when two resource types describe one field
 * differently.
 */
export function anyResourceMatchFields(
  resourceTypes: readonly Pick<
    PluginEventType,
    "matchFields" | "supportedEvents"
  >[],
): EventMatchFields {
  return mergeEventMatchFields(
    ...resourceTypes.map((resourceType) =>
      Object.fromEntries(
        Object.entries(resourceType.matchFields ?? {}).map(([key, field]) => [
          key,
          field.events
            ? field
            : { ...field, events: [...resourceType.supportedEvents] },
        ]),
      ),
    ),
  );
}

/**
 * Return the guidance of one event of a source. Resource types can share an
 * event, and the agent gets the same guidance for it on each of them. So
 * this throws when two resource types give different guidance, or when one
 * gives guidance and another does not.
 */
export function sourceEventGuidance(
  resourceTypes: readonly Pick<
    PluginEventType,
    "guidance" | "supportedEvents" | "type"
  >[],
  eventType: string,
): string | undefined {
  const withEvent = resourceTypes.filter((resourceType) =>
    resourceType.supportedEvents.includes(eventType),
  );
  const values = new Set(
    withEvent.map((resourceType) => resourceType.guidance?.[eventType]),
  );
  if (values.size > 1) {
    throw new Error(
      `Resource types ${withEvent.map((resourceType) => `"${resourceType.type}"`).join(", ")} give different guidance for "${eventType}".`,
    );
  }
  return withEvent[0]?.guidance?.[eventType];
}

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

/**
 * Return whether trusted event data matches one exact match object. A list
 * match value matches when the event value equals any entry. A list event
 * value matches when it includes the match value, or any entry of a list
 * match value.
 */
export function eventMatches(
  match: EventMatch | undefined,
  data: EventData | undefined,
): boolean {
  if (!match || Object.keys(match).length === 0) return true;
  if (!data) return false;
  for (const [key, expected] of Object.entries(match)) {
    const actual = data[key];
    if (actual === undefined) return false;
    const actualValues: unknown[] = Array.isArray(actual) ? actual : [actual];
    const expectedValues: unknown[] = Array.isArray(expected)
      ? expected
      : [expected];
    if (
      !expectedValues.some((value) =>
        actualValues.some((entry) => Object.is(value, entry)),
      )
    ) {
      return false;
    }
  }
  return true;
}

function isRegExpSource(value: string): boolean {
  try {
    new RegExp(value);
    return true;
  } catch {
    return false;
  }
}

/** The identifier shape of one resource type. Plain JSON, so API responses can carry it. */
export const eventIdentifierSchema = z
  .object({
    /** Shown to the agent, such as "owner/repo#number". */
    format: z.string().trim().min(1).max(200),
    /** RegExp source that matches a normalized identifier of this resource type. */
    pattern: z.string().min(1).refine(isRegExpSource, {
      message: "Identifier pattern must be a valid regular expression.",
    }),
  })
  .strict();

export const pluginEventTypeSchema = z
  .object({
    type: resourceTypeSchema,
    identifier: eventIdentifierSchema.optional(),
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
    for (const [key, field] of Object.entries(resourceType.matchFields ?? {})) {
      field.events?.forEach((eventType, index) => {
        if (!supported.has(eventType)) {
          context.addIssue({
            code: "custom",
            message: `Match field "${key}" event type "${eventType}" is not supported.`,
            path: ["matchFields", key, "events", index],
          });
        }
      });
    }
  });

/**
 * How a trigger with no identifier can select one event. Such a trigger runs
 * for every resource of the source that its filters match.
 */
export const anyResourceEventSchema = z
  .object({
    /**
     * The filter that the trigger must set, such as `repo`. Leave it out when
     * the event can run for every resource with no filter.
     */
    requiredFilter: z.string().regex(EVENT_MATCH_FIELD_NAME).optional(),
  })
  .strict();

export type AnyResourceEvent = z.output<typeof anyResourceEventSchema>;

export const pluginEventsSchema = z
  .object({
    resourceTypes: z.array(pluginEventTypeSchema).min(1),
    /**
     * The events that an event automation can select with no identifier and
     * no resource type. Other events need an identifier. Name the filter that
     * keeps the trigger narrow when an event carries private text or causes
     * side effects, such as a reaction.
     */
    anyResourceEvents: z
      .record(eventTypeSchema, anyResourceEventSchema)
      .optional(),
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
    const supported = new Set(
      registration.resourceTypes.flatMap(
        (resourceType) => resourceType.supportedEvents,
      ),
    );
    for (const eventType of supported) {
      try {
        sourceEventGuidance(registration.resourceTypes, eventType);
      } catch (error) {
        context.addIssue({
          code: "custom",
          message: (error as Error).message,
          path: ["resourceTypes"],
        });
      }
    }
    const anyResourceEvents = Object.entries(
      registration.anyResourceEvents ?? {},
    );
    if (anyResourceEvents.length === 0) return;
    let fields: EventMatchFields;
    try {
      fields = anyResourceMatchFields(registration.resourceTypes);
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: (error as Error).message,
        path: ["anyResourceEvents"],
      });
      return;
    }
    for (const [eventType, scope] of anyResourceEvents) {
      if (!supported.has(eventType)) {
        context.addIssue({
          code: "custom",
          message: `Any-resource event type "${eventType}" is not supported.`,
          path: ["anyResourceEvents", eventType],
        });
      }
      const filter = scope.requiredFilter;
      if (filter === undefined) continue;
      if (!fields[filter]?.events?.includes(eventType)) {
        context.addIssue({
          code: "custom",
          message: `Required filter "${filter}" is not set on "${eventType}".`,
          path: ["anyResourceEvents", eventType, "requiredFilter"],
        });
      }
    }
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

/**
 * One person involved in an Event, named by a provider identity or an email.
 * Core resolves linked people to mentions. It drops people it cannot resolve.
 */
export const eventPersonSchema = z.union([
  z
    .object({
      provider: z.string().min(1),
      handle: z.string().min(1),
    })
    .strict(),
  z.object({ email: z.string().trim().min(3) }).strict(),
]);

export type EventPerson = z.output<typeof eventPersonSchema>;

export const eventInputSchema = z
  .object({
    objectType: objectTypeSchema.optional(),
    eventKey: z.string().min(1),
    eventType: eventTypeSchema,
    identifier: z.string().min(1),
    occurredAtMs: z.number().finite(),
    /**
     * The Watch that gets this Event completes after delivery. Set it only on
     * the Event for the exact resource. Never set it on copies for broader
     * resources, such as a repository, because those Watches must stay active.
     */
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
    /** People involved in the change. Watch Events list them as mentions. */
    people: z.array(eventPersonSchema).max(20).optional(),
    /**
     * The person who did what the Event describes, such as a reviewer or a
     * commenter. Core resolves them like `people`, so the agent knows when a
     * mention and a provider name are the same person.
     */
    doneBy: eventPersonSchema.optional(),
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
   * identifiers and event types, and by event automations with no
   * identifier. Plugins use this to load optional trusted data only when a
   * filter needs it.
   */
  neededMatchKeys?(input: {
    eventTypes: string[];
    identifiers: string[];
  }): Promise<string[]>;
}
