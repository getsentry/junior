import { getPlugins } from "@/chat/plugins/agent-hooks";
import { CORE_EVENT_NAMESPACE, type EventCatalog } from "@/chat/events/catalog";
import { workspaceSnapshotEvents } from "@/chat/sandbox/snapshot/events";

/**
 * Enabled event registrations for search, guidance, and tool schemas.
 *
 * Includes core Workspace snapshot events under the `junior` namespace, plus
 * every enabled plugin registration. Plugins may not use the `junior` namespace.
 */
export function getEventCatalog(): EventCatalog {
  const catalog: Record<string, EventCatalog[string]> = {
    [CORE_EVENT_NAMESPACE]: workspaceSnapshotEvents(),
  };
  for (const plugin of getPlugins()) {
    const registration = plugin.events;
    if (!registration || registration.isEnabled?.() === false) {
      continue;
    }
    if (plugin.manifest.name === CORE_EVENT_NAMESPACE) {
      throw new Error(
        `Plugin "${CORE_EVENT_NAMESPACE}" cannot register events; that namespace is reserved for core Workspace snapshots`,
      );
    }
    catalog[plugin.manifest.name] = registration;
  }
  return catalog;
}
