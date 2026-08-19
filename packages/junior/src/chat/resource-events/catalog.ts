import {
  normalizeResourceEventIdentifier,
  type PluginResourceEvents,
} from "@sentry/junior-plugin-api";
import { z } from "zod";

type ResourceEventRegistration = Pick<
  PluginResourceEvents,
  "resourceTypes" | "normalizeIdentifier"
>;

export type ResourceEventCatalog = Readonly<
  Record<string, ResourceEventRegistration>
>;

function enumSchema(values: string[], unavailableMessage: string) {
  if (values.length === 0) {
    return z.string().refine(() => false, unavailableMessage);
  }
  return z.enum(values as [string, ...string[]]);
}

/** Build the model-facing namespace enum from enabled resource event plugins. */
export function eventNamespaceSchema(catalog: ResourceEventCatalog) {
  return enumSchema(
    Object.keys(catalog).sort(),
    "No resource event namespaces are enabled.",
  );
}

/** Build the model-facing event enum from enabled plugin registrations. */
export function registeredEventTypeSchema(catalog: ResourceEventCatalog) {
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
    "No resource event types are enabled.",
  );
}

/** Build the model-facing resource type enum from enabled plugin registrations. */
export function registeredResourceTypeSchema(catalog: ResourceEventCatalog) {
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
  catalog: ResourceEventCatalog,
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

/** Return install guidance for one registered resource event type. */
export function resourceEventGuidance(
  catalog: ResourceEventCatalog,
  namespace: string,
  eventType: string,
): string | undefined {
  return catalog[namespace]?.resourceTypes.find((resourceType) =>
    resourceType.supportedEvents.includes(eventType),
  )?.guidance?.[eventType];
}

/** Normalize one selector with the convention declared by its plugin. */
export function normalizeEventIdentifier(
  catalog: ResourceEventCatalog,
  namespace: string,
  identifier: string,
): string {
  return normalizeResourceEventIdentifier(catalog[namespace], identifier);
}
