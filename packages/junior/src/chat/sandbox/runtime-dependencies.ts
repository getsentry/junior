import type { PluginRuntimeDependency } from "@/chat/plugins/types";
import { pluginCatalogRuntime } from "@/chat/plugins/catalog-runtime";

const SANDBOX_BASELINE_RUNTIME_DEPENDENCIES: PluginRuntimeDependency[] = [
  { type: "system", package: "docker" },
];

function dependencyKey(dep: PluginRuntimeDependency): string {
  if (dep.type === "npm") {
    return `${dep.type}:${dep.package}:${dep.version}`;
  }
  if ("package" in dep) {
    return `${dep.type}:package:${dep.package}`;
  }
  return `${dep.type}:url:${dep.url}:${dep.sha256}`;
}

/** Return core sandbox packages plus plugin-declared runtime dependencies. */
export function getSandboxRuntimeDependencies(): PluginRuntimeDependency[] {
  const seen = new Set<string>();
  const dependencies: PluginRuntimeDependency[] = [];

  for (const dep of [
    ...SANDBOX_BASELINE_RUNTIME_DEPENDENCIES,
    ...pluginCatalogRuntime.getRuntimeDependencies(),
  ]) {
    const key = dependencyKey(dep);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    dependencies.push(dep);
  }

  return dependencies.sort((left, right) =>
    dependencyKey(left).localeCompare(dependencyKey(right)),
  );
}
