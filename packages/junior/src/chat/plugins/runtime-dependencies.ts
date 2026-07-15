import type { PluginRuntimeDependency } from "@/chat/plugins/types";

/** Stable identity used to deduplicate and order sandbox runtime dependencies. */
export function runtimeDependencyKey(dep: PluginRuntimeDependency): string {
  if (dep.type === "npm") {
    return `${dep.type}:${dep.package}:${dep.version}`;
  }
  if ("package" in dep) {
    return `${dep.type}:package:${dep.package}`;
  }
  return `${dep.type}:url:${dep.url}:${dep.sha256}`;
}

export function compareRuntimeDependencies(
  left: PluginRuntimeDependency,
  right: PluginRuntimeDependency,
): number {
  return runtimeDependencyKey(left).localeCompare(runtimeDependencyKey(right));
}
