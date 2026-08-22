import { getPlugins } from "@/chat/plugins/agent-hooks";
import type { ResourceEventCatalog } from "@/chat/resource-events/catalog";
import { canRouteResourceEvents } from "@/chat/resource-events/workspace";

/** Read enabled plugin resource-event registrations as one core catalog. */
export function getResourceEventCatalog(): ResourceEventCatalog {
  if (!canRouteResourceEvents()) return {};
  return Object.fromEntries(
    getPlugins().flatMap((plugin) => {
      const registration = plugin.resourceEvents;
      if (!registration || registration.isEnabled?.() === false) {
        return [];
      }
      return [[plugin.manifest.name, registration]];
    }),
  );
}
