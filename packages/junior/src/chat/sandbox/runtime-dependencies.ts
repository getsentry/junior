import type { PluginRuntimeDependency } from "@/chat/plugins/types";
import { pluginCatalogRuntime } from "@/chat/plugins/catalog-runtime";
import {
  compareRuntimeDependencies,
  runtimeDependencyKey,
} from "@/chat/plugins/runtime-dependencies";

const SANDBOX_BASELINE_RUNTIME_DEPENDENCIES: PluginRuntimeDependency[] = [
  { type: "system", package: "docker" },
];

/** Return core sandbox packages plus plugin-declared runtime dependencies. */
export function getSandboxRuntimeDependencies(): PluginRuntimeDependency[] {
  const seen = new Set<string>();
  const dependencies: PluginRuntimeDependency[] = [];

  for (const dep of [
    ...SANDBOX_BASELINE_RUNTIME_DEPENDENCIES,
    ...pluginCatalogRuntime.getRuntimeDependencies(),
  ]) {
    const key = runtimeDependencyKey(dep);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    dependencies.push(dep);
  }

  return dependencies.sort(compareRuntimeDependencies);
}
