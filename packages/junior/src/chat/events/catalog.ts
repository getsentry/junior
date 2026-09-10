import {
  normalizeEventIdentifier,
  eventMatchSchema,
  type PluginEvents,
  type EventMatch,
  type EventMatchFields,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

type EventRegistration = Pick<
  PluginEvents,
  "resourceTypes" | "normalizeIdentifier"
>;

export type EventCatalog = Readonly<Record<string, EventRegistration>>;

/** Core-owned event namespace. Not a plugin publisher. */
export const CORE_EVENT_NAMESPACE = "junior";

/** True when the catalog has any enabled registration. */
export function hasEventCatalogEntries(catalog: EventCatalog): boolean {
  return Object.keys(catalog).length > 0;
}

/**
 * True when at least one plugin namespace is enabled.
 *
 * Core Workspace snapshot events stay in the catalog for search and temporary
 * watches. Durable event automations still require a plugin publisher.
 */
export function hasPluginEventCatalogEntries(catalog: EventCatalog): boolean {
  return Object.keys(pluginEventCatalog(catalog)).length > 0;
}

/**
 * Catalog entries that durable event automations may select.
 *
 * Core Workspace snapshot events only wake temporary watches. Snapshot finish
 * does not run event-automation ingest, so those namespaces stay out of create/update
 * schemas and trigger availability.
 */
export function pluginEventCatalog(catalog: EventCatalog): EventCatalog {
  return Object.fromEntries(
    Object.entries(catalog).filter(
      ([namespace]) => namespace !== CORE_EVENT_NAMESPACE,
    ),
  );
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

/** Return whether one enabled plugin declared an event type. */
export function pluginSupportsEvent(
  catalog: EventCatalog,
  namespace: string,
  resourceType: string,
  eventType: string,
): boolean {
  return (
    catalog[namespace]?.resourceTypes
      .find((candidate) => candidate.type === resourceType)
      ?.supportedEvents.includes(eventType) ?? false
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

/** Return declared match keys for one registered resource type. */
export function eventMatchFields(
  catalog: EventCatalog,
  namespace: string,
  resourceType: string,
): EventMatchFields | undefined {
  return catalog[namespace]?.resourceTypes.find(
    (candidate) => candidate.type === resourceType,
  )?.matchFields;
}

/** Build the match object the tools accept for one resource type. */
export function registeredEventMatchSchema() {
  return eventMatchSchema
    .optional()
    .describe(
      "Optional exact values from the resource type matchFields. A single value must equal the event data. A list means the event value may be any one entry. Omit a key to ignore it. Unmatched events are dropped with no agent turn.",
    );
}

/** Reject match keys the resource type does not list. */
export function requireSupportedEventMatch(
  catalog: EventCatalog,
  input: {
    match?: EventMatch;
    namespace: string;
    resourceType: string;
  },
): EventMatch | undefined {
  const match = input.match;
  if (!match || Object.keys(match).length === 0) return undefined;
  const fields = eventMatchFields(catalog, input.namespace, input.resourceType);
  if (!fields || Object.keys(fields).length === 0) {
    throw new ToolInputError(
      `Resource type "${input.namespace}:${input.resourceType}" does not support match.`,
    );
  }
  const normalized: EventMatch = {};
  for (const [key, value] of Object.entries(match)) {
    const field = fields[key];
    if (!field) {
      throw new ToolInputError(
        `Resource type "${input.namespace}:${input.resourceType}" does not support match key "${key}".`,
      );
    }
    if (Array.isArray(value)) {
      if (field.kind === "boolean") {
        throw new ToolInputError(
          `Match key "${key}" is boolean and cannot use a list.`,
        );
      }
      for (const entry of value) {
        if (typeof entry !== field.kind) {
          throw new ToolInputError(
            `Match key "${key}" expects ${field.kind} values.`,
          );
        }
        if (
          field.enum &&
          typeof entry === "string" &&
          !field.enum.includes(entry)
        ) {
          throw new ToolInputError(
            `Match key "${key}" does not allow value "${entry}".`,
          );
        }
      }
      normalized[key] = [...new Set(value)] as typeof value;
      continue;
    }
    if (typeof value !== field.kind) {
      throw new ToolInputError(
        `Match key "${key}" expects a ${field.kind} value.`,
      );
    }
    if (
      field.enum &&
      typeof value === "string" &&
      !field.enum.includes(value)
    ) {
      throw new ToolInputError(
        `Match key "${key}" does not allow value "${value}".`,
      );
    }
    normalized[key] = value;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

/** Normalize one selector with the convention declared by its plugin. */
export function normalizeCatalogEventIdentifier(
  catalog: EventCatalog,
  namespace: string,
  identifier: string,
): string {
  return normalizeEventIdentifier(catalog[namespace], identifier);
}
