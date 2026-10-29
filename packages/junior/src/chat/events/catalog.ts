import {
  eventTriggerProblems,
  normalizeEventIdentifier,
  eventMatchSchema,
  type EventTriggerProblem,
  type PluginEvents,
  type EventMatch,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

/**
 * How core limits one of its own resource types. Limits sit beside the
 * plugin-api resource type, not on it, so plugins cannot set them and API
 * responses never carry them.
 */
export type EventResourceTypeLimits = {
  /** False when event automations cannot use the resource type. */
  automation?: false;
} & (
  | { watch?: undefined }
  | {
      /** False when watchEvents cannot watch the resource type. */
      watch: false;
      /** Tells the agent what to use instead of watchEvents. */
      watchUnavailableMessage: string;
    }
);

type EventRegistration = Pick<
  PluginEvents,
  "resourceTypes" | "normalizeIdentifier"
> & {
  /** Core-only limits, by resource type. */
  limits?: Readonly<Record<string, EventResourceTypeLimits>>;
};

export type EventCatalog = Readonly<Record<string, EventRegistration>>;

/** Core-owned event namespace. Not a plugin publisher. */
export const CORE_EVENT_NAMESPACE = "junior";

/** True when the catalog has any enabled registration. */
export function hasEventCatalogEntries(catalog: EventCatalog): boolean {
  return Object.keys(catalog).length > 0;
}

/**
 * Catalog entries that durable event automations may select.
 *
 * Resource types with `automation: false` stay out of create/update schemas
 * and trigger availability. A namespace with no such resource type left is
 * removed.
 */
export function automationEventCatalog(catalog: EventCatalog): EventCatalog {
  return Object.fromEntries(
    Object.entries(catalog).flatMap(([namespace, registration]) => {
      const resourceTypes = registration.resourceTypes.filter(
        (resourceType) =>
          registration.limits?.[resourceType.type]?.automation !== false,
      );
      return resourceTypes.length > 0
        ? [[namespace, { ...registration, resourceTypes }]]
        : [];
    }),
  );
}

/** Return why watchEvents cannot watch one resource type, if it cannot. */
export function eventWatchUnavailable(
  catalog: EventCatalog,
  namespace: string,
  resourceType: string,
): string | undefined {
  const limits = catalog[namespace]?.limits?.[resourceType];
  return limits?.watch === false ? limits.watchUnavailableMessage : undefined;
}

function enumSchema(values: string[], unavailableMessage: string) {
  if (values.length === 0) {
    return z.string().refine(() => false, unavailableMessage);
  }
  return z.enum(values as [string, ...string[]]);
}

/** Build the model-facing namespace enum from enabled event plugins. */
export function eventNamespaceSchema(catalog: EventCatalog) {
  return enumSchema(
    Object.keys(catalog).sort(),
    "No event namespaces are enabled.",
  );
}

/** Build the model-facing event enum from enabled plugin registrations. */
export function registeredEventTypeSchema(catalog: EventCatalog) {
  return enumSchema(
    [
      ...new Set(
        Object.values(catalog).flatMap((registration) =>
          registration.resourceTypes.flatMap(
            (resourceType) => resourceType.supportedEvents,
          ),
        ),
      ),
    ].sort(),
    "No event types are enabled.",
  );
}

/** Build the model-facing resource type enum from enabled plugin registrations. */
export function registeredResourceTypeSchema(catalog: EventCatalog) {
  return enumSchema(
    [
      ...new Set(
        Object.values(catalog).flatMap((registration) =>
          registration.resourceTypes.map((resourceType) => resourceType.type),
        ),
      ),
    ].sort(),
    "No resource types are enabled.",
  );
}

/** Return app guidance for one registered resource type and event type. */
export function eventGuidance(
  catalog: EventCatalog,
  namespace: string,
  resourceType: string,
  eventType: string,
): string | undefined {
  return catalog[namespace]?.resourceTypes.find(
    (candidate) => candidate.type === resourceType,
  )?.guidance?.[eventType];
}

/** Build the match object the tools accept for one resource type. */
export function registeredEventMatchSchema() {
  return eventMatchSchema
    .optional()
    .describe(
      "Optional exact values from the resource type matchFields. A single value must equal the event data. A list means the event value may be any one entry. For a field with list: true, the event value is a list, and it matches when it includes the value or any entry. A field with events is set only on those events, so every selected event must be in that list. Omit a key to ignore it. Unmatched events are dropped with no agent turn.",
    );
}

/** The parts of an Event trigger that the catalog checks. */
export interface EventTriggerSelection {
  events: readonly string[];
  match?: EventMatch;
  namespace: string;
  resourceType: string;
}

/**
 * List why a trigger cannot work with the enabled plugins. Use it for new
 * triggers and for saved triggers, which can go stale after a plugin renames
 * or removes an event or filter.
 */
export function registeredEventTriggerProblems(
  catalog: EventCatalog,
  trigger: EventTriggerSelection,
): EventTriggerProblem[] {
  const resourceType = catalog[trigger.namespace]?.resourceTypes.find(
    (candidate) => candidate.type === trigger.resourceType,
  );
  if (!resourceType) {
    return [
      {
        reason: "unknown_resource_type",
        message: `There is no enabled "${trigger.resourceType}" resource type for "${trigger.namespace}".`,
      },
    ];
  }
  return eventTriggerProblems(resourceType, trigger);
}

function uniqueMatchValues(match: EventMatch | undefined) {
  if (!match || Object.keys(match).length === 0) return undefined;
  return Object.fromEntries(
    Object.entries(match).map(([key, value]) => [
      key,
      Array.isArray(value) ? [...new Set(value)] : value,
    ]),
  ) as EventMatch;
}

/**
 * Reject a trigger that cannot work, with every problem in one message.
 * Return its match without repeated list values.
 */
export function requireValidEventTrigger(
  catalog: EventCatalog,
  trigger: EventTriggerSelection,
): EventMatch | undefined {
  const problems = registeredEventTriggerProblems(catalog, trigger);
  if (problems.length > 0) {
    const resource = `${trigger.namespace} ${trigger.resourceType.replaceAll("_", " ")}`;
    throw new ToolInputError(
      [
        `This ${resource} trigger cannot be saved.`,
        ...problems.map((problem) => problem.message),
      ].join(" "),
    );
  }
  return uniqueMatchValues(trigger.match);
}

/**
 * Normalize one selector with the convention declared by its plugin.
 *
 * Reject a selector that does not fit its resource type. Resource types can
 * share event types, so only the identifier shows which one a selector names.
 */
export function requireEventIdentifier(
  catalog: EventCatalog,
  input: { identifier: string; namespace: string; resourceType: string },
): string {
  const registration = catalog[input.namespace];
  const identifier = normalizeEventIdentifier(registration, input.identifier);
  const resourceTypes = registration?.resourceTypes ?? [];
  const fits = (resourceType: (typeof resourceTypes)[number]) =>
    resourceType.identifier !== undefined &&
    new RegExp(resourceType.identifier.pattern).test(identifier);
  const resourceType = resourceTypes.find(
    (candidate) => candidate.type === input.resourceType,
  );
  if (!resourceType?.identifier || fits(resourceType)) return identifier;
  const fitting = resourceTypes.filter(fits).map((candidate) => candidate.type);
  throw new ToolInputError(
    [
      `Identifier "${identifier}" does not fit resourceType "${input.resourceType}" in namespace "${input.namespace}". Expected format: "${resourceType.identifier.format}".`,
      ...(fitting.length > 0
        ? [
            `If the identifier is correct, use one of these resourceType values: ${fitting.map((type) => `"${type}"`).join(", ")}.`,
          ]
        : []),
    ].join(" "),
  );
}
