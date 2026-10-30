import {
  anyResourceMatchFields,
  describeEventTrigger,
  eventTriggerChoices,
  eventTriggerProblems,
  normalizeEventIdentifier,
  normalizeEventMatch,
  eventMatchSchema,
  type EventMatchFields,
  type EventTriggerDescription,
  type EventTriggerProblem,
  type EventTriggerSelection,
  type EventTriggerSource,
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

/** One source as a plugin or core registers it, before the catalog adds merged filters. */
export type EventRegistrationInput = Pick<
  PluginEvents,
  "events" | "resourceTypes" | "normalizeIdentifier"
> & {
  /** Name people see for the source, such as GitHub. Defaults to the namespace. */
  displayName?: string;
  /** Core-only limits, by resource type. */
  limits?: Readonly<Record<string, EventResourceTypeLimits>>;
};

type EventRegistration = EventRegistrationInput & {
  /** The filters of every resource type, merged once when the catalog is built. */
  anyResourceFields: EventMatchFields;
};

export type EventCatalog = Readonly<Record<string, EventRegistration>>;

/** A source with nothing enabled, for a namespace that the catalog lacks. */
const NO_SOURCE: EventTriggerSource = {
  resourceTypes: [],
  events: {},
  anyResourceFields: {},
};

/**
 * Build one catalog entry. It merges the filters of every resource type here,
 * once, so trigger checks for each event copy and each row do not merge them
 * again.
 */
export function eventCatalogEntry(
  registration: EventRegistrationInput,
): EventRegistration {
  return {
    ...registration,
    anyResourceFields: anyResourceMatchFields(registration.resourceTypes),
  };
}

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
      if (resourceTypes.length === 0) return [];
      if (resourceTypes.length === registration.resourceTypes.length) {
        return [[namespace, registration]];
      }
      const supported = new Set(
        resourceTypes.flatMap((resourceType) => resourceType.supportedEvents),
      );
      return [
        [
          namespace,
          eventCatalogEntry({
            ...registration,
            resourceTypes,
            events: Object.fromEntries(
              Object.entries(registration.events).filter(([eventType]) =>
                supported.has(eventType),
              ),
            ),
          }),
        ],
      ];
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

/**
 * Return app guidance for one event of a namespace. The source declares it
 * once for the event, so every resource type and a trigger with no resource
 * type get the same guidance.
 */
export function eventGuidance(
  catalog: EventCatalog,
  namespace: string,
  eventType: string,
): string | undefined {
  return catalog[namespace]?.events[eventType]?.guidance;
}

/** Build the match object the tools accept for one resource type. */
export function registeredEventMatchSchema() {
  return eventMatchSchema
    .optional()
    .describe(
      "Optional filters: exact values for the resource type matchFields. A single value must equal the event data. A list means the event value may be any one entry. For a field with list: true, the event value is a list, and it matches when it includes the value or any entry. A field with events is set only on those events, so every selected event must be in that list. Omit a key to ignore it. Unmatched events are dropped with no agent turn.",
    );
}

/** One selection of events and filters, with the source that owns it. */
type RegisteredEventSelection = EventTriggerSelection & {
  namespace: string;
};

/**
 * List why a selection cannot work with the enabled plugins. Use it for new
 * selections and for saved triggers, which can go stale after a plugin renames
 * or removes a resource type, event, or filter.
 */
export function registeredEventTriggerProblems(
  catalog: EventCatalog,
  selection: RegisteredEventSelection,
  options?: { inputKeys?: boolean },
): EventTriggerProblem[] {
  return eventTriggerProblems(
    catalog[selection.namespace] ?? NO_SOURCE,
    selection,
    options,
  );
}

/**
 * Describe a selection with the enabled plugins, for the dashboard and Slack.
 * Its problems are the same as `registeredEventTriggerProblems`.
 */
export function describeRegisteredEventTrigger(
  catalog: EventCatalog,
  selection: RegisteredEventSelection,
): EventTriggerDescription {
  return describeEventTrigger(
    catalog[selection.namespace] ?? NO_SOURCE,
    selection,
  );
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
 * Reject an event automation trigger or a Watch that cannot work, with every
 * problem in one message for the agent. Return its match as it is saved:
 * each text value in the case that its plugin declares, with no repeated
 * list values.
 */
export function requireValidEventTrigger(
  catalog: EventCatalog,
  selection: RegisteredEventSelection,
  target: "event_automation" | "watch",
): EventMatch | undefined {
  const fields =
    eventTriggerChoices(catalog[selection.namespace] ?? NO_SOURCE, selection)
      ?.fields ?? {};
  const normalized = {
    ...selection,
    match: normalizeEventMatch(fields, selection.match),
  };
  const problems = registeredEventTriggerProblems(catalog, normalized, {
    inputKeys: true,
  });
  if (problems.length > 0) {
    const source =
      catalog[selection.namespace]?.displayName ?? selection.namespace;
    const resource = selection.resourceType
      ? `${source} ${selection.resourceType.replaceAll("_", " ")}`
      : source;
    throw new ToolInputError(
      [
        target === "watch"
          ? `This ${resource} watch cannot be created.`
          : `This ${resource} trigger cannot be saved.`,
        ...problems.map((problem) => problem.message),
      ].join(" "),
    );
  }
  return uniqueMatchValues(normalized.match);
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
