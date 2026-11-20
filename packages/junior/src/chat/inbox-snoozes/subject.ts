import { normalizeEventIdentifier } from "@sentry/junior-plugin-api";
import {
  eventWatchUnavailable,
  type EventCatalog,
} from "@/chat/events/catalog";

/**
 * The Event resource that a Review item's subject names, and the Event
 * types of its resource type: the Events that can wake or resolve a snooze
 * of the item.
 */
interface SnoozeSubjectResource {
  events: readonly string[];
  identifier: string;
  namespace: string;
  resourceType: string;
}

/**
 * Return the Event resource that a subject URL names, such as the pull
 * request of a GitHub link. The plugin that owns the source reads the URL,
 * so core keeps no provider URL rules. A snooze waits on the resource's
 * Events as a Watch does, so a resource type that cannot be watched has
 * none.
 */
export function snoozeSubjectResource(
  catalog: EventCatalog,
  url: string,
): SnoozeSubjectResource | undefined {
  for (const [namespace, registration] of Object.entries(catalog)) {
    const found = registration.resourceForUrl?.(url);
    if (!found) continue;
    const resourceType = registration.resourceTypes.find(
      (candidate) => candidate.type === found.resourceType,
    );
    if (
      !resourceType ||
      eventWatchUnavailable(catalog, namespace, resourceType.type)
    ) {
      return undefined;
    }
    return {
      events: resourceType.supportedEvents,
      identifier: normalizeEventIdentifier(registration, found.identifier),
      namespace,
      resourceType: resourceType.type,
    };
  }
  return undefined;
}
