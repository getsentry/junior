import { runSnapshotCreate } from "@/cli/snapshot-create";
import { pluginCatalogRuntime } from "@/chat/plugins/catalog-runtime";

/** Warm one plugin dependency profile and restore the eval catalog afterward. */
export async function warmSandboxSnapshot(
  pluginPackages: readonly string[] = [],
): Promise<void> {
  const previousCatalogConfig = pluginCatalogRuntime.setConfig({
    packages: [...pluginPackages],
  });
  try {
    await runSnapshotCreate();
  } finally {
    pluginCatalogRuntime.setConfig(previousCatalogConfig);
  }
}
