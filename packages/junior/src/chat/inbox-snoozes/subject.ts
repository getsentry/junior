import { normalizeEventIdentifier, type User } from "@sentry/junior-plugin-api";
import { viewerCanViewPluginLink } from "@/api/objects/resolve";
import {
  eventWatchUnavailable,
  type EventCatalog,
} from "@/chat/events/catalog";

/**
 * An Event resource that a snooze can wait on, such as the one a Review
 * item's subject names, and the Event types of its resource type.
 */
export interface SnoozeResource {
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
): SnoozeResource | undefined {
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

/**
 * Return the Event resource of a page that the viewer names, such as
 * another pull request. An item's subject is already in the viewer's
 * Inbox, but this page is not, so the plugin that owns its Events must let
 * the viewer see the page now, as it does for the page's card.
 */
export async function viewerSnoozeResource(
  viewer: User,
  catalog: EventCatalog,
  url: string,
): Promise<SnoozeResource | undefined> {
  const resource = snoozeSubjectResource(catalog, url);
  return resource &&
    URL.canParse(url) &&
    (await viewerCanViewPluginLink(viewer, new URL(url), resource.namespace))
    ? resource
    : undefined;
}
