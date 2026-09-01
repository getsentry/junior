import { getPlugins } from "@/chat/plugins/agent-hooks";
import {
  CORE_RESOURCE_EVENT_NAMESPACE,
  type ResourceEventCatalog,
} from "@/chat/resource-events/catalog";
import { workspaceSnapshotResourceEvents } from "@/chat/sandbox/snapshot/events";

/**
 * Enabled resource-event registrations for search, guidance, and tool schemas.
 *
 * Includes core Workspace snapshot events under the `junior` namespace, plus
 * every enabled plugin registration. Plugins may not use the `junior` namespace.
 */
export function getResourceEventCatalog(): ResourceEventCatalog {
  const catalog: Record<string, ResourceEventCatalog[string]> = {
    [CORE_RESOURCE_EVENT_NAMESPACE]: workspaceSnapshotResourceEvents(),
  };
  for (const plugin of getPlugins()) {
    const registration = plugin.resourceEvents;
    if (!registration || registration.isEnabled?.() === false) {
      continue;
    }
    if (plugin.manifest.name === CORE_RESOURCE_EVENT_NAMESPACE) {
      throw new Error(
        `Plugin "${CORE_RESOURCE_EVENT_NAMESPACE}" cannot register resource events; that namespace is reserved for core Workspace snapshots`,
      );
    }
    catalog[plugin.manifest.name] = registration;
  }
  return catalog;
}
