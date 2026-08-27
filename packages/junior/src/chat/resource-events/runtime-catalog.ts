import { getPlugins } from "@/chat/plugins/agent-hooks";
import type { ResourceEventCatalog } from "@/chat/resource-events/catalog";
import {
  WORKSPACE_SNAPSHOT_NAMESPACE,
  workspaceSnapshotResourceEvents,
} from "@/chat/sandbox/snapshot/events";

/**
 * Enabled resource-event registrations for search, guidance, and tool schemas.
 *
 * Includes core Workspace snapshot events under the `junior` namespace, plus
 * every enabled plugin registration. Plugins may not use the `junior` namespace.
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
        `Plugin "${WORKSPACE_SNAPSHOT_NAMESPACE}" cannot register resource events; that namespace is reserved for core Workspace snapshots`,
      );
    }
    catalog[plugin.manifest.name] = registration;
  }
  return catalog;
}
