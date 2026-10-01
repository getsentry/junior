import { runSnapshotCreate } from "@/cli/snapshot-create";
import { pluginCatalogRuntime } from "@/chat/plugins/catalog-runtime";
import {
  defineJuniorPlugins,
  pluginCatalogConfigFromPluginSet,
} from "@/plugins";
import { evalRuntimePlugins } from "./eval-plugin-fixtures";

/** Warm one plugin dependency profile and restore the eval catalog afterward. */
export async function warmSandboxSnapshot(
  pluginPackages: readonly string[] = [],
): Promise<void> {
  const previousCatalogConfig = pluginCatalogRuntime.setConfig(
    pluginCatalogConfigFromPluginSet(
      defineJuniorPlugins([
        ...pluginPackages,
        ...evalRuntimePlugins(pluginPackages),
      ]),
    ),
  );
  try {
    await runSnapshotCreate();
  } finally {
    pluginCatalogRuntime.setConfig(previousCatalogConfig);
  }
}
