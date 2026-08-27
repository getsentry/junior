import { getPlugins } from "@/chat/plugins/agent-hooks";
import type { ResourceEventCatalog } from "@/chat/resource-events/catalog";
import {
  WORKSPACE_SNAPSHOT_NAMESPACE,
  workspaceSnapshotResourceEvents,
} from "@/chat/sandbox/snapshot/events";

/**
 * Enabled resource-event registrations for search, guidance, and tool schemas.
 *
 * Plugin namespaces come from loaded plugins. Core also registers Workspace
 * snapshot ready/failed under the `junior` namespace so forced switch watches
 * are first-class catalog members, not a private bypass.
 */
export function getResourceEventCatalog(): ResourceEventCatalog {
  const catalog: Record<string, ResourceEventCatalog[string]> = {
    [WORKSPACE_SNAPSHOT_NAMESPACE]: workspaceSnapshotResourceEvents(),
  };
  for (const plugin of getPlugins()) {
    const registration = plugin.resourceEvents;
    if (!registration || registration.isEnabled?.() === false) {
      continue;
    }
    if (plugin.manifest.name === WORKSPACE_SNAPSHOT_NAMESPACE) {
      throw new Error(
        `Plugin "${WORKSPACE_SNAPSHOT_NAMESPACE}" cannot own resource events; that namespace is reserved for core Workspace snapshots`,
      );
    }
    catalog[plugin.manifest.name] = registration;
  }
  return catalog;
}
